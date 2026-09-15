/**
 * API HTTP locale (§9.1) — Fastify lié à 127.0.0.1 uniquement.
 * - Toute route exige `Authorization: Bearer <jeton de session>` (§10.2).
 * - Les routes du plan d'action exigent en plus `X-Guga-Intent` (jeton à usage unique).
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { Engine } from "../engine.js";
import { registerReadRoutes } from "./routes/read.js";
import { registerWriteRoutes } from "./routes/write.js";
import { registerModuleRoutes } from "./routes/modules.js";
import { registerAdminRoutes } from "./routes/admin.js";

export async function buildServer(engine: Engine): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  app.addHook("onRequest", async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query as any)?.token;
    if (token !== engine.sessionToken) {
      if (req.url.startsWith("/actions")) engine.audit.record("anonymous", "auth.refused", {}, { url: req.url }, "refused");
      return reply.code(401).send({ error: "non autorisé" });
    }
  });
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as any).statusCode ?? 400;
    reply.code(status).send({ error: err.message });
  });

  await registerReadRoutes(app, engine);
  await registerWriteRoutes(app, engine);
  await registerModuleRoutes(app, engine);
  await registerAdminRoutes(app, engine);
  return app;
}

export async function startServer(engine: Engine): Promise<FastifyInstance> {
  const app = await buildServer(engine);
  await app.listen({ host: engine.cfg.apiHost, port: engine.cfg.apiPort });
  return app;
}
