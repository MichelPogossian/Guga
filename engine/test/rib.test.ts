import { describe, it, expect } from "vitest";
import { testEngine, drain } from "./helpers.js";
import { isNominal } from "../src/modules/rib.js";

describe("RIB CARPA — machine à états (§7.3)", () => {
  it("connaît les transitions nominales", () => {
    expect(isNominal("A_EDITER", "A_VERIFIER")).toBe(true);
    expect(isNominal("EN_ATTENTE", "A_ENVOYER_AVEC_PROTOCOLE")).toBe(true);
    expect(isNominal("ENVOYE", "A_EDITER")).toBe(false);
  });
  it("journalise les transitions, y compris forcées", async () => {
    const e = await testEngine();
    await e.sync.registerMailboxes(); await e.sync.syncAll(); await drain(e);
    const rib = e.db.prepare(`SELECT message_id, recipient_kind FROM rib_request`).all() as any[];
    expect(rib.length).toBeGreaterThanOrEqual(1);
    const opp = rib.find((r) => r.recipient_kind === "opponent");
    expect(opp).toBeTruthy(); // « adresser à Me Vasseur (confrère adverse) »
    expect(e.rib.transition(opp.message_id, "A_VERIFIER")).toEqual({ forced: false });
    expect(e.rib.transition(opp.message_id, "A_EDITER")).toEqual({ forced: true });
    const log = e.audit.list({ action: "rib.transition" });
    expect(log.length).toBe(2);
    expect(JSON.parse(log[0].payload_json).forced).toBe(true);
  });
  it("détecte les demandes stagnantes", async () => {
    const e = await testEngine();
    await e.sync.registerMailboxes(); await e.sync.syncAll(); await drain(e);
    e.db.prepare(`UPDATE rib_request SET status_since=?`).run(new Date(Date.now() - 5 * 86_400_000).toISOString());
    expect(e.rib.stale(3).length).toBeGreaterThan(0);
    expect(e.rib.stale(10).length).toBe(0);
  });
});
