/** Étape 6 — fusion des scores, contraintes dures, seuil de confiance (§6.1). */
import type { ColumnCode } from "../domain.js";
import { applyHardConstraints } from "./guards.js";
import type { Decision, Facts, LlmOutput, Scores, StageResult } from "./types.js";

export interface DecideOptions { weights: { rules: number; similarity: number; llm: number }; minConfidence: number }

export function fuse(stages: StageResult[], llm: LlmOutput | null, w: DecideOptions["weights"]): Scores {
  const out: Scores = {};
  const add = (s: Scores, weight: number) => { for (const [c, v] of Object.entries(s) as [ColumnCode, number][]) out[c] = (out[c] ?? 0) + v * weight; };
  const rules = stages.find((s) => s.stage === "rules");
  const sim = stages.find((s) => s.stage === "similarity");
  const llmStage = stages.find((s) => s.stage === "llm");
  if (rules) add(rules.scores, w.rules);
  if (sim && Object.keys(sim.scores).length) add(sim.scores, w.similarity);
  if (llmStage && Object.keys(llmStage.scores).length) add(llmStage.scores, w.llm);
  else if (llm) add({ [llm.column]: llm.confidence }, w.llm);
  return out;
}

export function best(scores: Scores): { column: ColumnCode; score: number } | null {
  let bestC: ColumnCode | null = null, bestS = -1;
  for (const [c, v] of Object.entries(scores) as [ColumnCode, number][]) if (v > bestS) { bestC = c; bestS = v; }
  return bestC ? { column: bestC, score: bestS } : null;
}

/** Colonne par défaut quand rien n'est concluant : boîte partagée → sa colonne ; sinon selon expéditeur. */
export function fallbackColumn(facts: Facts): ColumnCode {
  if (facts.mailboxDefaultColumn) return facts.mailboxDefaultColumn;
  if (facts.userPosition === "cc") return "CC";
  if (facts.senderRole === "partner") return "INSTR_ASSOC";
  if (facts.senderRole === "associate") return "INSTR_COLLAB";
  if (facts.senderIsFirm) return "INSTR_COLLAB";
  return "CONTACT";
}

export function decide(stages: StageResult[], llm: LlmOutput | null, facts: Facts, opts: DecideOptions,
  extra: { skipped: boolean; neighbors?: Decision["evidence"]["similarNeighbors"] }): Decision {
  const fused = fuse(stages, llm, opts.weights);
  // Renormalisation : les poids des étages absents ne pénalisent pas la confiance.
  const present = (stages.some((s) => s.stage === "rules") ? opts.weights.rules : 0)
    + (stages.some((s) => s.stage === "similarity" && Object.keys(s.scores).length) ? opts.weights.similarity : 0)
    + (llm ? opts.weights.llm : 0);
  const normalized: Scores = {};
  for (const [c, v] of Object.entries(fused) as [ColumnCode, number][]) normalized[c] = present > 0 ? Math.min(1, v / present) : v;
  const { scores, applied } = applyHardConstraints(normalized, facts);
  const b = best(scores);
  let column: ColumnCode; let confidence: number; let toConfirm = false;
  if (!b || b.score < opts.minConfidence) {
    column = fallbackColumn(facts);
    confidence = b ? b.score : 0;
    toConfirm = true;
  } else { column = b.column; confidence = b.score; }
  // Une boîte partagée conserve sa colonne par défaut si la colonne trouvée est simplement "CONTACT/CLAIRE" opposée.
  return {
    column, confidence: Number(confidence.toFixed(3)), toConfirm,
    isUrgent: llm?.is_urgent ?? false,
    deadlineAt: llm?.deadline_iso ?? null,
    summary: llm?.summary ?? null,
    caseHint: llm?.case_hint ?? (facts.caseRefs[0] ?? null),
    evidence: { stages, hardConstraints: applied, llm, deadlineEvidence: llm?.deadline_evidence ?? null, similarNeighbors: extra.neighbors },
  };
}
