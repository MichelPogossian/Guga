/** Accès aux données de lecture pour l'API et les services (§5, §9.1). */
import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import type { ColumnCode, Contact, Mailbox } from "../domain.js";

export interface ColumnSummary {
  code: ColumnCode; label: string; ord: number; allowsDelete: boolean; statusSchema: string[]; color: string | null;
  total: number; unprocessed: number; urgent: number; toConfirm: number; alerts: number;
}

export interface MessageListFilter {
  column?: string; q?: string; urgent?: boolean; status?: string; processed?: boolean; toConfirm?: boolean;
  from?: string; mailboxId?: string; since?: string; until?: string; hasAttachments?: boolean; caseId?: string;
  sort?: "received_desc" | "received_asc" | "deadline"; limit?: number; offset?: number; fromColumn?: string;
}

export class Repository {
  constructor(public db: Database) {}

  // --- Boîtes -------------------------------------------------------------
  upsertMailbox(mb: Mailbox): void {
    this.db.prepare(`INSERT INTO mailbox(id,label,kind,address,connector,default_column,delta_state)
      VALUES (@id,@label,@kind,@address,@connector,@default_column,@delta_state)
      ON CONFLICT(address) DO UPDATE SET label=excluded.label, kind=excluded.kind, connector=excluded.connector, default_column=excluded.default_column`)
      .run({ id: mb.id, label: mb.label, kind: mb.kind, address: mb.address, connector: mb.connector, default_column: mb.defaultColumn, delta_state: JSON.stringify(mb.deltaState ?? {}) });
  }
  listMailboxes(): (Mailbox & { lastSyncAt: string | null; lastError: string | null })[] {
    return (this.db.prepare(`SELECT * FROM mailbox ORDER BY kind, label`).all() as any[]).map((r) => ({
      id: r.id, label: r.label, kind: r.kind, address: r.address, connector: r.connector, defaultColumn: r.default_column,
      deltaState: JSON.parse(r.delta_state), lastSyncAt: r.last_sync_at, lastError: r.last_error,
    }));
  }
  getMailbox(id: string) { return this.listMailboxes().find((m) => m.id === id) ?? null; }
  saveDeltaState(id: string, state: Record<string, unknown>, error: string | null = null): void {
    this.db.prepare(`UPDATE mailbox SET delta_state=?, last_sync_at=?, last_error=? WHERE id=?`).run(JSON.stringify(state), new Date().toISOString(), error, id);
  }

  // --- Contacts / dossiers ----------------------------------------------
  listContacts(): Contact[] {
    return (this.db.prepare(`SELECT * FROM contact ORDER BY role, name`).all() as any[]).map((r) => ({
      id: r.id, name: r.name, emails: JSON.parse(r.emails_json), role: r.role, barId: r.bar_id ?? undefined, firm: r.firm ?? undefined, phone: r.phone ?? undefined,
    }));
  }
  upsertContact(c: Partial<Contact> & { name: string; emails: string[]; role: Contact["role"] }): Contact {
    const id = c.id ?? ulid();
    this.db.prepare(`INSERT INTO contact(id,name,emails_json,role,bar_id,firm,phone) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, emails_json=excluded.emails_json, role=excluded.role, bar_id=excluded.bar_id, firm=excluded.firm, phone=excluded.phone`)
      .run(id, c.name, JSON.stringify(c.emails.map((e) => e.toLowerCase())), c.role, c.barId ?? null, c.firm ?? null, c.phone ?? null);
    return { id, name: c.name, emails: c.emails, role: c.role, barId: c.barId, firm: c.firm, phone: c.phone };
  }
  deleteContact(id: string) { this.db.prepare(`DELETE FROM contact WHERE id=?`).run(id); }

