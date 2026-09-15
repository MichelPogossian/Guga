/**
 * Mode « web » (démonstration hébergée, ex. Render) : moteur + interface dans un seul processus.
 * - L'API Fastify reste liée à 127.0.0.1 ; ce serveur écoute sur 0.0.0.0:$PORT, sert le renderer
 *   et relaie /api/* en ajoutant le jeton de session côté serveur.
 * - Accès protégé par authentification HTTP Basic (GUGA_WEB_PASSWORD obligatoire).
 * - Hors périmètre du CDC (mono-poste) : réservé aux démonstrations avec le connecteur simulé.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createEngine } from "./engine.js";
import { startServer } from "./api/server.js";
import { logger } from "./logger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RENDERER = [path.resolve(here, "../../app/renderer"), path.resolve(here, "../app/renderer")].find((p) => fs.existsSync(p));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

async function main() {
  const password = process.env.GUGA_WEB_PASSWORD;
  if (!password) throw new Error("GUGA_WEB_PASSWORD est obligatoire en mode web");
  if (!RENDERER) throw new Error("dossier app/renderer introuvable");
  const user = process.env.GUGA_WEB_USER ?? "guga";
  const port = Number(process.env.PORT ?? 8790);

  const engine = await createEngine();
  await startServer(engine);
  await engine.start();
  const expected = Buffer.from(`${user}:${password}`);
  const authorized = (h?: string) => {
    if (!h?.startsWith("Basic ")) return false;
    const given = Buffer.from(h.slice(6), "base64");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };
  let purify: Buffer | null = null;
  try { purify = fs.readFileSync(require.resolve("dompurify/dist/purify.min.js")); } catch { /* vendor absent */ }

  http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
    if (!authorized(req.headers.authorization)) { res.writeHead(401, { "www-authenticate": 'Basic realm="Guga"' }); res.end("Authentification requise"); return; }
    if (url.startsWith("/api/")) {
      const p = http.request({ host: engine.cfg.apiHost, port: engine.cfg.apiPort, path: (req.url ?? "").slice(4), method: req.method,
        headers: { ...req.headers, host: engine.cfg.apiHost, authorization: `Bearer ${engine.sessionToken}` } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      p.on("error", (e) => { res.writeHead(502); res.end(e.message); });
      req.pipe(p);
      return;
    }
    if (url === "/vendor/purify.min.js" && purify) { res.writeHead(200, { "content-type": "text/javascript" }); res.end(purify); return; }
    const file = path.join(RENDERER, url === "/" ? "index.html" : url);
    if (!file.startsWith(RENDERER) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (file.endsWith(".html")) {
      body = Buffer.from(body.toString("utf8")
        .replace('<meta http-equiv="Content-Security-Policy"', '<meta name="x-csp-disabled-web"')
        .replace('<script type="module" src="js/', '<script src="js/dev-bridge.js"></script><script type="module" src="js/'));
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  }).listen(port, "0.0.0.0", () => logger.info({ port, connector: engine.cfg.connector }, "Guga web en écoute"));

  const shutdown = async () => { await engine.stop(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}
main().catch((e) => { logger.error({ err: String(e) }, "démarrage web impossible"); process.exit(1); });
