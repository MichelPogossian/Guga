/** Étape 2 — garde-fous : faits déterministes et contraintes dures (§6.1). */
import type { ColumnCode, Contact } from "../domain.js";
import type { NormalizedMessage } from "../normalize/message.js";
import type { Facts, Scores } from "./types.js";

export interface GuardContext {
  userAddresses: string[];
  firmDomain: string;
  contacts: Contact[];
  mailboxKind: "primary" | "shared";
  mailboxAddress: string;
  mailboxDefaultColumn: ColumnCode | null;
  caseRefPattern: RegExp;
}

export function computeFacts(m: NormalizedMessage, ctx: GuardContext): Facts {
  const users = new Set([...ctx.userAddresses, ctx.mailboxAddress].map((a) => a.toLowerCase()));
  const inTo = m.to.some((a) => users.has(a));
  const inCc = m.cc.some((a) => users.has(a));
  const userPosition = inTo ? "to" : inCc ? "cc" : "none";
  const contact = ctx.contacts.find((c) => c.emails.some((e) => e.toLowerCase() === m.fromAddr));
  const senderDomain = m.fromAddr.split("@")[1] ?? "";
  const refs = new Set<string>();
  for (const s of [m.subject, m.bodyForAi]) for (const x of s.matchAll(new RegExp(ctx.caseRefPattern.source, "g"))) refs.add(x[0]);
  const firmPeople = ctx.contacts.filter((c) => c.role === "partner" || c.role === "associate").flatMap((c) => c.emails.map((e) => e.toLowerCase()));
  const recipients = [...m.to, ...m.cc];
  const onlyRecipientAlert = ctx.mailboxKind === "shared" && !recipients.some((r) => firmPeople.includes(r));
  return {
    userPosition,
    senderRole: contact?.role ?? null,
    senderContactId: contact?.id ?? null,
    senderIsFirm: senderDomain === ctx.firmDomain.toLowerCase(),
    mailboxKind: ctx.mailboxKind,
    mailboxDefaultColumn: ctx.mailboxDefaultColumn,
    caseRefs: [...refs],
    hasSecureLink: m.links.some((l) => l.secureShare),
    onlyRecipientAlert,
  };
}

/**
 * Applique les contraintes dures à un jeu de scores : les colonnes interdites sont mises à 0.
 * Renvoie la liste des contraintes appliquées (pour la preuve).
 */
export function applyHardConstraints(scores: Scores, facts: Facts): { scores: Scores; applied: string[] } {
  const out: Scores = { ...scores };
  const applied: string[] = [];
  if (facts.userPosition !== "cc") {
    if (out.CC) { out.CC = 0; applied.push("CC interdit : l'utilisatrice n'est pas uniquement en Cc"); }
  }
  if (facts.senderRole !== "partner" && !(facts.senderIsFirm && facts.senderRole === null)) {
    if (out.INSTR_ASSOC) { out.INSTR_ASSOC = 0; applied.push("INSTR_ASSOC interdit : expéditeur non associé"); }
  }
  if (facts.senderRole !== "associate" && !(facts.senderIsFirm && facts.senderRole === null)) {
    if (out.INSTR_COLLAB) { out.INSTR_COLLAB = 0; applied.push("INSTR_COLLAB interdit : expéditeur non collaborateur"); }
  }
  if (facts.mailboxDefaultColumn === "CLAIRE" && facts.userPosition !== "none") {
    // La boîte Claire ne reçoit pas de PUBS/CC : tout va en CLAIRE ou dans la colonne métier détectée.
    if (out.CC) { out.CC = 0; applied.push("CC interdit sur la boîte Claire"); }
  }
  if (facts.mailboxDefaultColumn === "CONTACT") {
    if (out.CC) { out.CC = 0; applied.push("CC interdit sur la boîte CONTACT"); }
    if (out.INSTR_ASSOC || out.INSTR_COLLAB) { out.INSTR_ASSOC = 0; out.INSTR_COLLAB = 0; applied.push("INSTRUCTIONS interdit sur la boîte CONTACT"); }
  }
  return { scores: out, applied };
}

/** Court-circuit d'étape 2 : expéditeur interne connu en To → instruction certaine. */
export function shortCircuit(facts: Facts): { column: ColumnCode; confidence: number } | null {
  if (facts.userPosition === "to" && facts.senderRole === "partner") return { column: "INSTR_ASSOC", confidence: 0.92 };
  if (facts.userPosition === "to" && facts.senderRole === "associate") return { column: "INSTR_COLLAB", confidence: 0.92 };
  return null;
}