  listCases() {
    return (this.db.prepare(`SELECT * FROM case_ref ORDER BY secib_ref DESC`).all() as any[]).map((r) => ({
      id: r.id, secibRef: r.secib_ref, label: r.label, parties: JSON.parse(r.parties_json), counsel: JSON.parse(r.counsel_json),
      court: r.court, hearings: JSON.parse(r.hearing_dates_json), lastSyncedAt: r.last_synced_at,
    }));
  }
  upsertCase(c: { id?: string; secibRef: string; label: string; parties?: string[]; counsel?: string[]; court?: string; hearings?: string[] }): string {
    const existing = this.db.prepare(`SELECT id FROM case_ref WHERE secib_ref=?`).get(c.secibRef) as { id: string } | undefined;
    const id = c.id ?? existing?.id ?? ulid();
    this.db.prepare(`INSERT INTO case_ref(id,secib_ref,label,parties_json,counsel_json,court,hearing_dates_json,last_synced_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET secib_ref=excluded.secib_ref,label=excluded.label,parties_json=excluded.parties_json,counsel_json=excluded.counsel_json,court=excluded.court,hearing_dates_json=excluded.hearing_dates_json,last_synced_at=excluded.last_synced_at`)
      .run(id, c.secibRef, c.label, JSON.stringify(c.parties ?? []), JSON.stringify(c.counsel ?? []), c.court ?? null, JSON.stringify(c.hearings ?? []), new Date().toISOString());
    return id;
  }

  // --- Colonnes ----------------------------------------------------------
  columns(): ColumnSummary[] {
    const rows = this.db.prepare(`
      SELECT c.code, c.label, c.ord, c.allows_delete, c.status_schema, c.color,
        (SELECT COUNT(*) FROM placement p JOIN message m ON m.id=p.message_id WHERE p.column_code=c.code AND m.is_deleted_remote=0) AS total,
        (SELECT COUNT(*) FROM placement p JOIN message m ON m.id=p.message_id WHERE p.column_code=c.code AND p.processed=0 AND m.is_deleted_remote=0) AS unprocessed,
        (SELECT COUNT(*) FROM placement p JOIN message m ON m.id=p.message_id WHERE p.column_code=c.code AND p.is_urgent=1 AND p.processed=0 AND m.is_deleted_remote=0) AS urgent,
        (SELECT COUNT(*) FROM placement p JOIN message m ON m.id=p.message_id WHERE p.column_code=c.code AND p.to_confirm=1 AND p.processed=0 AND m.is_deleted_remote=0) AS to_confirm
      FROM column_def c ORDER BY c.ord`).all() as any[];
    return rows.map((r) => ({
      code: r.code, label: r.label, ord: r.ord, allowsDelete: !!r.allows_delete, statusSchema: JSON.parse(r.status_schema), color: r.color,
      total: r.total, unprocessed: r.unprocessed, urgent: r.urgent, toConfirm: r.to_confirm, alerts: 0,
    }));
  }
  columnDef(code: string) { return this.db.prepare(`SELECT * FROM column_def WHERE code=?`).get(code) as any | undefined; }

  // --- Messages ----------------------------------------------------------
  private baseSelect = `
    SELECT m.id, m.mailbox_id, mb.label AS mailbox_label, m.ext_id, m.from_addr, m.from_name, m.to_json, m.cc_json, m.subject, m.received_at,
      m.has_attachments, m.attachment_names, m.is_read, m.is_deleted_remote, m.conversation_id,
      substr(m.body_text, 1, 220) AS preview,
      p.column_code, p.status, p.is_urgent, p.deadline_at, p.source, p.confidence, p.to_confirm, p.case_id, p.processed, p.summary, p.updated_at,
      cr.label AS case_label, cr.secib_ref,
      (SELECT COUNT(*) FROM attachment a WHERE a.message_id=m.id) AS attachment_count,
      r.status AS rib_status, r.recipient_kind AS rib_recipient_kind, r.status_since AS rib_status_since,
      (SELECT ph.from_column FROM placement_history ph WHERE ph.message_id=m.id AND ph.actor <> 'engine' ORDER BY ph.at DESC LIMIT 1) AS redirected_from,
      (SELECT COUNT(*) FROM procedural_alert pa WHERE pa.message_id=m.id AND pa.acknowledged=0) AS open_alerts
    FROM message m
    JOIN mailbox mb ON mb.id=m.mailbox_id
    LEFT JOIN placement p ON p.message_id=m.id
    LEFT JOIN case_ref cr ON cr.id=p.case_id
    LEFT JOIN rib_request r ON r.message_id=m.id`;

