/**
 * Pipeline de classification (§6) : ingestion → garde-fous → règles → similarité → LLM → décision.
 * Produit une Décision (proposition + preuves). N'exécute jamais d'action (C2).
 */
import type { Database } from "better-sqlite3";
import type { GugaConfig } from "../config.js";
import type { ColumnCode, Contact } from "../domain.js";
import type { NormalizedMessage } from "../normalize/message.js";
import { findDeadlineInText, normalizeDeadline } from "../modules/deadlines.js";
import { computeFacts, shortCircuit } from "./guards.js";
import { runLlm } from "./llm.js";
import type { OllamaClient } from "./ollama.js";
import { loadRules, runRules, type RuleSet } from "./rules.js";
import { knnVote, nearestNeighbors, toBlob } from "./similarity.js";
import { decide } from "./decide.js";
import type { Decision, Facts, LlmOutput, StageResult } from "./types.js";
import { logger } from "../logger.js";

export interface PipelineDeps {
  db: Database;
  cfg: GugaConfig;
  ollama: OllamaClient | null;
  contacts: () => Contact[];
  rules?: RuleSet;
}

export interface ClassifyContext {
  messageId: string;
  mailboxKind: "primary" | "shared";
  mailboxAddress: string;
  mailboxLabel: string;
  mailboxDefaultColumn: ColumnCode | null;
}

export class ClassificationPipeline {
  private rules: RuleSet;
  private model: string | null = null;
  private embedModel: string | null = null;
  constructor(private d: PipelineDeps) { this.rules = d.rules ?? loadRules(); }

  setRules(rs: RuleSet) { this.rules = rs; }
  getRules() { return this.rules; }

  /** Détermine les modèles utilisables (le modèle configuré, sinon le premier disponible). */
  async prepareModels(): Promise<{ model: string | null; embedModel: string | null }> {
    const o = this.d.ollama;
    if (!o || !this.d.cfg.ollama.enabled) return { model: null, embedModel: null };
    if (!(await o.ping())) { logger.warn("Ollama injoignable : classement par règles + similarité uniquement"); return { model: null, embedModel: null }; }
    const wanted = this.d.cfg.ollama.model;
    const models = o.listModels();
    this.model = o.hasModel(wanted) ? models.find((m) => m === wanted || m.split(":")[0] === wanted.split(":")[0])! : (models.find((m) => !/embed|bge|minilm|e5/i.test(m)) ?? null);
    const ew = this.d.cfg.ollama.embedModel;
    this.embedModel = o.hasModel(ew) ? models.find((m) => m.split(":")[0] === ew.split(":")[0])! : (models.find((m) => /embed|bge|minilm|e5/i.test(m)) ?? null);
    if (this.model !== wanted) logger.info({ model: this.model, wanted }, "modèle LLM de repli");
    return { model: this.model, embedModel: this.embedModel };
  }
  get activeModel() { return this.model; }
  get activeEmbedModel() { return this.embedModel; }

  facts(m: NormalizedMessage, ctx: ClassifyContext): Facts {
    return computeFacts(m, {
      userAddresses: this.d.cfg.userAddresses, firmDomain: this.d.cfg.firmDomain, contacts: this.d.contacts(),
      mailboxKind: ctx.mailboxKind, mailboxAddress: ctx.mailboxAddress, mailboxDefaultColumn: ctx.mailboxDefaultColumn,
      caseRefPattern: new RegExp(this.rules.case_ref_pattern),
    });
  }

