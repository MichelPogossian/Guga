/** Migrations SQL numérotées appliquées au démarrage (§5), table schema_version. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));

export function migrate(db: Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set<number>(db.prepare(`SELECT version FROM schema_version`).all().map((r: any) => r.version));
  const dir = path.join(here, "migrations");
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  let last = 0;
  for (const f of files) {
    const v = Number(f.split("_")[0]);
    last = Math.max(last, v);
    if (applied.has(v)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO schema_version(version, applied_at) VALUES (?, ?)`).run(v, new Date().toISOString());
    });
    tx();
  }
  return last;
}