  listMessages(f: MessageListFilter): { items: any[]; total: number } {
    const where: string[] = ["m.is_deleted_remote=0"]; const params: unknown[] = [];
    if (f.column) { where.push("p.column_code=?"); params.push(f.column); }
    if (f.urgent) where.push("p.is_urgent=1");
    if (f.toConfirm) where.push("p.to_confirm=1");
    if (f.processed !== undefined) { where.push("p.processed=?"); params.push(f.processed ? 1 : 0); }
    if (f.status) { where.push("p.status=?"); params.push(f.status); }
    if (f.from) { where.push("(m.from_addr LIKE ? OR m.from_name LIKE ?)"); params.push(`%${f.from}%`, `%${f.from}%`); }
    if (f.mailboxId) { where.push("m.mailbox_id=?"); params.push(f.mailboxId); }
    if (f.since) { where.push("m.received_at>=?"); params.push(f.since); }
    if (f.until) { where.push("m.received_at<=?"); params.push(f.until); }
    if (f.hasAttachments) where.push("m.has_attachments=1");
    if (f.caseId) { where.push("p.case_id=?"); params.push(f.caseId); }
    if (f.fromColumn) { where.push("EXISTS (SELECT 1 FROM placement_history ph WHERE ph.message_id=m.id AND ph.from_column=?)"); params.push(f.fromColumn); }
    if (f.q && f.q.trim()) {
      where.push("m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)");
      params.push(ftsQuery(f.q));
    }
    const order = f.sort === "received_asc" ? "m.received_at ASC" : f.sort === "deadline" ? "p.deadline_at IS NULL, p.deadline_at ASC, m.received_at DESC" : "p.is_urgent DESC, m.received_at DESC";
    const w = "WHERE " + where.join(" AND ");
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM message m LEFT JOIN placement p ON p.message_id=m.id ${w}`).get(...params) as { n: number }).n;
    const items = this.db.prepare(`${this.baseSelect} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, f.limit ?? 200, f.offset ?? 0) as any[];
    return { items: items.map(rowToListItem), total };
  }

  search(q: string, limit = 100) {
    const items = this.db.prepare(`${this.baseSelect} WHERE m.is_deleted_remote=0 AND m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ? ORDER BY rank LIMIT ?) ORDER BY m.received_at DESC`)
      .all(ftsQuery(q), limit) as any[];
    return items.map(rowToListItem);
  }

  getMessage(id: string) {
    const r = this.db.prepare(`${this.baseSelect} WHERE m.id=?`).get(id) as any;
    if (!r) return null;
    const full = this.db.prepare(`SELECT body_text, body_html, headers_json, links_json, internet_message_id FROM message WHERE id=?`).get(id) as any;
    const pl = this.db.prepare(`SELECT evidence_json FROM placement WHERE message_id=?`).get(id) as any;
    return {
      ...rowToListItem(r),
      bodyText: full.body_text, bodyHtml: full.body_html, headers: JSON.parse(full.headers_json), links: JSON.parse(full.links_json),
      internetMessageId: full.internet_message_id,
      evidence: pl ? JSON.parse(pl.evidence_json) : {},
      attachments: this.db.prepare(`SELECT id, ext_id, name, mime, size, sha256, cache_path, piece_number, piece_title, parent_id FROM attachment WHERE message_id=? ORDER BY piece_number, name`).all(id),
      history: this.db.prepare(`SELECT * FROM placement_history WHERE message_id=? ORDER BY at DESC`).all(id),
      caseLinks: this.db.prepare(`SELECT cl.*, cr.label, cr.secib_ref FROM case_link cl JOIN case_ref cr ON cr.id=cl.case_id WHERE cl.message_id=?`).all(id),
      rib: this.db.prepare(`SELECT * FROM rib_request WHERE message_id=?`).get(id) ?? null,
      alerts: this.db.prepare(`SELECT * FROM procedural_alert WHERE message_id=? ORDER BY due_at`).all(id),
      expertise: this.db.prepare(`SELECT * FROM expertise_item WHERE message_id=?`).get(id) ?? null,
      newCase: this.db.prepare(`SELECT * FROM new_case_check WHERE message_id=?`).get(id) ?? null,
      audit: this.db.prepare(`SELECT seq, at, actor, action, result, payload_json FROM action_log WHERE target_id=? ORDER BY seq DESC LIMIT 50`).all(id),
    };
  }

  messageRaw(id: string) { return this.db.prepare(`SELECT * FROM message WHERE id=?`).get(id) as any | undefined; }

  // --- Paramètres --------------------------------------------------------
  getSetting<T>(key: string, def: T): T {
    const r = this.db.prepare(`SELECT value_json FROM setting WHERE key=?`).get(key) as { value_json: string } | undefined;
    return r ? (JSON.parse(r.value_json) as T) : def;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare(`INSERT INTO setting(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
  allSettings(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.prepare(`SELECT key, value_json FROM setting`).all() as any[]) out[r.key] = JSON.parse(r.value_json);
    return out;
  }
  getColumnFilter(code: string) { const r = this.db.prepare(`SELECT filter_json FROM column_filter WHERE column_code=?`).get(code) as any; return r ? JSON.parse(r.filter_json) : null; }
  setColumnFilter(code: string, filter: unknown) {
    this.db.prepare(`INSERT INTO column_filter(column_code,filter_json,updated_at) VALUES (?,?,?) ON CONFLICT(column_code) DO UPDATE SET filter_json=excluded.filter_json, updated_at=excluded.updated_at`)
      .run(code, JSON.stringify(filter), new Date().toISOString());
  }
}

/** Convertit une requête utilisateur en requête FTS5 sûre (préfixes, sans opérateurs). */
export function ftsQuery(q: string): string {
  const terms = q.replace(/["*()^:]/g, " ").split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return '""';
  return terms.map((t) => `"${t}"*`).join(" ");
}

export function rowToListItem(r: any) {
  return {
    id: r.id, mailboxId: r.mailbox_id, mailboxLabel: r.mailbox_label, extId: r.ext_id,
    from: { address: r.from_addr, name: r.from_name }, to: JSON.parse(r.to_json ?? "[]"), cc: JSON.parse(r.cc_json ?? "[]"),
    subject: r.subject, receivedAt: r.received_at, preview: r.preview, hasAttachments: !!r.has_attachments,
    attachmentNames: r.attachment_names, attachmentCount: r.attachment_count, isRead: !!r.is_read, conversationId: r.conversation_id,
    placement: r.column_code ? {
      column: r.column_code, status: r.status, isUrgent: !!r.is_urgent, deadlineAt: r.deadline_at, source: r.source,
      confidence: r.confidence, toConfirm: !!r.to_confirm, caseId: r.case_id, caseLabel: r.case_label, secibRef: r.secib_ref,
      processed: !!r.processed, summary: r.summary, updatedAt: r.updated_at, redirectedFrom: r.redirected_from,
    } : null,
    rib: r.rib_status ? { status: r.rib_status, recipientKind: r.rib_recipient_kind, statusSince: r.rib_status_since } : null,
    openAlerts: r.open_alerts ?? 0,
  };
}
