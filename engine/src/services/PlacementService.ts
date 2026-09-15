/**
 * Placements : colonne active + métadonnées, historique, redirection manuelle atomique (§7.13),
 * apprentissage par corrections (§6.2). Ne touche jamais Outlook.
 */
import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import type { ColumnCode } from "../domain.js";
import type { Decision } from "../classify/types.js";
import type { AuditService } from "./AuditService.js";
import type { EventBus } from "./EventBus.js";
import { COLUMN_CODES } from "../domain.js";

export interface RedirectInput { column?: ColumnCode; isUrgent?: boolean; deadlineAt?: string | null; status?: string | null; processed?: boolean; caseId?: string | null; reason?: string }

export class PlacementService {
  constructor(private db: Database, private audit: AuditService, private bus: EventBus) {}

  /** Placement initial ou re-classement IA (ne remplace jamais un placement validé par l'utilisatrice). */
  applyDecision(messageId: string, d: Decision, defaultStatus: string | null): void {
    const existing = this.db.prepare(`SELECT column_code, source FROM placement WHERE message_id=?`).get(messageId) as { column_code: string; source: string } | undefined;
    if (existing?.source === "user") return;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO placement(message_id,column_code,status,is_urgent,deadline_at,source,confidence,to_confirm,case_id,processed,summary,evidence_json,updated_at)
        VALUES (@id,@col,@status,@urgent,@deadline,'ai',@conf,@toConfirm,NULL,0,@summary,@evidence,@now)
        ON CONFLICT(message_id) DO UPDATE SET column_code=excluded.column_code, status=CASE WHEN placement.column_code=excluded.column_code THEN COALESCE(placement.status, excluded.status) ELSE excluded.status END, is_urgent=excluded.is_urgent,
          deadline_at=excluded.deadline_at, confidence=excluded.confidence, to_confirm=excluded.to_confirm, summary=excluded.summary, evidence_json=excluded.evidence_json, updated_at=excluded.updated_at`)
        .run({ id: messageId, col: d.column, status: defaultStatus, urgent: d.isUrgent ? 1 : 0, deadline: d.deadlineAt, conf: d.confidence, toConfirm: d.toConfirm ? 1 : 0, summary: d.summary, evidence: JSON.stringify(d.evidence), now });
      if (!existing || existing.column_code !== d.column) {
        this.db.prepare(`INSERT INTO placement_history(id,message_id,from_column,to_column,from_status,to_status,actor,reason,at) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(ulid(), messageId, existing?.column_code ?? null, d.column, null, defaultStatus, "engine", `ia confiance ${d.confidence}`, now);
      }
    });
    tx();
    this.bus.publish({ type: "placement", messageId, column: d.column, isUrgent: d.isUrgent });
  }

  /** Redirection manuelle : colonne + urgent + échéance + statut en UNE transaction (§7.13). */
  redirect(messageId: string, input: RedirectInput, actor = "user"): void {
    if (input.column && !COLUMN_CODES.includes(input.column)) throw new Error(`colonne inconnue ${input.column}`);
    const cur = this.db.prepare(`SELECT * FROM placement WHERE message_id=?`).get(messageId) as any;
    if (!cur) throw new Error("placement introuvable");
    if (input.status && input.column === undefined) {
      const schema = JSON.parse((this.db.prepare(`SELECT status_schema FROM column_def WHERE code=?`).get(cur.column_code) as any).status_schema) as string[];
      if (schema.length && !schema.includes(input.status)) throw new Error(`statut ${input.status} invalide pour ${cur.column_code}`);
    }
    const now = new Date().toISOString();
    const newCol = input.column ?? cur.column_code;
    const columnChanged = newCol !== cur.column_code;
    const newStatus = input.status !== undefined ? input.status : columnChanged ? defaultStatusFor(this.db, newCol) : cur.status;
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE placement SET column_code=?, status=?, is_urgent=?, deadline_at=?, processed=?, case_id=?, source=?, to_confirm=0, confidence=CASE WHEN ?=1 THEN 1 ELSE confidence END, updated_at=? WHERE message_id=?`)
        .run(newCol, newStatus, (input.isUrgent ?? !!cur.is_urgent) ? 1 : 0, input.deadlineAt !== undefined ? input.deadlineAt : cur.deadline_at,
          (input.processed ?? !!cur.processed) ? 1 : 0, input.caseId !== undefined ? input.caseId : cur.case_id,
          columnChanged || input.status !== undefined ? "user" : cur.source, columnChanged ? 1 : 0, now, messageId);
      if (columnChanged || newStatus !== cur.status) {
        this.db.prepare(`INSERT INTO placement_history(id,message_id,from_column,to_column,from_status,to_status,actor,reason,at) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(ulid(), messageId, cur.column_code, newCol, cur.status, newStatus, actor, input.reason ?? null, now);
      }
      if (columnChanged) {
        // Apprentissage : la correction alimente ai_feedback et le vote k-NN (le placement devient source=user)
        this.db.prepare(`INSERT INTO ai_feedback(id,message_id,predicted_column,corrected_column,features_snapshot_json,at) VALUES (?,?,?,?,?,?)`)
          .run(ulid(), messageId, cur.column_code, newCol, cur.evidence_json ?? "{}", now);
        if (newCol === "RIB") this.db.prepare(`INSERT OR IGNORE INTO rib_request(message_id,status,status_since) VALUES (?,?,?)`).run(messageId, "A_EDITER", now);
      }
      if (input.caseId) {
        this.db.prepare(`INSERT INTO case_link(message_id,case_id,source,confidence,validated_by_user) VALUES (?,?,'user',1,1)
          ON CONFLICT(message_id,case_id) DO UPDATE SET source='user', confidence=1, validated_by_user=1`).run(messageId, input.caseId);
      }
    });
    tx();
    this.audit.record(actor, "placement.update", { kind: "message", id: messageId }, { from: cur.column_code, to: newCol, status: newStatus, isUrgent: input.isUrgent, deadlineAt: input.deadlineAt, caseId: input.caseId });
    this.bus.publish({ type: "placement", messageId, column: newCol, isUrgent: input.isUrgent ?? !!cur.is_urgent });
  }

  /** Précision par colonne sur 30 jours (corrections / placements) — tableau de bord §6.2. */
  accuracy(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const placed = this.db.prepare(`SELECT to_column AS col, COUNT(*) AS n FROM placement_history WHERE actor='engine' AND at>=? GROUP BY to_column`).all(since) as any[];
    const corrected = this.db.prepare(`SELECT predicted_column AS col, COUNT(*) AS n FROM ai_feedback WHERE at>=? GROUP BY predicted_column`).all(since) as any[];
    const map: Record<string, { placed: number; corrected: number; precision: number }> = {};
    for (const p of placed) map[p.col] = { placed: p.n, corrected: 0, precision: 1 };
    for (const c of corrected) { map[c.col] ??= { placed: 0, corrected: 0, precision: 0 }; map[c.col].corrected = c.n; }
    for (const k of Object.keys(map)) map[k].precision = map[k].placed ? Number(((map[k].placed - map[k].corrected) / map[k].placed).toFixed(3)) : 0;
    return map;
  }

  /** Suggestions de règles à partir des corrections récurrentes (job hebdomadaire, §6.2). */
  suggestRules(minCount = 3) {
    return this.db.prepare(`
      SELECT substr(m.from_addr, instr(m.from_addr,'@')+1) AS domain, f.corrected_column AS col, COUNT(*) AS n
      FROM ai_feedback f JOIN message m ON m.id=f.message_id
      GROUP BY domain, col HAVING n >= ? ORDER BY n DESC`).all(minCount) as { domain: string; col: string; n: number }[];
  }
}

export function defaultStatusFor(db: Database, column: string): string | null {
  const r = db.prepare(`SELECT status_schema FROM column_def WHERE code=?`).get(column) as { status_schema: string } | undefined;
  const s = r ? (JSON.parse(r.status_schema) as string[]) : [];
  return s[0] ?? null;
}
