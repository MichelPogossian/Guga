/** PROCÉDURE — catalogue de motifs YAML, détection d'échéance avec preuve (§7.8). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ulid } from "ulid";
import type { Database } from "better-sqlite3";
import { addBusinessDays, addCalendarDays, resolveRelativeDeadline } from "./deadlines.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface ProcPattern { kind: string; label: string; match: string; delay: number | null; unit?: "calendar" | "business" | "months"; legal_basis: string; date_from_text?: boolean }
export interface ProcCatalog { patterns: ProcPattern[] }

export function loadProcedureCatalog(file?: string): ProcCatalog {
  return YAML.parse(fs.readFileSync(file ?? path.resolve(here, "../../rules/procedure_catalog.yaml"), "utf8"));
}

export interface DetectedAlert { kind: string; label: string; dueAt: string | null; legalBasis: string; evidence: string }

export function detectProceduralAlerts(cat: ProcCatalog, text: string, receivedAt: Date): DetectedAlert[] {
  const out: DetectedAlert[] = [];
  for (const p of cat.patterns) {
    const m = text.match(new RegExp(p.match, "i"));
    if (!m) continue;
    const idx = m.index ?? 0;
    const evidence = text.slice(Math.max(0, idx - 80), Math.min(text.length, idx + m[0].length + 120)).replace(/\s+/g, " ").trim();
    let dueAt: string | null = null;
    if (p.date_from_text) {
      const window = text.slice(idx, idx + 220);
      dueAt = resolveRelativeDeadline(window, receivedAt);
    }
    if (!dueAt && p.delay !== null && p.delay !== undefined) {
      if (p.unit === "business") dueAt = addBusinessDays(receivedAt, p.delay).toISOString().slice(0, 10);
      else if (p.unit === "months") { const d = new Date(receivedAt); d.setUTCMonth(d.getUTCMonth() + p.delay); dueAt = d.toISOString().slice(0, 10); }
      else dueAt = addCalendarDays(receivedAt, p.delay).toISOString().slice(0, 10);
    }
    out.push({ kind: p.kind, label: p.label, dueAt, legalBasis: p.legal_basis, evidence });
  }
  return out;
}

export function storeAlerts(db: Database, messageId: string, alerts: DetectedAlert[], caseId: string | null = null): void {
  const ins = db.prepare(`INSERT INTO procedural_alert(id,message_id,kind,due_at,legal_basis,evidence,case_id,acknowledged) VALUES (?,?,?,?,?,?,?,0)`);
  const exists = db.prepare(`SELECT 1 FROM procedural_alert WHERE message_id=? AND kind=?`);
  for (const a of alerts) if (!exists.get(messageId, a.kind)) ins.run(ulid(), messageId, a.kind, a.dueAt, a.legalBasis, a.evidence, caseId);
}
