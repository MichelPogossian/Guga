/** Calcul d'échéances : jours ouvrés français, expressions relatives (§7.5, §7.8). */

const FIXED_HOLIDAYS = ["01-01", "05-01", "05-08", "07-14", "08-15", "11-01", "11-11", "12-25"];

/** Pâques (algorithme de Meeus) → lundi de Pâques, Ascension, lundi de Pentecôte. */
export function easter(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

export function frenchHolidays(year: number): Set<string> {
  const s = new Set(FIXED_HOLIDAYS.map((d) => `${year}-${d}`));
  const e = easter(year);
  for (const off of [1, 39, 50]) {
    const d = new Date(e.getTime() + off * 86_400_000);
    s.add(d.toISOString().slice(0, 10));
  }
  return s;
}

export function isBusinessDay(d: Date): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !frenchHolidays(d.getUTCFullYear()).has(d.toISOString().slice(0, 10));
}

export function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); if (isBusinessDay(d)) left--; }
  return d;
}

export function addCalendarDays(from: Date, n: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + n);
  // Si le délai expire un samedi, dimanche ou jour férié, il est prorogé au premier jour ouvrable suivant (art. 642 CPC).
  while (!isBusinessDay(d)) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

const DAYS: Record<string, number> = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6 };
const MONTHS: Record<string, number> = { janvier: 0, "février": 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, "août": 7, aout: 7, septembre: 8, octobre: 9, novembre: 10, "décembre": 11, decembre: 11 };

/**
 * Résout une expression d'échéance relative par rapport à la date de réception.
 * Renvoie une date ISO (jour, éventuellement heure) ou null.
 */
export function resolveRelativeDeadline(text: string, receivedAt: Date): string | null {
  const t = text.toLowerCase();
  const base = new Date(Date.UTC(receivedAt.getUTCFullYear(), receivedAt.getUTCMonth(), receivedAt.getUTCDate()));
  const time = t.match(/\b(\d{1,2})\s?h\s?(\d{2})?\b/);
  const withTime = (d: Date) => {
    if (!time) return d.toISOString().slice(0, 10);
    const hh = String(time[1]).padStart(2, "0"), mm = (time[2] ?? "00").padStart(2, "0");
    return `${d.toISOString().slice(0, 10)}T${hh}:${mm}`;
  };
  // Date explicite "30 octobre 2026" / "6 octobre"
  const abs = t.match(/\b(\d{1,2})(?:er)?\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)(?:\s+(\d{4}))?/);
  if (abs) {
    const y = abs[3] ? Number(abs[3]) : receivedAt.getUTCFullYear();
    let d = new Date(Date.UTC(y, MONTHS[abs[2]], Number(abs[1])));
    if (!abs[3] && d < base) d = new Date(Date.UTC(y + 1, MONTHS[abs[2]], Number(abs[1])));
    return withTime(d);
  }
  const num = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (num) {
    const y = num[3] ? (num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3])) : receivedAt.getUTCFullYear();
    return withTime(new Date(Date.UTC(y, Number(num[2]) - 1, Number(num[1]))));
  }
  if (/\b(aujourd'hui|ce jour|ce soir)\b/.test(t)) return withTime(base);
  if (/\bdemain\b/.test(t)) return withTime(new Date(base.getTime() + 86_400_000));
  if (/\bsous huitaine\b/.test(t)) return addCalendarDays(base, 8).toISOString().slice(0, 10);
  if (/\bsous quinzaine\b/.test(t)) return addCalendarDays(base, 15).toISOString().slice(0, 10);
  const inDays = t.match(/\b(?:sous|d'ici|dans|avant)\s+(\d{1,2})\s*(jours?|j)\b(\s*ouvr[ée]s?)?/);
  if (inDays) return (inDays[3] ? addBusinessDays(base, Number(inDays[1])) : addCalendarDays(base, Number(inDays[1]))).toISOString().slice(0, 10);
  const h = t.match(/\b(?:sous|dans)\s+(24|48|72)\s*h\b/);
  if (h) return new Date(receivedAt.getTime() + Number(h[1]) * 3600_000).toISOString().slice(0, 16);
  const dow = t.match(/\b(?:avant|d'ici|pour)\s+(?:le\s+)?(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(?:\s+(soir|matin|midi))?\b/);
  if (dow) {
    const target = DAYS[dow[1]];
    const d = new Date(base);
    do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== target);
    if (dow[2] === "soir") return `${d.toISOString().slice(0, 10)}T18:00`;
    if (dow[2] === "midi") return `${d.toISOString().slice(0, 10)}T12:00`;
    if (dow[2] === "matin") return `${d.toISOString().slice(0, 10)}T09:00`;
    return withTime(d);
  }
  return null;
}

/** Normalise une échéance proposée par le LLM : ISO valide, sinon résolution relative sur la preuve. */
export function normalizeDeadline(iso: string | null, evidence: string | null, receivedAt: Date): string | null {
  if (iso && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(iso) && !Number.isNaN(Date.parse(iso))) return iso.slice(0, 16);
  if (evidence) return resolveRelativeDeadline(evidence, receivedAt);
  return null;
}

const DEADLINE_HINT = /\b(avant|d'ici|sous|dans|pour|au plus tard|impérativement|délai|échéance|expire|jusqu'au|demain|ce soir|aujourd'hui)\b/i;

/** Parcourt les phrases du texte et renvoie la première échéance résoluble, avec la phrase comme preuve. */
export function findDeadlineInText(text: string, receivedAt: Date): { deadline: string; evidence: string } | null {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);
  let first: { deadline: string; evidence: string } | null = null;
  for (const s of sentences) {
    if (!DEADLINE_HINT.test(s)) continue;
    const d = resolveRelativeDeadline(s, receivedAt);
    if (!d) continue;
    const cand = { deadline: d, evidence: s.slice(0, 200) };
    if (d.includes("T")) return cand; // une échéance horodatée est plus précise
    first ??= cand;
  }
  return first;
}
