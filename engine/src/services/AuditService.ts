/** Journal d'audit en ajout seul, chaîné par hachage (§11, C3). */
import crypto from "node:crypto";
import type { Database } from "better-sqlite3";

export interface AuditEntry {
  seq: number; at: string; actor: string; action: string; target_kind: string | null; target_id: string | null;
  payload_json: string; result: string; prev_hash: string; hash: string;
}

export function computeHash(prev: string, seq: number, at: string, payload: string): string {
  return crypto.createHash("sha256").update(`${prev}|${seq}|${at}|${payload}`).digest("hex");
}

export class AuditService {
  constructor(private db: Database) {}

  record(actor: string, action: string, target: { kind?: string; id?: string } = {}, payload: Record<string, unknown> = {}, result = "ok"): AuditEntry {
    const tx = this.db.transaction(() => {
      const last = this.db.prepare(`SELECT seq, hash FROM action_log ORDER BY seq DESC LIMIT 1`).get() as { seq: number; hash: string };
      const seq = last.seq + 1;
      const at = new Date().toISOString();
      const payload_json = JSON.stringify(payload);
      const hash = computeHash(last.hash, seq, at, payload_json);
      this.db.prepare(`INSERT INTO action_log(seq, at, actor, action, target_kind, target_id, payload_json, result, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(seq, at, actor, action, target.kind ?? null, target.id ?? null, payload_json, result, last.hash, hash);
      return this.db.prepare(`SELECT * FROM action_log WHERE seq = ?`).get(seq) as AuditEntry;
    });
    return tx();
  }

  list(filter: { from?: string; to?: string; action?: string; targetId?: string; limit?: number; offset?: number } = {}): AuditEntry[] {
    const where: string[] = []; const params: unknown[] = [];
    if (filter.from) { where.push("at >= ?"); params.push(filter.from); }
    if (filter.to) { where.push("at <= ?"); params.push(filter.to); }
    if (filter.action) { where.push("action LIKE ?"); params.push(filter.action + "%"); }
    if (filter.targetId) { where.push("target_id = ?"); params.push(filter.targetId); }
    const sql = `SELECT * FROM action_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...params, filter.limit ?? 200, filter.offset ?? 0) as AuditEntry[];
  }

  /** Vérifie l'intégrité de la chaîne (guga-cli audit verify). */
  verify(): { ok: boolean; checked: number; brokenAt?: number } {
    const rows = this.db.prepare(`SELECT * FROM action_log ORDER BY seq ASC`).all() as AuditEntry[];
    let prev = rows[0]?.hash ?? "genesis";
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.prev_hash !== prev || computeHash(prev, r.seq, r.at, r.payload_json) !== r.hash) return { ok: false, checked: i, brokenAt: r.seq };
      prev = r.hash;
    }
    return { ok: true, checked: rows.length };
  }

  /** Export CSV signé : dernière ligne = hachage SHA-256 du contenu. */
  exportCsv(filter: Parameters<AuditService["list"]>[0] = {}): string {
    const rows = this.list({ ...filter, limit: 100_000 }).reverse();
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["seq,at,actor,action,target_kind,target_id,payload_json,result,prev_hash,hash",
      ...rows.map((r) => [r.seq, r.at, r.actor, r.action, r.target_kind, r.target_id, r.payload_json, r.result, r.prev_hash, r.hash].map(esc).join(","))];
    const body = lines.join("\n");
    return body + "\n# sha256=" + crypto.createHash("sha256").update(body).digest("hex") + "\n";
  }
}
