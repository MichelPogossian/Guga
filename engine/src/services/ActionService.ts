/**
 * Plan d'action (§4, §7, C2–C4) : seul composant à détenir le MailboxWriter.
 * Chaque appel exige un jeton d'intention consommé par la route et est journalisé.
 */
import type { Database } from "better-sqlite3";
import type { MailboxWriter } from "../connectors/MailboxConnector.js";
import type { ActionResult, Draft, Mailbox } from "../domain.js";
import type { AuditService } from "./AuditService.js";
import type { EventBus } from "./EventBus.js";
import type { Repository } from "./Repository.js";

export type OutlookAction =
  | { op: "soft_delete"; messageIds: string[] }
  | { op: "move"; messageIds: string[]; folderExtId: string }
  | { op: "set_categories"; messageIds: string[]; categories: string[] }
  | { op: "mark_read"; messageIds: string[]; read: boolean }
  | { op: "forward"; messageIds: string[]; to: string[]; comment?: string }
  | { op: "create_draft"; messageIds: string[]; draft: Draft }
  | { op: "send_draft"; messageIds: string[]; draftExtId: string }
  | { op: "undo_move"; messageIds: string[] };

export interface ActionOutcome { messageId: string; ok: boolean; detail?: string }

export class ActionService {
  constructor(private db: Database, private repo: Repository, private writer: MailboxWriter, private audit: AuditService, private bus: EventBus, private accountingAddress: string) {}

  private mailboxOf(messageId: string): { mb: Mailbox; extId: string; column: string | null; allowsDelete: boolean } {
    const m = this.repo.messageRaw(messageId);
    if (!m) throw new Error(`message inconnu ${messageId}`);
    const mb = this.repo.getMailbox(m.mailbox_id);
    if (!mb) throw new Error("boîte inconnue");
    const p = this.db.prepare(`SELECT p.column_code, c.allows_delete FROM placement p JOIN column_def c ON c.code=p.column_code WHERE p.message_id=?`).get(messageId) as any;
    return { mb, extId: m.ext_id, column: p?.column_code ?? null, allowsDelete: !!p?.allows_delete };
  }

  async execute(action: OutlookAction, actor = "user"): Promise<ActionOutcome[]> {
    const out: ActionOutcome[] = [];
    for (const id of action.messageIds) {
      let res: ActionResult = { ok: false };
      let detail = "";
      try {
        const { mb, extId, column, allowsDelete } = this.mailboxOf(id);
        switch (action.op) {
          case "soft_delete": {
            if (!allowsDelete) throw new Error(`la colonne ${column} n'autorise pas la suppression`);
            if (column === "CC") {
              const link = this.db.prepare(`SELECT MAX(validated_by_user) AS v, MAX(confidence) AS c FROM case_link WHERE message_id=?`).get(id) as any;
              if (!(link?.v === 1 || (link?.c ?? 0) >= 0.85)) throw new Error("suppression refusée : rattachement au dossier non validé (§7.2)");
            }
            res = await this.writer.softDelete(mb, extId);
            if (res.ok) {
              this.db.prepare(`UPDATE message SET is_deleted_remote=1, folder_ext_id='deleteditems' WHERE id=?`).run(id);
              this.db.prepare(`UPDATE placement SET processed=1, updated_at=? WHERE message_id=?`).run(new Date().toISOString(), id);
            }
            break;
          }
          case "move": {
            const before = this.repo.messageRaw(id)?.folder_ext_id ?? null;
            res = await this.writer.move(mb, extId, action.folderExtId);
            if (res.ok) {
              this.db.prepare(`UPDATE message SET folder_ext_id=? WHERE id=?`).run(action.folderExtId, id);
              res.undo = { folderExtId: res.undo?.folderExtId ?? before, until: new Date(Date.now() + 30 * 86_400_000).toISOString() };
            }
            break;
          }
          case "undo_move": {
            const last = this.db.prepare(`SELECT payload_json FROM action_log WHERE target_id=? AND action IN ('outlook.move','outlook.soft_delete') AND result='ok' ORDER BY seq DESC LIMIT 1`).get(id) as any;
            const undo = last ? JSON.parse(last.payload_json).undo : null;
            if (!undo?.folderExtId) throw new Error("aucun déplacement à annuler");
            if (undo.until && Date.parse(undo.until) < Date.now()) throw new Error("délai d'annulation dépassé (30 jours)");
            res = await this.writer.move(mb, extId, undo.folderExtId);
            if (res.ok) this.db.prepare(`UPDATE message SET is_deleted_remote=0, folder_ext_id=? WHERE id=?`).run(undo.folderExtId, id);
            break;
          }
          case "set_categories": res = await this.writer.setCategories(mb, extId, action.categories); break;
          case "mark_read":
            res = await this.writer.markRead(mb, extId, action.read);
            if (res.ok) this.db.prepare(`UPDATE message SET is_read=? WHERE id=?`).run(action.read ? 1 : 0, id);
            break;
          case "forward": {
            res = await this.writer.forward(mb, extId, action.to, action.comment);
            if (res.ok && action.to.map((a) => a.toLowerCase()).includes(this.accountingAddress.toLowerCase())) {
              this.db.prepare(`UPDATE placement SET status='TRANSFERE_COMPTA', processed=1, updated_at=? WHERE message_id=? AND column_code='CLAIRE'`).run(new Date().toISOString(), id);
            }
            break;
          }
          case "create_draft": {
            const ref = await this.writer.createDraft(mb, { ...action.draft, replyToExtId: action.draft.replyToExtId ?? extId });
            res = { ok: true, detail: ref.extId };
            detail = ref.extId;
            break;
          }
          case "send_draft": res = await this.writer.sendDraft(mb, action.draftExtId); break;
        }
      } catch (e) {
        res = { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
      const { messageIds: _ids, ...payload } = action as OutlookAction & { messageIds: string[] };
      this.audit.record(actor, `outlook.${action.op}`, { kind: "message", id }, { ...payload, undo: res.undo ?? null, detail: res.detail ?? detail }, res.ok ? "ok" : `error: ${res.detail}`);
      this.bus.publish({ type: "action", action: action.op, targetId: id, result: res.ok ? "ok" : "error" });
      out.push({ messageId: id, ok: res.ok, detail: res.detail ?? detail });
    }
    return out;
  }
}
