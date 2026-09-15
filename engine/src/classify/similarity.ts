/**
 * Étape 4 — similarité par embeddings et vote k-NN sur les placements validés (§6.1, §6.2).
 * Les vecteurs sont stockés en BLOB float32 dans message_vec ; la recherche est exhaustive en
 * mémoire (60 000 × 1024 flottants ≈ 250 Mo lus par lot ; sqlite-vec peut remplacer ce parcours).
 */
import type { Database } from "better-sqlite3";
import type { ColumnCode } from "../domain.js";
import type { Scores, StageResult } from "./types.js";

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function toBlob(v: Float32Array): Buffer { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }
export function fromBlob(b: Buffer): Float32Array { return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }

export interface Neighbor { messageId: string; column: ColumnCode; source: string; score: number }

export function nearestNeighbors(db: Database, query: Float32Array, k = 15, excludeId?: string): Neighbor[] {
  const rows = db.prepare(`
    SELECT v.message_id, v.embedding, p.column_code, p.source
    FROM message_vec v JOIN placement p ON p.message_id = v.message_id
    WHERE (? IS NULL OR v.message_id <> ?)`).all(excludeId ?? null, excludeId ?? null) as
    { message_id: string; embedding: Buffer; column_code: ColumnCode; source: string }[];
  const scored = rows.map((r) => ({ messageId: r.message_id, column: r.column_code, source: r.source, score: cosine(query, fromBlob(r.embedding)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Vote pondéré : poids = score × (2 si validé par l'utilisatrice, 1 sinon). */
export function knnVote(neighbors: Neighbor[]): StageResult {
  const acc: Scores = {};
  let total = 0;
  for (const n of neighbors) {
    if (n.score < 0.5) continue;
    const w = n.score * (n.source === "user" ? 2 : 1);
    acc[n.column] = (acc[n.column] ?? 0) + w;
    total += w;
  }
  const scores: Scores = {};
  if (total > 0) for (const [c, v] of Object.entries(acc) as [ColumnCode, number][]) scores[c] = v / total;
  return { stage: "similarity", scores, notes: neighbors.slice(0, 5).map((n) => `${n.messageId} ${n.column} ${n.score.toFixed(2)} (${n.source})`) };
}
