/**
 * Mode « web de développement » : sert le renderer en HTTP local et relaie /api/* vers le moteur
 * en ajoutant le jeton de session côté serveur (le navigateur ne le voit jamais).
 * Sert aussi à la recette de l'interface hors Electron (Playwright) — jamais utilisé en production.
 */
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const PORT = Number(process.env.GUGA_WEB_PORT || 8790), API_PORT = Number(process.env.GUGA_API_PORT || 8765);
const DATA_DIR = process.env.GUGA_DATA_DIR || path.join(os.homedir(), ".guga");
const ROOT = path.join(__dirname, "..", "renderer");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const token = () => { try { return fs.readFileSync(path.join(DATA_DIR, "session.token"), "utf8").trim(); } catch { return ""; } };

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    const p = http.request({ host: "127.0.0.1", port: API_PORT, path: req.url.slice(4), method: req.method, headers: { ...req.headers, host: "127.0.0.1", authorization: `Bearer ${token()}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on("error", (e) => { res.writeHead(502); res.end(e.message); });
    req.pipe(p);
    return;
  }
  let file = path.join(ROOT, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(file);
  if (file.endsWith(".html")) body = Buffer.from(body.toString("utf8").replace('<meta http-equiv="Content-Security-Policy"', '<meta name="x-csp-disabled-dev"').replace('<script type="module" src="js/', '<script src="js/dev-bridge.js"></script><script type="module" src="js/'));
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(body);
}).listen(PORT, "127.0.0.1", () => console.log(`Guga web (dev) : http://127.0.0.1:${PORT} → API ${API_PORT}`));
