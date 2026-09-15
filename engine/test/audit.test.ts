import { describe, it, expect } from "vitest";
import { testEngine } from "./helpers.js";

describe("journal d'audit (§11)", () => {
  it("chaîne les hachages et se vérifie", async () => {
    const e = await testEngine();
    e.audit.record("user", "test.one", { kind: "x", id: "1" }, { a: 1 });
    e.audit.record("user", "test.two", { kind: "x", id: "2" }, { b: 2 });
    expect(e.audit.verify()).toMatchObject({ ok: true });
    const rows = e.audit.list({ limit: 10 });
    expect(rows[0].prev_hash).toBe(rows[1].hash);
  });
  it("interdit UPDATE et DELETE", async () => {
    const e = await testEngine();
    e.audit.record("user", "test", {}, {});
    expect(() => e.db.prepare(`UPDATE action_log SET result='x' WHERE seq=2`).run()).toThrow(/ajout seul/);
    expect(() => e.db.prepare(`DELETE FROM action_log WHERE seq=2`).run()).toThrow(/ajout seul/);
  });
  it("exporte un CSV signé", async () => {
    const e = await testEngine();
    const csv = e.audit.exportCsv();
    expect(csv).toMatch(/^seq,at,actor/);
    expect(csv).toMatch(/# sha256=[0-9a-f]{64}/);
  });
});