  /**
   * Classification rapide (étapes 2 à 4, sans LLM). Renvoie la décision et indique si le LLM est requis.
   * Le placement est appliqué immédiatement par l'appelant ; l'enrichissement LLM suit en tâche séparée.
   */
  async classifyFast(m: NormalizedMessage, ctx: ClassifyContext): Promise<{ decision: Decision; needLlm: boolean; facts: Facts }> {
    const facts = this.facts(m, ctx);
    const stages: StageResult[] = [];
    const w = this.d.cfg.weights;

    // Étape 2 — court-circuit
    const sc = shortCircuit(facts);
    stages.push({ stage: "guards", scores: sc ? { [sc.column]: sc.confidence } : {}, notes: sc ? [`court-circuit ${sc.column}`] : [] });

    // Étape 3 — règles
    const rules = runRules(this.rules, m, facts);
    stages.push(rules);

    // Étape 4 — similarité
    let neighbors: Decision["evidence"]["similarNeighbors"] = [];
    let embedding: Float32Array | null = null;
    if (this.d.ollama && this.embedModel && this.d.ollama.canCall()) {
      try { embedding = await this.d.ollama.embed(this.embedModel, `${m.subject}\n${m.bodyForAi.slice(0, 800)}`); } catch (e) { logger.warn({ err: String(e) }, "embedding"); }
      if (embedding) {
        const nn = nearestNeighbors(this.d.db, embedding, 15, ctx.messageId);
        neighbors = nn.map((n) => ({ messageId: n.messageId, column: n.column, score: Number(n.score.toFixed(3)) }));
        stages.push(knnVote(nn));
        this.d.db.prepare(`INSERT OR REPLACE INTO message_vec(message_id, dim, embedding) VALUES (?,?,?)`).run(ctx.messageId, embedding.length, toBlob(embedding));
      }
    }

    let decision = decide(stages, null, facts, { weights: w, minConfidence: this.d.cfg.thresholds.minConfidence }, { skipped: true, neighbors });
    // Court-circuit « instruction » : sauf si une règle de workflow forte (RIB, PLAIDOIRIE, PIECES) l'emporte —
    // une instruction d'associé « préparer le RIB CARPA » relève de la colonne RIB (F§5.3).
    const workflow = (["RIB", "PLAIDOIRIE", "PIECES"] as ColumnCode[]).filter((c) => (rules.scores[c] ?? 0) >= 0.85).sort((a, b) => (rules.scores[b] ?? 0) - (rules.scores[a] ?? 0))[0];
    if (sc && workflow) decision = { ...decision, column: workflow, confidence: Math.max(decision.confidence, rules.scores[workflow]!), toConfirm: false };
    else if (sc) decision = { ...decision, column: sc.column, confidence: Math.max(decision.confidence, sc.confidence), toConfirm: false };

    decision.isUrgent = /\burgent\b|impérativement|au plus vite/i.test(m.subject + " " + m.bodyForAi.slice(0, 300));
    const found = findDeadlineInText(m.subject + "\n" + m.bodyForAi.slice(0, 3000), new Date(m.receivedAt));
    decision.deadlineAt = found?.deadline ?? null;
    if (found) decision.evidence.deadlineEvidence = found.evidence;
    decision.evidence.stages = stages;
    (decision.evidence as Record<string, unknown>).facts = facts;
    const needLlm = !!(this.d.ollama && this.model) && (sc !== null || decision.toConfirm || decision.confidence < this.d.cfg.thresholds.skipLlm);
    return { decision, needLlm, facts };
  }

  /** Étape 5 — enrichissement LLM : re-décision avec le score LLM, urgence, échéance, résumé, entités. */
  async enrichWithLlm(m: NormalizedMessage, ctx: ClassifyContext, prior: Decision): Promise<Decision | null> {
    if (!this.d.ollama || !this.model || !this.d.ollama.canCall()) return null;
    const facts = ((prior.evidence as Record<string, unknown>).facts as Facts) ?? this.facts(m, ctx);
    const llm = await runLlm(this.d.ollama, this.model, m, facts, ctx.mailboxLabel);
    if (!llm) return null;
    const sc = shortCircuit(facts);
    const stages: StageResult[] = [...prior.evidence.stages.filter((s) => s.stage !== "llm"), { stage: "llm", scores: { [llm.column]: llm.confidence }, notes: [llm.summary] }];
    let decision = decide(stages, llm, facts, { weights: this.d.cfg.weights, minConfidence: this.d.cfg.thresholds.minConfidence }, { skipped: false, neighbors: prior.evidence.similarNeighbors });
    // Le court-circuit et les règles de workflow fortes restent prioritaires sur l'avis du LLM.
    const rules = stages.find((s) => s.stage === "rules")!;
    const workflow = (["RIB", "PLAIDOIRIE", "PIECES"] as ColumnCode[]).filter((c) => (rules.scores[c] ?? 0) >= 0.85)[0];
    if (sc && workflow) decision = { ...decision, column: workflow, confidence: Math.max(decision.confidence, rules.scores[workflow]!), toConfirm: false };
    else if (sc) decision = { ...decision, column: sc.column, confidence: Math.max(decision.confidence, sc.confidence), toConfirm: false };
    decision.isUrgent = llm.is_urgent || prior.isUrgent;
    decision.deadlineAt = normalizeDeadline(llm.deadline_iso, llm.deadline_evidence, new Date(m.receivedAt)) ?? prior.deadlineAt;
    decision.summary = llm.summary || null;
    decision.caseHint = llm.case_hint ?? prior.caseHint;
    decision.evidence = { ...prior.evidence, stages, llm, deadlineEvidence: llm.deadline_evidence ?? prior.evidence.deadlineEvidence, hardConstraints: decision.evidence.hardConstraints };
    return decision;
  }

  /** Classification complète (rapide + LLM) — utilisée par la CLI et les tests. */
  async classify(m: NormalizedMessage, ctx: ClassifyContext): Promise<Decision> {
    const { decision, needLlm } = await this.classifyFast(m, ctx);
    if (!needLlm) return decision;
    try { return (await this.enrichWithLlm(m, ctx, decision)) ?? decision; } catch (e) { logger.warn({ err: String(e) }, "llm"); return decision; }
  }
}
