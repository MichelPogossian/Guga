import { describe, it, expect } from "vitest";
import { testEngine, drain } from "./helpers.js";
import { loadCorpus } from "../src/connectors/FakeConnector.js";
import { toBlob } from "../src/classify/similarity.js";

describe("pipeline de classification sans LLM (règles + garde-fous)", () => {
  it("place chaque message du corpus dans la colonne attendue (précision ≥ 90 %)", async () => {
    const e = await testEngine();
    await e.sync.registerMailboxes();
    await e.sync.syncAll();
    await drain(e);
    const corpus = loadCorpus();
    const rows = e.db.prepare(`SELECT m.ext_id, p.column_code, p.confidence, p.to_confirm FROM message m JOIN placement p ON p.message_id=m.id`).all() as any[];
    expect(rows.length).toBe(corpus.messages.length);
    const errors: string[] = [];
    for (const r of rows) {
      const idx = Number(r.ext_id.replace("fake-", ""));
      const exp = corpus.messages[idx].expected;
      if (exp && exp !== r.column_code) errors.push(`${idx} « ${corpus.messages[idx].subject} » attendu ${exp}, obtenu ${r.column_code} (${r.confidence})`);
    }
    if (errors.length) console.log(errors.join("\n"));
    expect(errors.length / rows.length).toBeLessThanOrEqual(0.1);
  });

  it("respecte la contrainte dure : jamais CC si l'utilisatrice est en To", async () => {
    const e = await testEngine();
    await e.sync.registerMailboxes(); await e.sync.syncAll(); await drain(e);
    const bad = e.db.prepare(`SELECT m.subject FROM message m JOIN placement p ON p.message_id=m.id WHERE p.column_code='CC' AND m.to_json LIKE '%assistante@cabinet-exemple.fr%'`).all();
    expect(bad).toEqual([]);
  });

  it("n'oublie aucun message : chaque message a un placement, avec échéance et urgence pour les instructions", async () => {
    const e = await testEngine();
    await e.sync.registerMailboxes(); await e.sync.syncAll(); await drain(e);
    const orphan = e.db.prepare(`SELECT COUNT(*) AS n FROM message m LEFT JOIN placement p ON p.message_id=m.id WHERE p.message_id IS NULL`).get() as any;
    expect(orphan.n).toBe(0);
    const urgent = e.db.prepare(`SELECT p.is_urgent, p.deadline_at FROM message m JOIN placement p ON p.message_id=m.id WHERE m.subject LIKE 'URGENT — conclusions%'`).get() as any;
    expect(urgent.is_urgent).toBe(1);
    expect(urgent.deadline_at).toMatch(/T12:00$/);
  });

  it("rattache un e-mail en copie au dossier Secib par référence et parties", async () => {
    const e = await testEngine();
    await e.sync.registerMailboxes(); await e.sync.syncAll(); await drain(e);
    const r = e.db.prepare(`SELECT p.status, cr.secib_ref FROM message m JOIN placement p ON p.message_id=m.id LEFT JOIN case_ref cr ON cr.id=p.case_id WHERE m.subject LIKE 'BATIMO / SOCOTRA — Dossier 2024-0187%'`).get() as any;
    expect(r.status).toBe("RATTACHE");
    expect(r.secib_ref).toBe("2024-0187");
  });

  it("détecte une alerte procédurale avec preuve et échéance", async () => {
    const e = await testEngine();
    await e.sync.registerMailboxes(); await e.sync.syncAll(); await drain(e);
    const a = e.db.prepare(`SELECT pa.* FROM procedural_alert pa JOIN message m ON m.id=pa.message_id WHERE m.subject LIKE 'Signification de conclusions%'`).all() as any[];
    expect(a.length).toBeGreaterThan(0);
    expect(a[0].due_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(a[0].evidence.length).toBeGreaterThan(10);
  });

  it("extrait les parties et le RCS d'une assignation, verdict PENDING sans adaptateur", async () => {
    const e = await testEngine();
    await e.sync.registerMailboxes(); await e.sync.syncAll(); await drain(e);
    const r = e.db.prepare(`SELECT n.* FROM new_case_check n JOIN message m ON m.id=n.message_id WHERE m.subject LIKE 'Signification d''une assignation%'`).get() as any;
    expect(r.verdict).toBe("PENDING");
    const parties = JSON.parse(r.extracted_json).parties;
    expect(parties.map((p: any) => p.siren)).toEqual(["512345678", "798654321"]);
    expect(parties[0].counsel).toBe("Me Paul Vasseur");
  });
});

describe("apprentissage à partir des corrections (§6.2)", () => {
  it("une redirection manuelle écrit ai_feedback et pèse dans le vote k-NN", async () => {
    const e = await testEngine();
    await e.sync.registerMailboxes(); await e.sync.syncAll(); await drain(e);
    const m = e.db.prepare(`SELECT m.id FROM message m JOIN placement p ON p.message_id=m.id WHERE p.column_code='PUBS' LIMIT 1`).get() as any;
    e.placements.redirect(m.id, { column: "CONTACT", reason: "Ce n'est pas une pub" });
    expect((e.db.prepare(`SELECT COUNT(*) AS n FROM ai_feedback WHERE message_id=?`).get(m.id) as any).n).toBe(1);
    expect((e.db.prepare(`SELECT source, column_code FROM placement WHERE message_id=?`).get(m.id) as any)).toEqual({ source: "user", column_code: "CONTACT" });
    // Simule des embeddings : le message corrigé et un nouveau message très proche.
    const v = Float32Array.from([1, 0, 0, 0]);
    e.db.prepare(`INSERT INTO message_vec(message_id, dim, embedding) VALUES (?,?,?)`).run(m.id, 4, toBlob(v));
    const { nearestNeighbors, knnVote } = await import("../src/classify/similarity.js");
    const vote = knnVote(nearestNeighbors(e.db, Float32Array.from([0.99, 0.1, 0, 0]), 15));
    expect(vote.scores.CONTACT).toBeCloseTo(1, 3);
    // Un reclassement IA ne remplace pas un placement validé par l'utilisatrice.
    await e.sync.classifyMessage(m.id);
    expect((e.db.prepare(`SELECT column_code FROM placement WHERE message_id=?`).get(m.id) as any).column_code).toBe("CONTACT");
  });
});
