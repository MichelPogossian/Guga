/** EXPERTISE — qualification déterministe de repli (le LLM affine) (§7.10). */
import type { Database } from "better-sqlite3";

export type ExpertiseKind = "simple" | "dire" | "dates" | "accedit" | "rapport";

export function qualifyExpertise(text: string): ExpertiseKind {
  const t = text.toLowerCase();
  if (/\b(accedit|réunion d'expertise|réunion sur site|visite des lieux)\b/.test(t) && /\b(dates?|disponibilit|créneau|propos)/.test(t)) return "accedit";
  if (/\b(dates?|disponibilit|créneau)\b/.test(t) && /\b(propos|confirm|indiqu)/.test(t)) return "dates";
  if (/\b(pré-?rapport|rapport (d'expertise|définitif|final)|dépôt du rapport)\b/.test(t)) return "rapport";
  if (/\bdires?\b/.test(t)) return "dire";
  return "simple";
}

export function storeExpertise(db: Database, messageId: string, kind: ExpertiseKind, representsParty: string | null): void {
  db.prepare(`INSERT INTO expertise_item(message_id,kind,represents_party) VALUES (?,?,?) ON CONFLICT(message_id) DO UPDATE SET kind=excluded.kind, represents_party=COALESCE(expertise_item.represents_party, excluded.represents_party)`)
    .run(messageId, kind, representsParty);
}
