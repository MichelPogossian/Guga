/**
 * Plan de lecture (§3.4, §4, §6) : synchronisation delta, normalisation, indexation FTS,
 * classification par lots avec priorité (récents d'abord, boîtes principale et CONTACT d'abord),
 * puis déclenchement des modules métier. Ce service ne détient aucune fonction d'écriture vers la messagerie (C2).
 */
import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import type { GugaConfig } from "../config.js";
import type { MailboxReader } from "../connectors/MailboxConnector.js";
import type { Mailbox } from "../domain.js";
import { normalizeMessage } from "../normalize/message.js";
import type { ClassificationPipeline } from "../classify/pipeline.js";
import type { PlacementService } from "./PlacementService.js";
import { defaultStatusFor } from "./PlacementService.js";
import type { Repository } from "./Repository.js";
import type { JobQueue } from "./JobQueue.js";
import type { EventBus } from "./EventBus.js";
import { logger } from "../logger.js";
import { detectProceduralAlerts, loadProcedureCatalog, storeAlerts, type ProcCatalog } from "../modules/procedure.js";
import { qualifyExpertise, storeExpertise } from "../modules/expertise.js";
import { extractParties, secibSheet, storeNewCase, verifyParties } from "../modules/newcase.js";
import { findCaseCandidates, linkDecision, storeCaseLink } from "../modules/caselink.js";
import { RibService } from "../modules/rib.js";
import type { ExternalAdapter } from "../adapters/ExternalAdapter.js";
import type { AuditService } from "./AuditService.js";

export class SyncService {
  private catalog: ProcCatalog;
  private rib: RibService;
  constructor(
    private db: Database, private cfg: GugaConfig, private reader: MailboxReader, private repo: Repository,
    private pipeline: ClassificationPipeline, private placements: PlacementService, private jobs: JobQueue,
    private bus: EventBus, private audit: AuditService, private adapters: ExternalAdapter[] = [],
  ) {
    this.catalog = loadProcedureCatalog();
    this.rib = new RibService(db, audit);
    jobs.register("sync.mailbox", async (j) => { await this.syncMailbox(j.payload.mailboxId as string); });
    jobs.register("classify.message", async (j) => { await this.classifyMessage(j.payload.messageId as string); });
    jobs.register("classify.llm", async (j) => { await this.enrichMessage(j.payload.messageId as string); });
    jobs.register("sync.all", async () => { await this.syncAll(); });
  }

  /** Enregistre les boîtes du connecteur (idempotent). */
  async registerMailboxes(): Promise<Mailbox[]> {
    const list = await this.reader.listMailboxes();
    for (const mb of list) this.repo.upsertMailbox(mb);
    return this.repo.listMailboxes();
  }

  /** Rattrapage / synchronisation périodique : boîtes principale et CONTACT d'abord. */
  async syncAll(): Promise<void> {
    const boxes = this.repo.listMailboxes().sort((a, b) => rank(a) - rank(b));
    for (const mb of boxes) await this.syncMailbox(mb.id);
  }

