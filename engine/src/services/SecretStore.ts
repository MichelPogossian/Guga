/**
 * Stockage des secrets (§10.2). Sous Windows, l'application Electron chiffre via DPAPI
 * (safeStorage) et le service lit le blob ; en développement, fichier JSON 0600 dans dataDir.
 * Aucun secret n'est journalisé ni exposé par l'API.
 */
import fs from "node:fs";
import path from "node:path";

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class FileSecretStore implements SecretStore {
  private file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, "secrets.json"); }
  private read(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return {}; }
  }
  private write(o: Record<string, string>) { fs.writeFileSync(this.file, JSON.stringify(o), { mode: 0o600 }); }
  async get(k: string) { return this.read()[k] ?? null; }
  async set(k: string, v: string) { const o = this.read(); o[k] = v; this.write(o); }
  async delete(k: string) { const o = this.read(); delete o[k]; this.write(o); }
}

export class MemorySecretStore implements SecretStore {
  private m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}
