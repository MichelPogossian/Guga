/** guga-cli : diagnostic, resynchronisation, audit, sauvegarde/restauration (§3.3, §11, §13.3). */
import fs from "node:fs";
import path from "node:path";
import { createEngine } from "./engine.js";
import { loadConfig } from "./config.js";

const [cmd, sub, arg] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "audit": {
      const e = await createEngine({ cfg: { connector: "fake" } });
      if (sub === "verify") console.log(JSON.stringify(e.audit.verify()));
      else if (sub === "export") { const out = arg ?? "guga-journal.csv"; fs.writeFileSync(out, e.audit.exportCsv()); console.log(`journal exporté : ${out}`); }
      else console.log(JSON.stringify(e.audit.list({ limit: 50 }), null, 2));
      e.db.close();
      break;
    }
    case "resync": {
      const e = await createEngine();
      const boxes = await e.sync.registerMailboxes();
      for (const mb of boxes) { e.repo.saveDeltaState(mb.id, {}); const r = await e.sync.syncMailbox(mb.id); console.log(mb.label, r); }
      await e.pipeline.prepareModels();
      let job; while ((job = e.jobs.pending("classify.message")) > 0) { console.log(`classification : ${job} restant(s)`); await runOnce(e); }
      e.db.close();
      break;
    }
    case "backup": { const e = await createEngine(); console.log(await e.scheduler.backup()); e.db.close(); break; }
    case "restore": {
      if (!sub) throw new Error("usage : guga-cli restore <fichier>");
      const cfg = loadConfig();
      fs.copyFileSync(sub, cfg.dbPath);
      for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(cfg.dbPath + suffix)) fs.unlinkSync(cfg.dbPath + suffix);
      console.log(`base restaurée depuis ${sub} ; lancez « guga-cli resync » pour le rattrapage`);
      break;
    }
    case "status": {
      const e = await createEngine();
      console.log(JSON.stringify({ dataDir: e.cfg.dataDir, connector: e.reader.kind, mailboxes: e.repo.listMailboxes(), columns: e.repo.columns(), ai: await e.pipeline.prepareModels() }, null, 2));
      e.db.close();
      break;
    }
    default:
      console.log(`guga-cli <commande>
  status                 état du moteur, boîtes, colonnes, modèle IA
  resync                 resynchronisation complète et reclassement
  audit [verify|export]  consulter / vérifier la chaîne / exporter en CSV signé
  backup                 snapshot chiffré de la base
  restore <fichier>      restauration d'un snapshot`);
  }
}

async function runOnce(e: Awaited<ReturnType<typeof createEngine>>) {
  const row = e.db.prepare(`SELECT id, payload_json FROM job WHERE kind='classify.message' AND state='pending' ORDER BY priority LIMIT 1`).get() as any;
  if (!row) return;
  e.db.prepare(`UPDATE job SET state='running' WHERE id=?`).run(row.id);
  try { await e.sync.classifyMessage(JSON.parse(row.payload_json).messageId); e.db.prepare(`UPDATE job SET state='done' WHERE id=?`).run(row.id); }
  catch (err) { e.db.prepare(`UPDATE job SET state='failed', error=? WHERE id=?`).run(String(err), row.id); }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
void path;
