/** Rattachement message ↔ dossier : recherche hybride FTS (références, parties) + double seuil (§7.2). */
import type { Database } from "better-sqlite3";
import { normalizeForCompare } from "./newcase.js";

export interface CaseCandidate { caseId: string; secibRef: string; label: string; score: number; common: string[] }

export function findCaseCandidates(db: Database, text: string, refs: string[], caseHint: string | null): CaseCandidate[] {
  const cases = db.prepare(`SELECT id, secib_ref, label, parties_json, counsel_json FROM case_ref`).all() as any[];
  const norm = normalizeForCompare(text + " " + (caseHint ?? ""));
  const out: CaseCandidate[] = [];
  for (const c of cases) {
    const common: string[] = [];
    let score = 0;
    if (refs.includes(c.secib_ref) || (caseHint && caseHint.includes(c.secib_ref))) { score += 0.9; common.push(c.secib_ref); }
    const parties: string[] = JSON.parse(c.parties_json);
    for (const p of parties) {
      const tokens = normalizeForCompare(p).split(" ").filter((t) => t.length > 3 && !["sarl", "sas", "sci", "societe"].includes(t));
      const hit = tokens.filter((t) => norm.includes(t));
      if (hit.length && hit.length >= Math.ceil(tokens.length / 2)) { score += 0.35; common.push(p); }
    }
    const labelTokens = normalizeForCompare(c.label).split(" ").filter((t) => t.length > 4);
    const labelHits = labelTokens.filter((t) => norm.includes(t));
    if (labelHits.length >= 2) { score += 0.15; common.push(...labelHits.filter((t) => !common.some((x) => normalizeForCompare(x).includes(t)))); }
    if (score > 0) out.push({ caseId: c.id, secibRef: c.secib_ref, label: c.label, score: Math.min(1, Number(score.toFixed(3))), common: [...new Set(common)] });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

export function linkDecision(cands: CaseCandidate[], threshold: number, gap: number): { linked: CaseCandidate | null; status: "RATTACHE" | "NON_RATTACHE" } {
  const [a, b] = cands;
  if (a && a.score >= threshold && (!b || a.score - b.score >= gap)) return { linked: a, status: "RATTACHE" };
  return { linked: null, status: "NON_RATTACHE" };
}

export function storeCaseLink(db: Database, messageId: string, cands: CaseCandidate[], linked: CaseCandidate | null, source: "ai" | "rule" = "ai"): void {
  db.prepare(`DELETE FROM case_link WHERE message_id=? AND validated_by_user=0`).run(messageId);
  if (linked) {
    db.prepare(`INSERT OR IGNORE INTO case_link(message_id,case_id,source,confidence,validated_by_user,candidates_json) VALUES (?,?,?,?,0,?)`)
      .run(messageId, linked.caseId, source, linked.score, JSON.stringify(cands));
    db.prepare(`UPDATE placement SET case_id=COALESCE(case_id, ?) WHERE message_id=?`).run(linked.caseId, messageId);
  } else if (cands[0]) {
    db.prepare(`INSERT OR IGNORE INTO case_link(message_id,case_id,source,confidence,validated_by_user,candidates_json) VALUES (?,?,?,?,0,?)`)
      .run(messageId, cands[0].caseId, source, cands[0].score, JSON.stringify(cands));
  }
}
