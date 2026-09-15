/**
 * Jetons d'intention (§9.1, C2) : émis lors d'une confirmation utilisateur, à usage unique,
 * liés à une action et une cible, expirés après 2 minutes. Le moteur ne les possède jamais.
 */
import crypto from "node:crypto";

interface Intent { token: string; action: string; targetIds: string[]; expiresAt: number; used: boolean }

export class IntentService {
  private intents = new Map<string, Intent>();
  constructor(private ttlMs = 120_000) {}

  issue(action: string, targetIds: string[]): { token: string; expiresAt: string } {
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    this.intents.set(token, { token, action, targetIds: [...targetIds].sort(), expiresAt, used: false });
    this.gc();
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Consomme le jeton ; renvoie la raison du refus le cas échéant. */
  consume(token: string | undefined, action: string, targetIds: string[]): { ok: true } | { ok: false; reason: string } {
    if (!token) return { ok: false, reason: "jeton d'intention absent" };
    const it = this.intents.get(token);
    if (!it) return { ok: false, reason: "jeton d'intention inconnu" };
    if (it.used) return { ok: false, reason: "jeton d'intention déjà utilisé" };
    if (it.expiresAt < Date.now()) return { ok: false, reason: "jeton d'intention expiré" };
    if (it.action !== action) return { ok: false, reason: "jeton d'intention émis pour une autre action" };
    const sorted = [...targetIds].sort();
    if (sorted.length !== it.targetIds.length || sorted.some((t, i) => t !== it.targetIds[i])) return { ok: false, reason: "jeton d'intention émis pour d'autres cibles" };
    it.used = true;
    return { ok: true };
  }

  private gc() { const now = Date.now(); for (const [k, v] of this.intents) if (v.used || v.expiresAt < now) this.intents.delete(k); }
}
