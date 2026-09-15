/**
 * Configuration du moteur Guga (CDC technique §3.3, §10).
 * Les paramètres non secrets viennent de config.toml (format clé = valeur simplifié)
 * et peuvent être surchargés par variables d'environnement GUGA_*.
 * Les secrets (jetons Graph, clés API) ne passent JAMAIS par ce fichier.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ConnectorKind = "fake" | "graph" | "imap";

export interface GugaConfig {
  dataDir: string;
  dbPath: string;
  attachmentsDir: string;
  generatedDir: string;
  logsDir: string;
  backupsDir: string;
  apiHost: string;
  apiPort: number;
  connector: ConnectorKind;
  syncIntervalMinutes: number;
  ollama: { baseUrl: string; enabled: boolean; model: string; embedModel: string; timeoutMs: number };
  externalAi: { enabled: boolean };
  firmDomain: string;
  userAddresses: string[];
  accountingAddress: string;
  historyYears: number;
  attachmentRetentionDays: number;
  ribAlertDays: number;
  allowedOutboundDomains: string[];
  dbEncryption: { enabled: boolean };
  weights: { rules: number; similarity: number; llm: number };
  thresholds: { skipLlm: number; minConfidence: number; caseLink: number; caseLinkGap: number };
}

function defaultDataDir(): string {
  if (process.env.GUGA_DATA_DIR) return process.env.GUGA_DATA_DIR;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "Guga");
  return path.join(os.homedir(), ".guga");
}

/** Lecture minimaliste d'un fichier TOML plat (clé = valeur, sections [a.b]). */
export function parseToml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) { section = sec[1].trim(); continue; }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = section ? `${section}.${kv[1]}` : kv[1];
    out[key] = parseTomlValue(kv[2].trim());
  }
  return out;
}

function parseTomlValue(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("[")) {
    const inner = v.slice(1, v.lastIndexOf("]"));
    return inner.split(",").map((s) => s.trim()).filter(Boolean).map(parseTomlValue);
  }
  return v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

export function loadConfig(overrides: Partial<GugaConfig> = {}): GugaConfig {
  const dataDir = overrides.dataDir ?? defaultDataDir();
  const tomlPath = path.join(dataDir, "config.toml");
  const t: Record<string, unknown> = fs.existsSync(tomlPath) ? parseToml(fs.readFileSync(tomlPath, "utf8")) : {};
  const env = (k: string) => process.env[`GUGA_${k}`];
  const str = (key: string, envKey: string, def: string) => (env(envKey) ?? (t[key] as string | undefined) ?? def);
  const num = (key: string, envKey: string, def: number) => Number(env(envKey) ?? (t[key] as number | undefined) ?? def);
  const bool = (key: string, envKey: string, def: boolean) => {
    const e = env(envKey);
    if (e !== undefined) return e === "1" || e === "true";
    return (t[key] as boolean | undefined) ?? def;
  };
  const list = (key: string, envKey: string, def: string[]) => {
    const e = env(envKey);
    if (e) return e.split(",").map((s) => s.trim()).filter(Boolean);
    return (t[key] as string[] | undefined) ?? def;
  };

  const cfg: GugaConfig = {
    dataDir,
    dbPath: path.join(dataDir, "guga.db"),
    attachmentsDir: path.join(dataDir, "attachments"),
    generatedDir: path.join(dataDir, "generated"),
    logsDir: path.join(dataDir, "logs"),
    backupsDir: path.join(dataDir, "backups"),
    apiHost: "127.0.0.1",
    apiPort: num("api.port", "API_PORT", 8765),
    connector: str("connector", "CONNECTOR", "fake") as ConnectorKind,
    syncIntervalMinutes: num("sync.interval_minutes", "SYNC_INTERVAL", 2),
    ollama: {
      baseUrl: str("ai.ollama_url", "OLLAMA_URL", "http://127.0.0.1:11434"),
      enabled: bool("ai.enabled", "AI_ENABLED", true),
      model: str("ai.model", "AI_MODEL", "qwen2.5:7b"),
      embedModel: str("ai.embed_model", "AI_EMBED_MODEL", "bge-m3"),
      timeoutMs: num("ai.timeout_ms", "AI_TIMEOUT", 120_000),
    },
    externalAi: { enabled: bool("ai.external_enabled", "AI_EXTERNAL", false) },
    firmDomain: str("firm.domain", "FIRM_DOMAIN", "cabinet-exemple.fr"),
    userAddresses: list("firm.user_addresses", "USER_ADDRESSES", ["assistante@cabinet-exemple.fr"]),
    accountingAddress: str("firm.accounting_address", "ACCOUNTING_ADDRESS", "compta@cabinet-exemple.fr"),
    historyYears: num("sync.history_years", "HISTORY_YEARS", 3),
    attachmentRetentionDays: num("cache.attachment_retention_days", "ATT_RETENTION", 90),
    ribAlertDays: num("rib.alert_days", "RIB_ALERT_DAYS", 3),
    allowedOutboundDomains: list("network.allowed_domains", "ALLOWED_DOMAINS", [
      "graph.microsoft.com", "login.microsoftonline.com", "api.pappers.fr",
    ]),
    dbEncryption: { enabled: bool("db.encryption", "DB_ENCRYPTION", process.platform === "win32") },
    weights: { rules: 0.45, similarity: 0.25, llm: 0.3 },
    thresholds: { skipLlm: 0.8, minConfidence: 0.55, caseLink: 0.85, caseLinkGap: 0.15 },
  };
  return { ...cfg, ...overrides, ollama: { ...cfg.ollama, ...(overrides.ollama ?? {}) } };
}

export function ensureDirs(cfg: GugaConfig): void {
  for (const d of [cfg.dataDir, cfg.attachmentsDir, cfg.generatedDir, cfg.logsDir, cfg.backupsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
