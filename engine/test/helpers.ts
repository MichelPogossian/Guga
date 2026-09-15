import { createEngine, type Engine } from "../src/engine.js";
import { FakeConnector, FakeWriter } from "../src/connectors/FakeConnector.js";

export async function testEngine(extra: Parameters<typeof createEngine>[0] = {}): Promise<Engine & { fake: FakeConnector; fakeWriter: FakeWriter }> {
  const fake = new FakeConnector();
  const fakeWriter = new FakeWriter(fake);
  const e = await createEngine({ memory: true, connectors: { reader: fake, writer: fakeWriter }, ollama: null, seedDemo: true,
    cfg: { connector: "fake", dataDir: "/tmp/guga-test", ollama: { enabled: false, baseUrl: "", model: "", embedModel: "", timeoutMs: 1 } as any, ...(extra.cfg ?? {}) }, ...extra });
  return Object.assign(e, { fake, fakeWriter });
}

/** Exécute tous les jobs de classification en attente, sans la boucle asynchrone. */
export async function drain(e: Engine): Promise<void> {
  for (;;) {
    const row = e.db.prepare(`SELECT id, kind, payload_json FROM job WHERE state='pending' ORDER BY priority, created_at LIMIT 1`).get() as any;
    if (!row) return;
    e.db.prepare(`UPDATE job SET state='running' WHERE id=?`).run(row.id);
    const p = JSON.parse(row.payload_json);
    if (row.kind === "classify.message") await e.sync.classifyMessage(p.messageId);
    else if (row.kind === "sync.all") await e.sync.syncAll();
    else if (row.kind === "sync.mailbox") await e.sync.syncMailbox(p.mailboxId);
    e.db.prepare(`UPDATE job SET state='done' WHERE id=?`).run(row.id);
  }
}
