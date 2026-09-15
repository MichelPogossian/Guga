/** Point d'entrée du service « Guga Engine » (§3.4). */
import fs from "node:fs";
import path from "node:path";
import { createEngine } from "./engine.js";
import { startServer } from "./api/server.js";
import { parseRules } from "./classify/rules.js";
import { logger } from "./logger.js";

async function main() {
  const engine = await createEngine();
  const custom = path.join(engine.cfg.dataDir, "rules.yaml");
  if (fs.existsSync(custom)) { try { engine.pipeline.setRules(parseRules(fs.readFileSync(custom, "utf8"))); } catch (e) { logger.warn({ err: String(e) }, "rules.yaml personnalisé ignoré"); } }
  const app = await startServer(engine);
  await engine.start();
  logger.info({ host: engine.cfg.apiHost, port: engine.cfg.apiPort, dataDir: engine.cfg.dataDir }, "API locale en écoute");
  const shutdown = async () => { logger.info("arrêt"); await app.close(); await engine.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
main().catch((e) => { logger.error({ err: String(e) }, "démarrage impossible"); process.exit(1); });
