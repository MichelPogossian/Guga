/** Étape 5 — LLM local, sortie contrainte par JSON Schema et validée par zod (§6.1). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { COLUMN_CODES, type ColumnCode } from "../domain.js";
import type { NormalizedMessage } from "../normalize/message.js";
import type { OllamaClient } from "./ollama.js";
import type { Facts, LlmOutput } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_VERSION = "classify_v3";

const LlmSchema = z.object({
  column: z.enum(COLUMN_CODES as [ColumnCode, ...ColumnCode[]]),
  confidence: z.number().min(0).max(1),
  is_urgent: z.boolean(),
  deadline_iso: z.string().nullable(),
  deadline_evidence: z.string().nullable(),
  case_hint: z.string().nullable(),
  entities: z.object({
    parties: z.array(z.string()).default([]),
    counsel: z.array(z.string()).default([]),
    court: z.string().nullable().default(null),
    refs: z.array(z.string()).default([]),
  }).default({ parties: [], counsel: [], court: null, refs: [] }),
  summary: z.string().default(""),
});

export const LLM_JSON_SCHEMA = {
  type: "object",
  properties: {
    column: { type: "string", enum: COLUMN_CODES },
    confidence: { type: "number" },
    is_urgent: { type: "boolean" },
    deadline_iso: { type: ["string", "null"] },
    deadline_evidence: { type: ["string", "null"] },
    case_hint: { type: ["string", "null"] },
    entities: {
      type: "object",
      properties: {
        parties: { type: "array", items: { type: "string" } },
        counsel: { type: "array", items: { type: "string" } },
        court: { type: ["string", "null"] },
        refs: { type: "array", items: { type: "string" } },
      },
      required: ["parties", "counsel", "court", "refs"],
    },
    summary: { type: "string" },
  },
  required: ["column", "confidence", "is_urgent", "deadline_iso", "deadline_evidence", "case_hint", "entities", "summary"],
};

let promptCache: string | null = null;
export function loadPrompt(): string {
  if (promptCache) return promptCache;
  promptCache = fs.readFileSync(path.resolve(here, `../../prompts/${PROMPT_VERSION}.md`), "utf8");
  return promptCache;
}

export function buildPrompt(m: NormalizedMessage, f: Facts, mailboxLabel: string): string {
  const vars: Record<string, string> = {
    received_at: m.receivedAt, mailbox: mailboxLabel, user_position: f.userPosition,
    sender_role: f.senderRole ?? (f.senderIsFirm ? "cabinet (rôle inconnu)" : "externe / inconnu"),
    from: `${m.fromName ?? ""} <${m.fromAddr}>`, to: m.to.join(", "), cc: m.cc.join(", ") || "—",
    subject: m.subject, attachments: m.attachmentNames || "aucune", body: m.bodyForAi.slice(0, 6000),
  };
  return loadPrompt().replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

export async function runLlm(ollama: OllamaClient, model: string, m: NormalizedMessage, f: Facts, mailboxLabel: string): Promise<LlmOutput | null> {
  const raw = await ollama.generateJson<unknown>(model, buildPrompt(m, f, mailboxLabel), LLM_JSON_SCHEMA);
  if (!raw) return null;
  const parsed = LlmSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
