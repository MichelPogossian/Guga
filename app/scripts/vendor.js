// Copie DOMPurify dans renderer/vendor (aucun CDN à l'exécution, §3.2).
const fs = require("node:fs"), path = require("node:path");
const src = require.resolve("dompurify/dist/purify.min.js");
fs.mkdirSync(path.join(__dirname, "..", "renderer", "vendor"), { recursive: true });
fs.copyFileSync(src, path.join(__dirname, "..", "renderer", "vendor", "purify.min.js"));
console.log("vendor: purify.min.js");
