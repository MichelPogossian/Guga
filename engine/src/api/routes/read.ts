/** Plan de lecture : colonnes, messages, recherche, fiche, flux SSE. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Engine } from "../../engine.js";
import { RibService } from "../../modules/rib.js";

const ListQuery = z.object({
  column: z.string().optional(), q: z.string().optional(), urgent: z.coerce.boolean().optional(), status: z.string().optional(),
  processed: z.enum(["0", "1"]).optional(), toConfirm: z.coerce.boolean().optional(), from: z.string().optional(), mailboxId: z.string().optional(),
  since: z.string().optional(), until: z.string().optional(), hasAttachments: z.coerce.boolean().optional(), caseId: z.string().optional(),
  fromColumn: z.string().optional(), sort: z.enum(["received_desc", "received_asc", "deadline"]).optional(),
  limit: z.coerce.number().min(1).max(1000).optional(), offset: z.coerce.number().min(0).optional(),
});

export async function registerReadRoutes(app: FastifyInstance, e: Engine) {
  app.get("/columns", async () => {
    const cols = e.repo.columns();
    const stale = e.repo.getSetting<{ messageId: string }[]>("rib.stale", []);
    const alerts = (e.db.prepare(`SELECT COUNT(*) AS n FROM procedural_alert WHERE acknowledged=0`).get() as { n: number }).n;
    const onlyRecipient = (e.db.prepare(`SELECT COUNT(*) AS n FROM placement WHERE column_code='CONTACT' AND processed=0 AND json_extract(evidence_json,'$.onlyRecipientAlert')=1`).get() as { n: number }).n;
    for (const c of cols) {
      if (c.code === "RIB") c.alerts = stale.length;
      if (c.code === "PROCEDURE") c.alerts = alerts;
      if (c.code === "CONTACT") c.alerts = onlyRecipient;
    }
    return { columns: cols, backlog: e.jobs.pending("classify.message"), mailboxes: e.repo.listMailboxes() };
  });

  app.get("/messages", async (req) => {
    const q = ListQuery.parse(req.query);
    return e.repo.listMessages({ ...q, processed: q.processed === undefined ? undefined : q.processed === "1" });
  });

  app.get("/search", async (req) => {
    const { q, limit } = z.object({ q: z.string().min(1), limit: z.coerce.number().max(500).optional() }).parse(req.query);
    return { items: e.repo.search(q, limit ?? 100) };
  });

  app.get("/messages/:id", async (req, reply) => {
    const m = e.repo.getMessage((req.params as any).id);
    if (!m) return reply.code(404).send({ error: "introuvable" });
    return m;
  });

  app.get("/messages/:id/attachments/:attId", async (req, reply) => {
    const { id, attId } = req.params as any;
    const att = e.db.prepare(`SELECT * FROM attachment WHERE id=? AND message_id=?`).get(attId, id) as any;
    if (!att) return reply.code(404).send({ error: "pièce introuvable" });
    const msg = e.repo.messageRaw(id);
    const mb = e.repo.getMailbox(msg.mailbox_id)!;
    const buf = await e.reader.fetchAttachment(mb, msg.ext_id, att.ext_id);
    e.audit.record("user", "attachment.view", { kind: "attachment", id: attId }, { name: att.name });
    reply.header("content-type", att.mime ?? "application/octet-stream").header("content-disposition", `inline; filename="${encodeURIComponent(att.name)}"`);
    return reply.send(buf);
  });

  app.get("/cases", async () => ({ cases: e.repo.listCases() }));
  app.get("/contacts", async () => ({ contacts: e.repo.listContacts() }));
  app.get("/rib/stale", async () => ({ stale: new RibService(e.db, e.audit).stale(e.cfg.ribAlertDays, e.repo.getSetting("rib.alert_days_per_status", {})) }));
  app.get("/alerts", async () => ({
    procedural: e.db.prepare(`SELECT pa.*, m.subject FROM procedural_alert pa JOIN message m ON m.id=pa.message_id WHERE pa.acknowledged=0 ORDER BY pa.due_at`).all(),
    rib: e.repo.getSetting("rib.stale", []),
  }));

  // Flux SSE temps réel
  app.get("/events", (req, reply) => {
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ backlog: e.jobs.pending("classify.message") })}\n\n`);
    const unsub = e.bus.subscribe((ev) => reply.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000);
    req.raw.on("close", () => { unsub(); clearInterval(ping); });
  });
}
