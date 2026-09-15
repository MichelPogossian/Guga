/**
 * Ouverture de la base locale (§3.2, §10.1).
 * SQLCipher est utilisé si le module `better-sqlite3-multiple-ciphers` est installé et que le
 * chiffrement est activé ; sinon repli sur better-sqlite3 standard (mode développement / macOS).
 * La clé est dérivée d'un secret stocké dans le profil utilisateur (DPAPI côté Windows via
 * l'application ; en repli un fichier 0600 dans le dossier de données).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import { migrate } from "./migrate.js";
import { logger } from "../logger.js";

const require = createRequire(import.meta.url);
export type DB = BetterSqlite3.Database;

export interface OpenOptions { path: string; encryption?: boolean; dataDir?: string; memory?: boolean }

function loadKey(dataDir: string): string {
  const p = path.join(dataDir, ".dbkey");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  const k = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(p, k, { mode: 0o600 });
  return k;
}

export function openDatabase(opts: OpenOptions): DB {
  let Driver: typeof BetterSqlite3;
  let cipher = false;
  if (opts.encryption) {
    try {
      Driver = require("better-sqlite3-multiple-ciphers");
      cipher = true;
    } catch {
      logger.warn("SQLCipher indisponible (better-sqlite3-multiple-ciphers non installé) — base non chiffrée");
      Driver = require("better-sqlite3");
    }
  } else {
    Driver = require("better-sqlite3");
  }
  const db = new Driver(opts.memory ? ":memory:" : opts.path);
  if (cipher && opts.dataDir) {
    db.pragma(`cipher='sqlcipher'`);
    db.pragma(`key='${loadKey(opts.dataDir)}'`);
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  migrate(db);
  return db;
}
