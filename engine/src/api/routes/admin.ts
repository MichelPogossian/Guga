/** Paramétrage, contacts, règles, dossiers, journal d'audit, état, statistiques. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { Engine } from "../../engine.js";
import { dumpRules, parseRules, loadRules } from "../../classify/rules.js";

export async function registerAdminRoutes(app: FastifyInstance, e: Engine) {
  app.get("/status", async () => {
    const last = e.repo.getSetting<{ at: string; path: string } | null>("backup.last", null);
    let free: number | null = null;
    try { const s = fs.statfsSync(e.cfg.dataDir); free = s.bavail * s.bsize; } catch { /* non supporté */ }
    return {
      version: "0.2.0", connector: e.reader.kind, mailboxes: e.repo.listMailboxes(),
      queue: { classify: e.jobs.pending("classify.message"), sync: e.jobs.pending("sync.mailbox") + e.jobs.pending("sync.all") },
      ai: { enabled: e.cfg.ollama.enabled, available: e.ollama?.isAvailable ?? false, model: e.pipeline.activeModel, embedModel: e.pipeline.activeEmbedModel, external: e.cfg.externalAi.enabled },
      diskFree: free, lastBackup: last, dataDir: e.cfg.dataDir, dbEncrypted: e.cfg.dbEncryption.enabled,
      recentErrors: e.db.prepare(`SELECT id, kind, error, created_at FROM job WHERE state='failed' ORDER BY created_at DESC LIMIT 10`).all(),
      messages: (e.db.prepare(`SELECT COUNT(*) AS n FROM message WHERE is_deleted_remote=0`).get() as any).n,
    };
  });

  app.post("/sync", async () => { e.jobs.enqueue("sync.all", {}, { priority: 0, dedupeKey: "sync.all" }); return { ok: true }; });
  app.post("/reclassify/:id", async (req) => { e.jobs.enqueue("classify.message", { messageId: (req.params as any).id }, { priority: 0 }); return { ok: true }; });

  app.get("/audit", async (req) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional(), action: z.string().optional(), targetId: z.string().optional(), limit: z.coerce.number().max(1000).optional(), offset: z.coerce.number().optional() }).parse(req.query);
    return { entries: e.audit.list(q) };
  });
  app.get("/audit/verify", async () => e.audit.verify());
  app.get("/audit/export.csv", async (req, reply) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional(), action: z.string().optional() }).parse(req.query);
    e.audit.record("user", "audit.export", {}, q);
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="guga-journal.csv"');
    return e.audit.exportCsv(q);
  });

  app.get("/settings", async () => ({
    settings: e.repo.allSettings(),
    config: { firmDomain: e.cfg.firmDomain, userAddresses: e.cfg.userAddresses, accountingAddress: e.cfg.accountingAddress, connector: e.cfg.connector,
      syncIntervalMinutes: e.cfg.syncIntervalMinutes, historyYears: e.cfg.historyYears, ribAlertDays: e.cfg.ribAlertDays, ai: e.cfg.ollama, externalAi: e.cfg.externalAi,
      thresholds: e.cfg.thresholds, weights: e.cfg.weights, allowedOutboundDomains: e.cfg.allowedOutboundDomains, dataDir: e.cfg.dataDir },
    columns: e.repo.columns(),
  }));
  app.put("/settings", async (req) => {
    const body = z.record(z.unknown()).parse(req.body);
    for (const [k, v] of Object.entries(body)) e.repo.setSetting(k, v);
    e.audit.record("user", "settings.update", {}, { keys: Object.keys(body) });
    return { ok: true };
  });
  app.get("/settings/filters/:column", async (req) => ({ filter: e.repo.getColumnFilter((req.params as any).column) }));
  app.put("/settings/filters/:column", async (req) => { e.repo.setColumnFilter((req.params as any).column, req.body); return { ok: true }; });

  app.put("/contacts", async (req) => {
    const c = z.object({ id: z.string().optional(), name: z.string().min(1), emails: z.array(z.string()), role: z.enum(["partner", "associate", "opponent", "expert", "client", "clerk", "accounting", "other"]), barId: z.string().optional(), firm: z.string().optional(), phone: z.string().optional() }).parse(req.body);
    const saved = e.repo.upsertContact(c);
    e.audit.record("user", "contact.upsert", { kind: "contact", id: saved.id }, { role: c.role });
    return saved;
  });
  app.delete("/contacts/:id", async (req) => { e.repo.deleteContact((req.params as any).id); e.audit.record("user", "contact.delete", { kind: "contact", id: (req.params as any).id }); return { ok: true }; });

  app.put("/cases", async (req) => {
    const c = z.object({ id: z.string().optional(), secibRef: z.string().min(1), label: z.string().min(1), parties: z.array(z.string()).optional(), counsel: z.array(z.string()).optional(), court: z.string().optional(), hearings: z.array(z.string()).optional() }).parse(req.body);
    return { id: e.repo.upsertCase(c) };
  });
  /** Import Secib par export CSV (D6) : colonnes ref;label;parties;court;hearings (séparateur ; ou ,). */
  app.post("/cases/import", async (req) => {
    const { csv } = z.object({ csv: z.string() }).parse(req.body);
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    const sep = lines[0]?.includes(";") ? ";" : ",";
    let n = 0;
    for (const l of lines.slice(lines[0]?.toLowerCase().startsWith("ref") ? 1 : 0)) {
      const [ref, label, parties, court, hearings] = l.split(sep).map((s) => s.trim().replace(/^"|"$/g, ""));
      if (!ref || !label) continue;
      e.repo.upsertCase({ secibRef: ref, label, parties: parties ? parties.split("|") : [], court, hearings: hearings ? hearings.split("|") : [] });
      n++;
    }
    e.audit.record("user", "cases.import", {}, { count: n });
    return { imported: n };
  });

  app.get("/rules", async () => ({ yaml: dumpRules(e.pipeline.getRules()), rules: e.pipeline.getRules(), suggestions: e.repo.getSetting("rules.suggestions", []) }));
  app.put("/rules", async (req) => {
    const { yaml } = z.object({ yaml: z.string() }).parse(req.body);
    const rs = parseRules(yaml);
    e.pipeline.setRules(rs);
    fs.writeFileSync(path.join(e.cfg.dataDir, "rules.yaml"), yaml);
    e.audit.record("user", "rules.update", {}, { count: rs.rules.length, version: rs.version });
    return { ok: true, count: rs.rules.length };
  });
  app.post("/rules/reset", async () => { e.pipeline.setRules(loadRules()); return { ok: true }; });

  app.get("/stats/accuracy", async () => ({ byColumn: e.placements.accuracy(30), suggestions: e.placements.suggestRules(3) }));
  app.post("/backup", async () => ({ path: await e.scheduler.backup() }));
}
