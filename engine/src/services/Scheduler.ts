/** Tâches planifiées (§3.2, §7.3, §6.2, §13.3) — node-cron in-process. */
import cron from "node-cron";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import type { GugaConfig } from "../config.js";
import type { JobQueue } from "./JobQueue.js";
import type { EventBus } from "./EventBus.js";
import { RibService } from "../modules/rib.js";
import type { AuditService } from "./AuditService.js";
import type { Repository } from "./Repository.js";
import { logger } from "../logger.js";

export class Scheduler {
  private tasks: cron.ScheduledTask[] = [];
  constructor(private db: Database, private cfg: GugaConfig, private jobs: JobQueue, private bus: EventBus, private audit: AuditService, private repo: Repository) {}

  start() {
    const every = Math.max(1, Math.round(this.cfg.syncIntervalMinutes));
    this.tasks.push(cron.schedule(`*/${every} * * * *`, () => this.jobs.enqueue("sync.all", {}, { priority: 3, dedupeKey: "sync.all" })));
    this.tasks.push(cron.schedule("0 8 * * *", () => this.ribAlerts()));
    this.tasks.push(cron.schedule("0 3 * * *", () => { this.backup(); this.purgeAttachments(); this.jobs.purge(); }));
    this.tasks.push(cron.schedule("0 7 * * 1", () => this.weeklyRuleSuggestions()));
    logger.info({ every }, "ordonnanceur démarré");
  }
  stop() { for (const t of this.tasks) t.stop(); this.tasks = []; }

  ribAlerts() {
    const rib = new RibService(this.db, this.audit);
    const perStatus = this.repo.getSetting<Record<string, number>>("rib.alert_days_per_status", {});
    const stale = rib.stale(this.cfg.ribAlertDays, perStatus);
    this.repo.setSetting("rib.stale", stale);
    this.bus.publish({ type: "alert", kind: "rib.stale", count: stale.length });
    return stale;
  }

  /** Snapshot cohérent de la base (API de sauvegarde SQLite), rétention 14 jours. */
  async backup(): Promise<string | null> {
    try {
      fs.mkdirSync(this.cfg.backupsDir, { recursive: true });
      const dest = path.join(this.cfg.backupsDir, `guga-${new Date().toISOString().slice(0, 10)}.db`);
      await this.db.backup(dest);
      for (const f of fs.readdirSync(this.cfg.backupsDir)) {
        const p = path.join(this.cfg.backupsDir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86_400_000) fs.unlinkSync(p);
      }
      const secondary = this.repo.getSetting<string | null>("backup.secondary_dir", null);
      if (secondary && fs.existsSync(secondary)) fs.copyFileSync(dest, path.join(secondary, path.basename(dest)));
      this.repo.setSetting("backup.last", { at: new Date().toISOString(), path: dest });
      this.audit.record("system", "backup.create", {}, { path: dest });
      return dest;
    } catch (e) {
      logger.error({ err: String(e) }, "sauvegarde échouée");
      return null;
    }
  }

  purgeAttachments() {
    const limit = new Date(Date.now() - this.cfg.attachmentRetentionDays * 86_400_000).toISOString();
    const rows = this.db.prepare(`SELECT id, cache_path FROM attachment WHERE cache_path IS NOT NULL AND cached_at < ?`).all(limit) as any[];
    for (const r of rows) {
      try { if (r.cache_path && fs.existsSync(r.cache_path)) fs.unlinkSync(r.cache_path); } catch { /* ignore */ }
      this.db.prepare(`UPDATE attachment SET cache_path=NULL, cached_at=NULL WHERE id=?`).run(r.id);
    }
  }

  weeklyRuleSuggestions() {
    const rows = this.db.prepare(`SELECT substr(m.from_addr, instr(m.from_addr,'@')+1) AS domain, f.corrected_column AS col, COUNT(*) AS n
      FROM ai_feedback f JOIN message m ON m.id=f.message_id WHERE f.at >= ? GROUP BY domain, col HAVING n >= 3 ORDER BY n DESC`)
      .all(new Date(Date.now() - 30 * 86_400_000).toISOString()) as any[];
    this.repo.setSetting("rules.suggestions", rows.map((r) => ({ id: `suggested.${r.domain}.${r.col}`.toLowerCase(), column: r.col, score: 0.8, when: { from_domain: r.domain }, count: r.n })));
  }
}
