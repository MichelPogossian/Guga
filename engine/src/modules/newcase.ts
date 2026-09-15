/**
 * NOUVEAUX DOSSIERS — extraction déterministe des parties/RCS (repli du LLM) et verdict (§7.7).
 * Les adaptateurs de vérification (Pappers, barreaux) sont dans src/adapters ; sans accès cadré → PENDING.
 */
import type { Database } from "better-sqlite3";
import type { ExternalAdapter, LookupRecord } from "../adapters/ExternalAdapter.js";

export interface ExtractedParty { name: string; form?: string; siren?: string; rcsCity?: string; address?: string; counsel?: string; bar?: string }

export function extractParties(text: string): ExtractedParty[] {
  const out: ExtractedParty[] = [];
  const re = /\b((?:SAS|SARL|SA|SCI|SNC|EURL|SASU|SCP|SELARL)\s+[A-ZÀ-Ý][A-ZÀ-Ý0-9' -]{2,60}?)\s*\(?\s*RCS\s+([A-Za-zÀ-ÿ-]+)\s+(\d{3}\s?\d{3}\s?\d{3})/g;
  for (const m of text.matchAll(re)) {
    const name = m[1].trim().replace(/\s+/g, " ");
    const form = name.split(" ")[0];
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 260);
    const addr = after.match(/(?:siège|sise?|domicilié[e]?)?\s*,?\s*(\d{1,4}\s?(?:bis|ter)?\s?(?:rue|avenue|av\.|boulevard|bd|place|chemin|allée|impasse|route)[^,)\n]{3,80}\d{5}\s[A-Za-zÀ-ÿ' -]+)/i);
    const counsel = after.match(/représentée? par\s+(Me|Maître)\s+([A-ZÀ-Ý][a-zà-ÿ]+(?:\s[A-ZÀ-Ý][a-zà-ÿ-]+)+)(?:,?\s*Barreau (?:de |d')([A-Za-zÀ-ÿ-]+))?/);
    out.push({ name, form, siren: m[3].replace(/\s/g, ""), rcsCity: m[2], address: addr?.[1]?.trim(), counsel: counsel ? `${counsel[1]} ${counsel[2]}` : undefined, bar: counsel?.[3] });
  }
  return out;
}

export function normalizeForCompare(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\b(avenue|av\.?)\b/g, "av").replace(/\b(boulevard|bd\.?)\b/g, "bd").replace(/\b(societe|ste)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

export interface CheckResult { field: string; expected: string; found: string | null; match: boolean | null; source: string; checkedAt: string }

export async function verifyParties(parties: ExtractedParty[], adapters: ExternalAdapter[], timeoutMs = 20_000): Promise<{ checks: CheckResult[]; verdict: "VERIFIE" | "INCOHERENCE" | "PENDING"; discrepancies: string[] }> {
  const checks: CheckResult[] = [];
  let pending = false;
  const now = new Date().toISOString();
  for (const p of parties) {
    if (!p.siren) continue;
    for (const ad of adapters) {
      if (!ad.lookup) continue;
      let recs: LookupRecord[] | null = null;
      try {
        recs = await Promise.race([ad.lookup({ siren: p.siren, name: p.name }), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
      } catch { recs = null; }
      if (!recs) { pending = true; checks.push({ field: `${p.name}.siren`, expected: p.siren, found: null, match: null, source: ad.name, checkedAt: now }); continue; }
      const rec = recs[0];
      const nameMatch = rec ? normalizeForCompare(rec.name).includes(normalizeForCompare(p.name.replace(/^(SAS|SARL|SA|SCI|SNC|EURL|SASU|SCP|SELARL)\s+/, ""))) : false;
      checks.push({ field: `${p.name}.denomination`, expected: p.name, found: rec?.name ?? null, match: nameMatch, source: ad.name, checkedAt: now });
      if (p.address && rec?.address) checks.push({ field: `${p.name}.siege`, expected: p.address, found: rec.address, match: normalizeForCompare(rec.address) === normalizeForCompare(p.address), source: ad.name, checkedAt: now });
    }
  }
  const discrepancies = checks.filter((c) => c.match === false).map((c) => `${c.field} : attendu « ${c.expected} », trouvé « ${c.found ?? "—"} » (${c.source})`);
  const verdict = discrepancies.length ? "INCOHERENCE" : pending || checks.length === 0 ? "PENDING" : "VERIFIE";
  return { checks, verdict, discrepancies };
}

export function storeNewCase(db: Database, messageId: string, extracted: unknown, checks: CheckResult[], verdict: string, discrepancies: string[]): void {
  db.prepare(`INSERT INTO new_case_check(message_id,extracted_json,checks_json,verdict,discrepancies_json,checked_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET extracted_json=excluded.extracted_json, checks_json=excluded.checks_json, verdict=excluded.verdict, discrepancies_json=excluded.discrepancies_json, checked_at=excluded.checked_at`)
    .run(messageId, JSON.stringify(extracted), JSON.stringify(checks), verdict, JSON.stringify(discrepancies), new Date().toISOString());
}

/** Fiche « prête à saisir » Secib (copier-coller structuré) — aucune écriture automatique. */
export function secibSheet(parties: ExtractedParty[], meta: { court?: string | null; hearing?: string | null; subject: string }): string {
  const lines = [`# Fiche nouveau dossier (à saisir dans Secib)`, `Objet : ${meta.subject}`, `Juridiction : ${meta.court ?? "—"}`, `Audience : ${meta.hearing ?? "—"}`, ""];
  parties.forEach((p, i) => {
    lines.push(`## Partie ${i + 1}`, `Dénomination : ${p.name}`, `Forme : ${p.form ?? "—"}`, `SIREN / RCS : ${p.siren ?? "—"} ${p.rcsCity ? "(RCS " + p.rcsCity + ")" : ""}`,
      `Siège : ${p.address ?? "—"}`, `Avocat : ${p.counsel ?? "—"}${p.bar ? " — Barreau de " + p.bar : ""}`, "");
  });
  return lines.join("\n");
}
