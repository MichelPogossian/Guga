import { describe, it, expect } from "vitest";
import { testEngine, drain } from "./helpers.js";
import { buildServer } from "../src/api/server.js";

async function ready() {
  const e = await testEngine();
  await e.sync.registerMailboxes(); await e.sync.syncAll(); await drain(e);
  const app = await buildServer(e);
  const h = { authorization: `Bearer ${e.sessionToken}` };
  return { e, app, h };
}

describe("API locale (§9, §10.2, C2)", () => {
  it("refuse sans jeton de session", async () => {
    const { app } = await ready();
    const r = await app.inject({ method: "GET", url: "/columns" });
    expect(r.statusCode).toBe(401);
  });
  it("liste les colonnes avec compteurs et recherche plein texte", async () => {
    const { app, h } = await ready();
    const cols = (await app.inject({ method: "GET", url: "/columns", headers: h })).json();
    expect(cols.columns.length).toBe(12);
    expect(cols.columns.find((c: any) => c.code === "PUBS").total).toBeGreaterThan(0);
    const s = (await app.inject({ method: "GET", url: "/search?q=batimo", headers: h })).json();
    expect(s.items.length).toBeGreaterThan(2);
    const l = (await app.inject({ method: "GET", url: "/messages?column=PUBS", headers: h })).json();
    expect(l.total).toBe(3);
  });
  it("refuse et journalise une action Outlook sans jeton d'intention (§14.2)", async () => {
    const { app, h, e } = await ready();
    const id = (e.db.prepare(`SELECT message_id FROM placement WHERE column_code='PUBS' LIMIT 1`).get() as any).message_id;
    const r = await app.inject({ method: "POST", url: "/actions/outlook", headers: h, payload: { op: "soft_delete", messageIds: [id] } });
    expect(r.statusCode).toBe(403);
    expect(e.fakeWriter.log).toEqual([]);
    const log = e.audit.list({ action: "outlook.soft_delete" });
    expect(log[0].result).toMatch(/refused/);
  });
  it("exécute une suppression douce avec jeton d'intention à usage unique, journalisée", async () => {
    const { app, h, e } = await ready();
    const id = (e.db.prepare(`SELECT message_id FROM placement WHERE column_code='PUBS' LIMIT 1`).get() as any).message_id;
    const intent = (await app.inject({ method: "POST", url: "/intents", headers: h, payload: { action: "outlook.soft_delete", targetIds: [id] } })).json();
    const r = await app.inject({ method: "POST", url: "/actions/outlook", headers: { ...h, "x-guga-intent": intent.token }, payload: { op: "soft_delete", messageIds: [id] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().results[0].ok).toBe(true);
    expect(e.fakeWriter.log[0].op).toBe("softDelete");
    expect(e.audit.list({ action: "outlook.soft_delete" })[0].result).toBe("ok");
    // Réutilisation refusée
    const again = await app.inject({ method: "POST", url: "/actions/outlook", headers: { ...h, "x-guga-intent": intent.token }, payload: { op: "soft_delete", messageIds: [id] } });
    expect(again.statusCode).toBe(403);
    // Le message disparaît des listes
    expect((await app.inject({ method: "GET", url: "/messages?column=PUBS", headers: h })).json().total).toBe(2);
    expect(e.audit.verify().ok).toBe(true);
  });
  it("refuse la suppression dans une colonne qui ne l'autorise pas", async () => {
    const { app, h, e } = await ready();
    const id = (e.db.prepare(`SELECT message_id FROM placement WHERE column_code='INSTR_ASSOC' LIMIT 1`).get() as any).message_id;
    const intent = (await app.inject({ method: "POST", url: "/intents", headers: h, payload: { action: "outlook.soft_delete", targetIds: [id] } })).json();
    const r = await app.inject({ method: "POST", url: "/actions/outlook", headers: { ...h, "x-guga-intent": intent.token }, payload: { op: "soft_delete", messageIds: [id] } });
    expect(r.json().results[0].ok).toBe(false);
    expect(r.json().results[0].detail).toMatch(/n'autorise pas/);
  });
  it("redirige en une opération (colonne + urgent + échéance) et conserve l'historique", async () => {
    const { app, h, e } = await ready();
    const id = (e.db.prepare(`SELECT message_id FROM placement WHERE column_code='CONTACT' LIMIT 1`).get() as any).message_id;
    const r = await app.inject({ method: "PATCH", url: `/placements/${id}`, headers: h, payload: { column: "INSTR_COLLAB", isUrgent: true, deadlineAt: "2026-09-20" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().placement).toMatchObject({ column: "INSTR_COLLAB", isUrgent: true, deadlineAt: "2026-09-20", redirectedFrom: "CONTACT" });
    const filtered = (await app.inject({ method: "GET", url: "/messages?fromColumn=CONTACT", headers: h })).json();
    expect(filtered.items.some((m: any) => m.id === id)).toBe(true);
  });
  it("transfert à la comptabilité depuis CLAIRE", async () => {
    const { app, h, e } = await ready();
    const id = (e.db.prepare(`SELECT message_id FROM placement WHERE column_code='CLAIRE' LIMIT 1`).get() as any).message_id;
    const intent = (await app.inject({ method: "POST", url: "/intents", headers: h, payload: { action: "outlook.forward", targetIds: [id] } })).json();
    const r = await app.inject({ method: "POST", url: "/actions/outlook", headers: { ...h, "x-guga-intent": intent.token }, payload: { op: "forward", messageIds: [id], to: ["compta@cabinet-exemple.fr"], comment: "Pour traitement" } });
    expect(r.json().results[0].ok).toBe(true);
    expect((e.db.prepare(`SELECT status FROM placement WHERE message_id=?`).get(id) as any).status).toBe("TRANSFERE_COMPTA");
  });
  it("modules phases 5–6 répondent 501 explicitement", async () => {
    const { app, h } = await ready();
    expect((await app.inject({ method: "POST", url: "/modules/hearing-pack/x/generate", headers: h })).statusCode).toBe(501);
  });
});
