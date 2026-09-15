/**
 * Composition du moteur : base, connecteurs, pipeline, services, API.
 * `createEngine` est utilisé par le service Windows (index.ts), la CLI et les tests.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDirs, loadConfig, type GugaConfig } from "./config.js";
import { openDatabase, type DB } from "./db/open.js";
import { buildConnectors } from "./connectors/index.js";
import type { MailboxReader, MailboxWriter } from "./connectors/MailboxConnector.js";
import { FileSecretStore, MemorySecretStore, type SecretStore } from "./services/SecretStore.js";
import { OllamaClient } from "./classify/ollama.js";
import { ClassificationPipeline } from "./classify/pipeline.js";
import { Repository } from "./services/Repository.js";
import { AuditService } from "./services/AuditService.js";
import { EventBus } from "./services/EventBus.js";
import { PlacementService } from "./services/PlacementService.js";
import { JobQueue } from "./services/JobQueue.js";
import { IntentService } from "./services/IntentService.js";
import { ActionService } from "./services/ActionService.js";
import { SyncService } from "./services/SyncService.js";
import { Scheduler } from "./services/Scheduler.js";
import { buildAdapters } from "./adapters/index.js";
import { RibService } from "./modules/rib.js";
import { loadCorpus } from "./connectors/FakeConnector.js";
import { logger } from "./logger.js";

export interface Engine {
  cfg: GugaConfig; db: DB; repo: Repository; audit: AuditService; bus: EventBus; placements: PlacementService;
  jobs: JobQueue; intents: IntentService; actions: ActionService; sync: SyncService; scheduler: Scheduler;
  pipeline: ClassificationPipeline; ollama: OllamaClient | null; secrets: SecretStore; rib: RibService;
  reader: MailboxReader; sessionToken: string; adapters: ReturnType<typeof buildAdapters>;
  start(): Promise<void>; stop(): Promise<void>;
}

export interface EngineOptions {
  cfg?: Partial<GugaConfig>;
  memory?: boolean;
  connectors?: { reader: MailboxReader; writer: MailboxWriter };
  secrets?: SecretStore;
  ollama?: OllamaClient | null;
  seedDemo?: boolean;
}

export async function createEngine(opts: EngineOptions = {}): Promise<Engine> {
  const cfg = loadConfig(opts.cfg);
  if (!opts.memory) ensureDirs(cfg);
  const db = openDatabase({ path: cfg.dbPath, encryption: cfg.dbEncryption.enabled, dataDir: cfg.dataDir, memory: opts.memory });
  const secrets = opts.secrets ?? (opts.memory ? new MemorySecretStore() : new FileSecretStore(cfg.dataDir));
  const connectors = opts.connectors ?? (await buildConnectors(cfg, secrets));
  const ollama = opts.ollama !== undefined ? opts.ollama : (cfg.ollama.enabled ? new OllamaClient({ baseUrl: cfg.ollama.baseUrl, timeoutMs: cfg.ollama.timeoutMs }) : null);

  const repo = new Repository(db);
  const audit = new AuditService(db);
  const bus = new EventBus();
  const placements = new PlacementService(db, audit, bus);
  const jobs = new JobQueue(db);
  const intents = new IntentService();
  const adapters = buildAdapters(secrets, cfg.allowedOutboundDomains);
  const pipeline = new ClassificationPipeline({ db, cfg, ollama, contacts: () => repo.listContacts() });
  const sync = new SyncService(db, cfg, connectors.reader, repo, pipeline, placements, jobs, bus, audit, adapters);
  const actions = new ActionService(db, repo, connectors.writer, audit, bus, cfg.accountingAddress);
  const scheduler = new Scheduler(db, cfg, jobs, bus, audit, repo);
  const rib = new RibService(db, audit);

  // Jeton de session API : fichier 0600 lu par l'application Electron (jamais par le renderer).
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  if (!opts.memory) fs.writeFileSync(path.join(cfg.dataDir, "session.token"), sessionToken, { mode: 0o600 });

  if (opts.seedDemo ?? cfg.connector === "fake") seedDemo(repo);

  const engine: Engine = {
    cfg, db, repo, audit, bus, placements, jobs, intents, actions, sync, scheduler, pipeline, ollama, secrets, rib,
    reader: connectors.reader, sessionToken, adapters,
    async start() {
      await sync.registerMailboxes();
      const models = await pipeline.prepareModels();
      logger.info({ connector: connectors.reader.kind, ...models }, "moteur prêt");
      const recovered = jobs.recover();
      if (recovered) logger.info({ recovered }, "jobs repris");
      jobs.start();
      jobs.enqueue("sync.all", {}, { priority: 0, dedupeKey: "sync.all" });
      scheduler.start();
      audit.record("system", "engine.start", {}, { connector: connectors.reader.kind, model: models.model });
    },
    async stop() {
      scheduler.stop();
      jobs.stop();
      audit.record("system", "engine.stop");
      db.close();
    },
  };
  return engine;
}

/** Contacts et dossiers de démonstration (connecteur simulé uniquement). */
function seedDemo(repo: Repository) {
  if (repo.listContacts().length) return;
  const corpus = loadCorpus();
  for (const c of corpus.contacts) repo.upsertContact({ name: c.name, emails: c.emails, role: c.role as any, firm: c.firm, barId: c.barId });
  for (const c of corpus.cases) repo.upsertCase({ secibRef: c.secibRef, label: c.label, parties: c.parties, counsel: c.counsel, court: c.court, hearings: c.hearings });
}
