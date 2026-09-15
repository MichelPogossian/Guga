/** Extraction de texte depuis un corps HTML et découpage des citations (§4.1). */

const BLOCK = /<\/(p|div|br|li|tr|h[1-6]|blockquote|table|section|article)>|<br\s*\/?>|<\/?(p|div|li|tr|h[1-6])\b[^>]*>/gi;

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(BLOCK, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è", agrave: "à",
  ccedil: "ç", ecirc: "ê", ocirc: "ô", ugrave: "ù", icirc: "î", acirc: "â", euro: "€", laquo: "«", raquo: "»",
};
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
}

/** Tronque les citations de réponses précédentes pour l'IA (le texte intégral reste indexé). */
export function stripQuotedReplies(text: string): string {
  const markers = [
    /^-{2,}\s*Message d'origine\s*-{2,}/im,
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^Le .{5,80} a écrit\s*:/im,
    /^On .{5,80} wrote\s*:/im,
    /^De\s*:\s.+\n(Envoyé|Sent)\s*:/im,
    /^From\s*:\s.+\n(Sent|Envoyé)\s*:/im,
    /^_{5,}\s*$/m,
  ];
  let cut = text.length;
  for (const m of markers) {
    const idx = text.search(m);
    if (idx > 40 && idx < cut) cut = idx;
  }
  const head = text.slice(0, cut);
  // Lignes commençant par ">" en fin de message
  const lines = head.split("\n");
  while (lines.length && /^\s*>/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n").trim();
}

const SECURE_SHARE_HOSTS = [
  "wetransfer.com", "we.tl", "oodrive.com", "e-barreau.fr", "ebarreau.fr", "opalexe.fr", "swisstransfer.com",
  "sharepoint.com", "onedrive.live.com", "1drv.ms", "dropbox.com", "drive.google.com", "filesender.renater.fr",
  "transfernow.net", "smash.gs", "fromsmash.com", "kdrive.infomaniak.com", "hubshare.com", "boxcryptor",
];

export interface DetectedLink { url: string; host: string; secureShare: boolean }

export function extractLinks(html: string | undefined, text: string | undefined): DetectedLink[] {
  const found = new Map<string, DetectedLink>();
  const add = (u: string) => {
    try {
      const url = new URL(u);
      if (!/^https?:$/.test(url.protocol)) return;
      const host = url.hostname.toLowerCase();
      if (!found.has(url.href)) {
        found.set(url.href, { url: url.href, host, secureShare: SECURE_SHARE_HOSTS.some((h) => host === h || host.endsWith("." + h)) });
      }
    } catch { /* ignore */ }
  };
  if (html) for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  if (text) for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) add(m[0]);
  return [...found.values()].slice(0, 100);
}
