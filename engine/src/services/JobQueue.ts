/** File de tâches persistée en SQLite (§3.2) : reprise après redémarrage, priorités, tentatives. */
import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import { logger } from "../logger.js";

export interface Job { id: string; kind: string; payload: Record<string, unknown>; priority: number; attempts: number }
export type JobHandler = (job: Job) => Promise<void>;

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  constructor(private db: Database, private concurrency = 1) {}

  register(kind: string, h: JobHandler) { this.handlers.set(kind, h); }

  enqueue(kind: string, payload: Record<string, unknown> = {}, opts: { priority?: number; runAfter?: Date; dedupeKey?: string } = {}): string {
    if (opts.dedupeKey) {
      const dup = this.db.prepare(`SELECT id FROM job WHERE kind=? AND state='pending' AND json_extract(payload_json,'$.dedupeKey')=?`).get(kind, opts.dedupeKey) as { id: string } | undefined;
      if (dup) return dup.id;
      payload = { ...payload, dedupeKey: opts.dedupeKey };
    }
    const id = ulid();
    this.db.prepare(`INSERT INTO job(id,kind,payload_json,priority,state,attempts,run_after,created_at) VALUES (?,?,?,?,'pending',0,?,?)`)
      .run(id, kind, JSON.stringify(payload), opts.priority ?? 5, (opts.runAfter ?? new Date()).toISOString(), new Date().toISOString());
    this.wake?.();
    return id;
  }

  pending(kind?: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM job WHERE state IN ('pending','running') ${kind ? "AND kind=?" : ""}`).get(...(kind ? [kind] : [])) as { n: number }).n;
  }

  /** Au démarrage : les jobs restés « running » (arrêt brutal) repassent en attente. */
  recover(): number {
    return this.db.prepare(`UPDATE job SET state='pending' WHERE state='running'`).run().changes;
  }

  purge(days = 7) {
    this.db.prepare(`DELETE FROM job WHERE state IN ('done','failed') AND created_at < ?`).run(new Date(Date.now() - days * 86_400_000).toISOString());
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }
  stop() { this.running = false; if (this.timer) clearTimeout(this.timer); this.wake?.(); }

  private async loop() {
    while (this.running) {
      const job = this.pick();
      if (!job) { await this.sleep(1500); continue; }
      const h = this.handlers.get(job.kind);
      if (!h) { this.finish(job.id, "failed", `aucun gestionnaire pour ${job.kind}`); continue; }
      try {
        await h(job);
        this.finish(job.id, "done");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn({ job: job.kind, id: job.id, attempts: job.attempts, err: msg }, "job échoué");
        if (job.attempts >= 5) this.finish(job.id, "failed", msg);
        else {
          const delay = Math.min(15 * 60_000, 2 ** job.attempts * 5000);
          this.db.prepare(`UPDATE job SET state='pending', run_after=?, error=? WHERE id=?`).run(new Date(Date.now() + delay).toISOString(), msg, job.id);
        }
      }
    }
  }

  private pick(): Job | null {
    const tx = this.db.transaction(() => {
      const r = this.db.prepare(`SELECT * FROM job WHERE state='pending' AND run_after<=? ORDER BY priority ASC, created_at ASC LIMIT 1`).get(new Date().toISOString()) as any;
      if (!r) return null;
      this.db.prepare(`UPDATE job SET state='running', attempts=attempts+1 WHERE id=?`).run(r.id);
      return { id: r.id, kind: r.kind, payload: JSON.parse(r.payload_json), priority: r.priority, attempts: r.attempts + 1 } as Job;
    });
    return tx();
  }
  private finish(id: string, state: "done" | "failed", error?: string) {
    this.db.prepare(`UPDATE job SET state=?, error=? WHERE id=?`).run(state, error ?? null, id);
  }
  private sleep(ms: number) { return new Promise<void>((r) => { this.wake = r; this.timer = setTimeout(r, ms); }); }
}
