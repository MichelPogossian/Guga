/** Métadonnées (placements) et plan d'action (jetons d'intention obligatoires). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Engine } from "../../engine.js";
import { COLUMN_CODES, type ColumnCode } from "../../domain.js";

const Redirect = z.object({
  column: z.enum(COLUMN_CODES as [ColumnCode, ...ColumnCode[]]).optional(), isUrgent: z.boolean().optional(),
  deadlineAt: z.string().nullable().optional(), status: z.string().nullable().optional(), processed: z.boolean().optional(),
  caseId: z.string().nullable().optional(), reason: z.string().optional(),
});

const Outlook = z.discriminatedUnion("op", [
  z.object({ op: z.literal("soft_delete"), messageIds: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("move"), messageIds: z.array(z.string()).min(1), folderExtId: z.string() }),
  z.object({ op: z.literal("undo_move"), messageIds: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("set_categories"), messageIds: z.array(z.string()).min(1), categories: z.array(z.string()) }),
  z.object({ op: z.literal("mark_read"), messageIds: z.array(z.string()).min(1), read: z.boolean() }),
  z.object({ op: z.literal("forward"), messageIds: z.array(z.string()).min(1), to: z.array(z.string().email()).min(1), comment: z.string().optional() }),
  z.object({ op: z.literal("create_draft"), messageIds: z.array(z.string()).min(1), draft: z.object({ to: z.array(z.string()), cc: z.array(z.string()).optional(), subject: z.string(), bodyHtml: z.string() }) }),
  z.object({ op: z.literal("send_draft"), messageIds: z.array(z.string()).min(1), draftExtId: z.string() }),
]);

export async function registerWriteRoutes(app: FastifyInstance, e: Engine) {
  app.patch("/placements/:id", async (req) => {
    const id = (req.params as any).id;
    e.placements.redirect(id, Redirect.parse(req.body));
    return e.repo.getMessage(id);
  });

  app.patch("/placements", async (req) => {
    const { messageIds, ...rest } = z.object({ messageIds: z.array(z.string()).min(1) }).and(Redirect).parse(req.body);
    for (const id of messageIds) e.placements.redirect(id, rest);
    return { ok: true, count: messageIds.length };
  });

  /** Jeton d'intention : émis au moment de la confirmation utilisateur (l'interface le demande). */
  app.post("/intents", async (req) => {
    const { action, targetIds } = z.object({ action: z.string(), targetIds: z.array(z.string()).min(1) }).parse(req.body);
    return e.intents.issue(action, targetIds);
  });

  app.post("/actions/outlook", async (req, reply) => {
    const body = Outlook.parse(req.body);
    const check = e.intents.consume(req.headers["x-guga-intent"] as string | undefined, `outlook.${body.op}`, body.messageIds);
    if (!check.ok) {
      e.audit.record("user", `outlook.${body.op}`, { kind: "message", id: body.messageIds.join(",") }, {}, `refused: ${check.reason}`);
      return reply.code(403).send({ error: check.reason });
    }
    return { results: await e.actions.execute(body) };
  });

  app.post("/actions/external", async (req, reply) => {
    const { adapter, action, targetId } = z.object({ adapter: z.string(), action: z.object({ kind: z.string(), payload: z.record(z.unknown()).default({}) }), targetId: z.string() }).parse(req.body);
    const ad = e.adapters.find((a) => a.name === adapter);
    if (!ad) return reply.code(404).send({ error: "adaptateur inconnu" });
    const prepared = await ad.prepare(action);
    if (ad.capability !== "read_write" || !ad.execute) {
      e.audit.record("user", `external.${adapter}.prepare`, { kind: "message", id: targetId }, { kind: action.kind });
      return { mode: ad.capability, prepared };
    }
    const check = e.intents.consume(req.headers["x-guga-intent"] as string | undefined, `external.${adapter}.${action.kind}`, [targetId]);
    if (!check.ok) return reply.code(403).send({ error: check.reason });
    const res = await ad.execute(prepared);
    e.audit.record("user", `external.${adapter}.${action.kind}`, { kind: "message", id: targetId }, { payload: action.payload }, res.ok ? "ok" : `error: ${res.detail}`);
    return { mode: ad.capability, result: res };
  });
}
