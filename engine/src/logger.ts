/** Journaux techniques (pino, JSON) — jamais de contenu d'e-mail (§10.3, §11). */
import pino from "pino";

export const logger = pino({
  level: process.env.GUGA_LOG_LEVEL ?? "info",
  redact: { paths: ["body_text", "body", "subject", "*.body_text", "*.subject"], censor: "[redacted]" },
});
export type Logger = typeof logger;