  async syncMailbox(mailboxId: string): Promise<{ upserted: number; deleted: number }> {
    const mb = this.repo.getMailbox(mailboxId);
    if (!mb) throw new Error(`boîte inconnue ${mailboxId}`);
    this.bus.publish({ type: "sync", mailbox: mb.label, status: "start" });
    let upserted = 0, deleted = 0;
    let token = (mb.deltaState.token as string | undefined) ?? undefined;
    try {
      let more = true;
      while (more) {
        const res = await this.reader.syncDelta(mb, token);
        const ingest = this.db.transaction(() => {
          for (const ch of res.changes) {
            if (ch.kind === "delete") { deleted += this.markDeleted(mb.id, ch.extId); continue; }
            const id = this.upsert(mb, ch.message);
            if (id) upserted++;
          }
        });
        ingest();
        token = res.nextToken;
        more = !!res.more;
        this.repo.saveDeltaState(mb.id, { ...mb.deltaState, token }, null);
      }
      this.bus.publish({ type: "sync", mailbox: mb.label, status: "done", detail: `${upserted} nouveaux, ${deleted} supprimés` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.repo.saveDeltaState(mb.id, mb.deltaState, msg);
      this.bus.publish({ type: "sync", mailbox: mb.label, status: "error", detail: msg });
      throw e;
    }
    this.bus.publish({ type: "backlog", remaining: this.jobs.pending("classify.message") });
    return { upserted, deleted };
  }

  private markDeleted(mailboxId: string, extId: string): number {
    const row = this.db.prepare(`SELECT id FROM message WHERE mailbox_id=? AND ext_id=?`).get(mailboxId, extId) as { id: string } | undefined;
    if (!row) return 0;
    // Droit d'effacement (§10.4) : index et cache supprimés ; le journal est conservé (sans contenu).
    this.db.prepare(`UPDATE message SET is_deleted_remote=1, body_text='', body_html=NULL WHERE id=?`).run(row.id);
    this.db.prepare(`DELETE FROM message_fts WHERE rowid=(SELECT rowid FROM message WHERE id=?)`).run(row.id);
    this.db.prepare(`DELETE FROM attachment WHERE message_id=?`).run(row.id);
    return 1;
  }

  /** Insère ou met à jour un message ; renvoie l'id interne si nouveau (à classer). */
  private upsert(mb: Mailbox, raw: import("../domain.js").Message): string | null {
    const n = normalizeMessage(raw);
    const existing = this.db.prepare(`SELECT id, body_hash FROM message WHERE mailbox_id=? AND ext_id=?`).get(mb.id, n.extId) as { id: string; body_hash: string } | undefined;
    const now = new Date().toISOString();
    if (existing) {
      this.db.prepare(`UPDATE message SET subject=?, folder_ext_id=?, is_read=?, is_deleted_remote=0 WHERE id=?`).run(n.subject, n.folderExtId, n.isRead ? 1 : 0, existing.id);
      return null;
    }
    // Déduplication inter-boîtes par internetMessageId (même e-mail reçu en copie sur deux boîtes reste deux lignes, mais on le note)
    const id = ulid();
    this.db.prepare(`INSERT INTO message(id,mailbox_id,ext_id,internet_message_id,conversation_id,from_addr,from_name,to_json,cc_json,reply_to,subject,received_at,body_text,body_html,body_hash,headers_json,links_json,has_attachments,attachment_names,folder_ext_id,is_read,is_deleted_remote,first_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`)
      .run(id, mb.id, n.extId, n.internetMessageId, n.conversationId, n.fromAddr, n.fromName, JSON.stringify(n.to), JSON.stringify(n.cc), n.replyTo, n.subject, n.receivedAt,
        n.bodyText, n.bodyHtml, n.bodyHash, JSON.stringify(n.headers), JSON.stringify(n.links), n.hasAttachments ? 1 : 0, n.attachmentNames, n.folderExtId, n.isRead ? 1 : 0, now);
    const rowid = (this.db.prepare(`SELECT rowid FROM message WHERE id=?`).get(id) as { rowid: number }).rowid;
    this.db.prepare(`INSERT INTO message_fts(rowid, subject, body_text, from_addr, attachment_names, case_label) VALUES (?,?,?,?,?,?)`)
      .run(rowid, n.subject, n.bodyText, `${n.fromName ?? ""} ${n.fromAddr}`, n.attachmentNames, "");
    for (const a of raw.attachments) {
      this.db.prepare(`INSERT INTO attachment(id,message_id,ext_id,name,mime,size) VALUES (?,?,?,?,?,?)`).run(ulid(), id, a.extId ?? null, a.name, a.mime ?? null, a.size ?? null);
    }
    // Placement provisoire immédiat (aucun message sans colonne) puis classification en tâche de fond.
    const provisional = mb.defaultColumn ?? (n.cc.some((a) => this.cfg.userAddresses.includes(a)) && !n.to.some((a) => this.cfg.userAddresses.includes(a)) ? "CC" : "CONTACT");
    this.db.prepare(`INSERT INTO placement(message_id,column_code,status,is_urgent,deadline_at,source,confidence,to_confirm,processed,evidence_json,updated_at) VALUES (?,?,?,0,NULL,'ai',0,1,0,'{"provisional":true}',?)`)
      .run(id, provisional, defaultStatusFor(this.db, provisional), now);
    // Priorité : récents d'abord (priorité 1..9 selon l'âge), boîte principale/CONTACT avant Claire.
    const ageDays = (Date.now() - Date.parse(n.receivedAt)) / 86_400_000;
    const priority = Math.min(9, 1 + Math.floor(ageDays / 3)) + (mb.defaultColumn === "CLAIRE" ? 1 : 0);
    this.jobs.enqueue("classify.message", { messageId: id }, { priority, dedupeKey: id });
    return id;
  }

  private loadNormalized(messageId: string) {
    const row = this.repo.messageRaw(messageId);
    if (!row || row.is_deleted_remote) return null;
    const mb = this.repo.getMailbox(row.mailbox_id)!;
    const n = normalizeMessage({
      extId: row.ext_id, internetMessageId: row.internet_message_id, conversationId: row.conversation_id,
      from: { address: row.from_addr, name: row.from_name }, to: JSON.parse(row.to_json).map((a: string) => ({ address: a })),
      cc: JSON.parse(row.cc_json).map((a: string) => ({ address: a })), replyTo: row.reply_to, subject: row.subject, receivedAt: row.received_at,
      bodyText: row.body_text, bodyHtml: row.body_html ?? undefined, headers: JSON.parse(row.headers_json),
      attachments: (this.db.prepare(`SELECT name, mime, size FROM attachment WHERE message_id=?`).all(messageId) as any[]).map((a) => ({ name: a.name, mime: a.mime, size: a.size })),
      folderExtId: row.folder_ext_id, isRead: !!row.is_read,
    });
    const ctx = { messageId, mailboxKind: mb.kind, mailboxAddress: mb.address, mailboxLabel: mb.label, mailboxDefaultColumn: mb.defaultColumn };
    return { n, mb, ctx };
  }

  /** Classification rapide d'un message (règles + similarité) + modules métier ; le LLM suit en tâche séparée. */
  async classifyMessage(messageId: string): Promise<void> {
    const loaded = this.loadNormalized(messageId);
    if (!loaded) return;
    const { n, mb, ctx } = loaded;
    const { decision, needLlm, facts } = await this.pipeline.classifyFast(n, ctx);
    await this.commitDecision(messageId, mb, n, decision, facts, "fast");
    if (needLlm) this.jobs.enqueue("classify.llm", { messageId }, { priority: 20, dedupeKey: `llm:${messageId}` });
    this.bus.publish({ type: "backlog", remaining: Math.max(0, this.jobs.pending("classify.message") - 1) });
  }

  /** Enrichissement LLM (job séparé, priorité basse) : peut re-classer si l'utilisatrice n'a pas validé. */
  async enrichMessage(messageId: string): Promise<void> {
    const loaded = this.loadNormalized(messageId);
    if (!loaded) return;
    const { n, mb, ctx } = loaded;
    const cur = this.db.prepare(`SELECT source, evidence_json, column_code, confidence, is_urgent, deadline_at, summary FROM placement WHERE message_id=?`).get(messageId) as any;
    if (!cur || cur.source === "user") return;
    const prior = { column: cur.column_code, confidence: cur.confidence, toConfirm: false, isUrgent: !!cur.is_urgent, deadlineAt: cur.deadline_at, summary: cur.summary, caseHint: null, evidence: JSON.parse(cur.evidence_json || "{}") } as any;
    if (!prior.evidence.stages) prior.evidence.stages = [];
    const decision = await this.pipeline.enrichWithLlm(n, ctx, prior);
    if (!decision) return;
    const facts = (decision.evidence as any).facts;
    await this.commitDecision(messageId, mb, n, decision, facts, "llm");
  }

  private async commitDecision(messageId: string, mb: Mailbox, n: ReturnType<typeof normalizeMessage>, decision: any, facts: any, stage: "fast" | "llm") {
    // Boîtes partagées : la colonne par défaut prime sauf détection métier forte.
    if (mb.defaultColumn && decision.column !== mb.defaultColumn && decision.confidence < 0.7) { decision.column = mb.defaultColumn; decision.toConfirm = true; }
    if (mb.defaultColumn === "CONTACT" && facts?.onlyRecipientAlert) (decision.evidence as any).onlyRecipientAlert = true;

    // Rattachement dossier (toutes colonnes ; statut RATTACHÉ/NON RATTACHÉ pour CC)
    const cands = findCaseCandidates(this.db, `${n.subject}\n${n.bodyForAi}`, facts?.caseRefs ?? [], decision.caseHint);
    const link = linkDecision(cands, this.cfg.thresholds.caseLink, this.cfg.thresholds.caseLinkGap);
    (decision.evidence as any).caseCandidates = cands;
    const status = decision.column === "CC" ? link.status : defaultStatusFor(this.db, decision.column);
    this.placements.applyDecision(messageId, decision, status);
    storeCaseLink(this.db, messageId, cands, link.linked);
    if (link.linked) {
      const rowid = (this.db.prepare(`SELECT rowid FROM message WHERE id=?`).get(messageId) as any).rowid;
      this.db.prepare(`INSERT INTO message_fts(message_fts, rowid, subject, body_text, from_addr, attachment_names, case_label) VALUES ('delete', ?, ?, ?, ?, ?, '')`)
        .run(rowid, n.subject, n.bodyText, `${n.fromName ?? ""} ${n.fromAddr}`, n.attachmentNames);
      this.db.prepare(`INSERT INTO message_fts(rowid, subject, body_text, from_addr, attachment_names, case_label) VALUES (?,?,?,?,?,?)`)
        .run(rowid, n.subject, n.bodyText, `${n.fromName ?? ""} ${n.fromAddr}`, n.attachmentNames, `${link.linked.secibRef} ${link.linked.label}`);
    }
    if (stage === "llm" || decision.evidence.llm) {
      this.db.prepare(`INSERT INTO ai_trace(id,message_id,stage,model,prompt_version,output_json,at) VALUES (?,?,?,?,?,?,?)`)
        .run(ulid(), messageId, "classify", this.pipeline.activeModel, "classify_v3", JSON.stringify(decision.evidence.llm ?? null), new Date().toISOString());
    }
    await this.runModules(messageId, decision.column, n, decision, link.linked?.caseId ?? null, facts);
  }

  private async runModules(messageId: string, column: string, n: ReturnType<typeof normalizeMessage>, decision: any, caseId: string | null, facts: any) {
    const text = `${n.subject}\n${n.bodyForAi}`;
    switch (column) {
      case "RIB": {
        const contacts = this.repo.listContacts();
        const lower = text.toLowerCase();
        const opponent = contacts.find((c) => c.role === "opponent" && (new RegExp(`\\b${c.name.split(/\s+/).pop()!.toLowerCase()}\\b`).test(lower) || c.emails.some((e) => lower.includes(e))));
        const adverse = /\b(adverse|confrère adverse|partie adverse|contradicteur)\b/i.test(text);
        const kind = opponent || adverse ? "opponent" : /\b(notaire|huissier|commissaire|banque|client|tiers)\b/i.test(text) ? "other" : facts?.senderIsFirm ? "internal" : null;
        const sender = contacts.find((c) => c.id === facts?.senderContactId);
        this.rib.ensure(messageId, { instructedBy: sender?.name ?? n.fromName ?? n.fromAddr, recipientKind: kind, recipientContact: opponent?.name ?? null, caseId });
        break;
      }
      case "PROCEDURE": {
        storeAlerts(this.db, messageId, detectProceduralAlerts(this.catalog, text, new Date(n.receivedAt)), caseId);
        break;
      }
      case "EXPERTISE": {
        const kind = qualifyExpertise(text);
        storeExpertise(this.db, messageId, kind, null);
        this.db.prepare(`UPDATE placement SET status=? WHERE message_id=?`).run(kind === "dates" || kind === "accedit" ? "A_QUALIFIER" : "A_QUALIFIER", messageId);
        break;
      }
      case "NOUVEAUX": {
        const parties = extractParties(n.bodyText);
        const { checks, verdict, discrepancies } = await verifyParties(parties, this.adapters.filter((a) => a.enabled && a.lookup));
        storeNewCase(this.db, messageId, { parties, sheet: secibSheet(parties, { court: decision.evidence?.llm?.entities?.court ?? null, subject: n.subject }) }, checks, verdict, discrepancies);
        this.db.prepare(`UPDATE placement SET status=? WHERE message_id=?`).run(verdict, messageId);
        break;
      }
      case "PIECES": {
        const links = n.links.filter((l) => l.secureShare);
        (decision.evidence as any).downloadLinks = links;
        this.db.prepare(`UPDATE placement SET evidence_json=? WHERE message_id=?`).run(JSON.stringify(decision.evidence), messageId);
        break;
      }
      default: break;
    }
  }
}

function rank(mb: Mailbox): number { return mb.kind === "primary" ? 0 : mb.defaultColumn === "CONTACT" ? 1 : 2; }
