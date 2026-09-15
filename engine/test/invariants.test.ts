/** Invariant C2 : aucune fonction d'écriture n'est atteignable depuis le plan de lecture. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../src");
const READ_PLANE = ["classify", "modules", "normalize", "services/SyncService.ts", "services/PlacementService.ts", "services/Scheduler.ts", "services/JobQueue.ts"];
const FORBIDDEN = [/MailboxWriter/, /GraphWriter/, /FakeWriter/, /ActionService/, /softDelete|sendDraft|createDraft|\.forward\(/];

function walk(p: string): string[] {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  return fs.readdirSync(p).flatMap((f) => walk(path.join(p, f)));
}

describe("invariant « moteur sans écriture » (§14.1)", () => {
  it("n'importe ni ne référence le plan d'action depuis le plan de lecture", () => {
    const offenders: string[] = [];
    for (const rel of READ_PLANE) {
      for (const f of walk(path.join(SRC, rel))) {
        const src = fs.readFileSync(f, "utf8");
        for (const re of FORBIDDEN) if (re.test(src)) offenders.push(`${path.relative(SRC, f)} ~ ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("le connecteur simulé n'exécute aucune écriture pendant sync + classification", async () => {
    const { testEngine, drain } = await import("./helpers.js");
    const e = await testEngine();
    await e.sync.registerMailboxes(); await e.sync.syncAll(); await drain(e);
    expect(e.fakeWriter.log).toEqual([]);
  });
});
