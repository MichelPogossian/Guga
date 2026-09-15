/** RIB CARPA — machine à états (§7.3). Transitions libres pour l'utilisatrice, journalisées. */
import type { Database } from "better-sqlite3";
import type { AuditService } from "../services/AuditService.js";

export const RIB_STATES = ["A_EDITER", "A_VERIFIER", "A_FAIRE_VERIFIER", "EN_ATTENTE", "A_ENVOYER_AVEC_PROTOCOLE", "ENVOYE"] as const;
export type RibState = (typeof RIB_STATES)[number];

/** Transitions nominales (documentaires ; l'utilisatrice peut forcer, c'est journalisé comme « forcée »). */
export const RIB_TRANSITIONS: Record<RibState, RibState[]> = {
  A_EDITER: ["A_VERIFIER", "EN_ATTENTE"],
  A_VERIFIER: ["A_FAIRE_VERIFIER", "EN_ATTENTE", "ENVOYE"],
  A_FAIRE_VERIFIER: ["ENVOYE", "EN_ATTENTE"],
  EN_ATTENTE: ["A_ENVOYER_AVEC_PROTOCOLE", "A_EDITER", "A_VERIFIER"],
  A_ENVOYER_AVEC_PROTOCOLE: ["ENVOYE"],
  ENVOYE: [],
};

export function isNominal(from: RibState, to: RibState): boolean { return RIB_TRANSITIONS[from]?.includes(to) ?? false; }

export interface RibInfo { instructedBy?: string | null; recipientKind?: "internal" | "opponent" | "other" | null; recipientContact?: string | null; caseId?: string | null; ecarpaCreated?: boolean }

export class RibService {
  constructor(private db: Database, private audit: AuditService) {}

  ensure(messageId: string, info: RibInfo = {}): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO rib_request(message_id,instructed_by,recipient_kind,recipient_contact,case_id,status,status_since) VALUES (?,?,?,?,?,'A_EDITER',?)
      ON CONFLICT(message_id) DO UPDATE SET instructed_by=COALESCE(rib_request.instructed_by, excluded.instructed_by), recipient_kind=COALESCE(rib_request.recipient_kind, excluded.recipient_kind),
      recipient_contact=COALESCE(rib_request.recipient_contact, excluded.recipient_contact), case_id=COALESCE(rib_request.case_id, excluded.case_id)`)
      .run(messageId, info.instructedBy ?? null, info.recipientKind ?? null, info.recipientContact ?? null, info.caseId ?? null, now);
  }

  transition(messageId: string, to: RibState, actor = "user"): { forced: boolean } {
    if (!RIB_STATES.includes(to)) throw new Error(`état RIB inconnu ${to}`);
    const cur = this.db.prepare(`SELECT status FROM rib_request WHERE message_id=?`).get(messageId) as { status: RibState } | undefined;
    if (!cur) throw new Error("demande RIB introuvable");
    const forced = !isNominal(cur.status, to);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE rib_request SET status=?, status_since=? WHERE message_id=?`).run(to, now, messageId);
      this.db.prepare(`UPDATE placement SET status=?, processed=?, updated_at=? WHERE message_id=?`).run(to, to === "ENVOYE" ? 1 : 0, now, messageId);
    })();
    this.audit.record(actor, "rib.transition", { kind: "message", id: messageId }, { from: cur.status, to, forced });
    return { forced };
  }

  update(messageId: string, info: RibInfo, actor = "user") {
    this.ensure(messageId);
    this.db.prepare(`UPDATE rib_request SET instructed_by=COALESCE(?,instructed_by), recipient_kind=COALESCE(?,recipient_kind), recipient_contact=COALESCE(?,recipient_contact), case_id=COALESCE(?,case_id), ecarpa_created=COALESCE(?,ecarpa_created) WHERE message_id=?`)
      .run(info.instructedBy ?? null, info.recipientKind ?? null, info.recipientContact ?? null, info.caseId ?? null, info.ecarpaCreated === undefined ? null : (info.ecarpaCreated ? 1 : 0), messageId);
    this.audit.record(actor, "rib.update", { kind: "message", id: messageId }, info as Record<string, unknown>);
  }

  /** Job quotidien 8 h : statut inchangé depuis N jours → liste des demandes en alerte. */
  stale(days: number, perStatus: Partial<Record<RibState, number>> = {}): { messageId: string; status: RibState; since: string; days: number }[] {
    const rows = this.db.prepare(`SELECT message_id, status, status_since FROM rib_request WHERE status <> 'ENVOYE'`).all() as any[];
    const now = Date.now();
    return rows.map((r) => ({ messageId: r.message_id, status: r.status as RibState, since: r.status_since, days: Math.floor((now - Date.parse(r.status_since)) / 86_400_000) }))
      .filter((r) => r.days >= (perStatus[r.status] ?? days));
  }
}
