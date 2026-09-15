/** Étape 3 — moteur de règles YAML (§6.1). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { COLUMN_CODES, type ColumnCode } from "../domain.js";
import type { NormalizedMessage } from "../normalize/message.js";
import type { Facts, Scores, StageResult } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const Cond = z.object({
  header_present: z.string().optional(),
  header_matches: z.object({ name: z.string(), pattern: z.string() }).optional(),
  from_domain: z.string().optional(),
  from_matches: z.string().optional(),
  from_role: z.string().optional(),
  subject_matches: z.string().optional(),
  body_matches: z.string().optional(),
  any_matches: z.string().optional(),
  attachment_matches: z.string().optional(),
  has_secure_link: z.boolean().optional(),
  mailbox_kind: z.enum(["primary", "shared"]).optional(),
  user_position: z.enum(["to", "cc", "none"]).optional(),
});
const Rule = z.object({ id: z.string(), column: z.enum(COLUMN_CODES as [ColumnCode, ...ColumnCode[]]), score: z.number().min(0).max(1), when: Cond, enabled: z.boolean().optional() });
export const RuleSet = z.object({ version: z.number(), firm_domain: z.string().optional(), case_ref_pattern: z.string().default("\\b(20\\d{2})-(\\d{4})\\b"), rules: z.array(Rule) });
export type RuleSet = z.infer<typeof RuleSet>;
export type Rule = z.infer<typeof Rule>;

export function loadRules(file?: string): RuleSet {
  const p = file ?? path.resolve(here, "../../rules/rules.yaml");
  return RuleSet.parse(YAML.parse(fs.readFileSync(p, "utf8")));
}
export function parseRules(yamlText: string): RuleSet { return RuleSet.parse(YAML.parse(yamlText)); }
export function dumpRules(rs: RuleSet): string { return YAML.stringify(rs); }

const rx = (p: string) => new RegExp(p, "i");

export function evalCondition(c: Rule["when"], m: NormalizedMessage, f: Facts): boolean {
  const checks: boolean[] = [];
  if (c.header_present) checks.push(c.header_present.toLowerCase() in m.headers);
  if (c.header_matches) checks.push(rx(c.header_matches.pattern).test(m.headers[c.header_matches.name.toLowerCase()] ?? ""));
  if (c.from_domain) checks.push(m.fromAddr.endsWith("@" + c.from_domain.toLowerCase()));
  if (c.from_matches) checks.push(rx(c.from_matches).test(m.fromAddr));
  if (c.from_role) checks.push(f.senderRole === c.from_role);
  if (c.subject_matches) checks.push(rx(c.subject_matches).test(m.subject));
  if (c.body_matches) checks.push(rx(c.body_matches).test(m.bodyForAi));
  if (c.any_matches) checks.push(rx(c.any_matches).test(m.subject + "\n" + m.bodyForAi + "\n" + m.attachmentNames));
  if (c.attachment_matches) checks.push(rx(c.attachment_matches).test(m.attachmentNames));
  if (c.has_secure_link !== undefined) checks.push(f.hasSecureLink === c.has_secure_link);
  if (c.mailbox_kind) checks.push(f.mailboxKind === c.mailbox_kind);
  if (c.user_position) checks.push(f.userPosition === c.user_position);
  return checks.length > 0 && checks.every(Boolean);
}

/** Combine les scores d'une même colonne par « OR probabiliste » : 1 - Π(1 - s). */
export function runRules(rs: RuleSet, m: NormalizedMessage, f: Facts): StageResult {
  const acc: Partial<Record<ColumnCode, number[]>> = {};
  const notes: string[] = [];
  for (const r of rs.rules) {
    if (r.enabled === false) continue;
    if (evalCondition(r.when, m, f)) {
      (acc[r.column] ??= []).push(r.score);
      notes.push(`${r.id} → ${r.column} (+${r.score})`);
    }
  }
  const scores: Scores = {};
  for (const [col, list] of Object.entries(acc) as [ColumnCode, number[]][]) {
    scores[col] = 1 - list.reduce((p, s) => p * (1 - s), 1);
  }
  return { stage: "rules", scores, notes };
}
