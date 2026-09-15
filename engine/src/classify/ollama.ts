/** Client Ollama local (§3.2, §10.3) — lié à 127.0.0.1, aucune télémétrie. */
import { logger } from "../logger.js";

export interface OllamaOptions { baseUrl: string; timeoutMs: number; fetchImpl?: typeof fetch }

export class OllamaClient {
  private available: boolean | null = null;
  private models: string[] = [];
  private failures = 0;
  private pausedUntil = 0;
  constructor(private o: OllamaOptions) {}
  private get f() { return this.o.fetchImpl ?? fetch; }

  async ping(): Promise<boolean> {
    try {
      const r = await this.f(`${this.o.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return (this.available = false);
      const j = (await r.json()) as { models?: { name: string }[] };
      this.models = (j.models ?? []).map((m) => m.name);
      return (this.available = true);
    } catch {
      return (this.available = false);
    }
  }
  get isAvailable() { return this.available === true; }
  /** Disjoncteur : après 3 échecs/délais consécutifs, l'IA est mise en pause 10 min (le classement par règles continue). */
  canCall() { return this.available === true && Date.now() >= this.pausedUntil; }
  private ok() { this.failures = 0; }
  private fail(e: unknown) {
    this.failures++;
    if (this.failures >= 3) { this.pausedUntil = Date.now() + 10 * 60_000; this.failures = 0; logger.warn({ err: String(e) }, "IA locale en pause 10 min après 3 échecs"); }
  }
  listModels() { return this.models; }
  hasModel(name: string) { return this.models.some((m) => m === name || m.split(":")[0] === name.split(":")[0]); }

  async generateJson<T>(model: string, prompt: string, schema: object): Promise<T | null> {
    try { return await this.generateJsonInner<T>(model, prompt, schema); } catch (e) { this.fail(e); throw e; }
  }
  private async generateJsonInner<T>(model: string, prompt: string, schema: object): Promise<T | null> {
    const r = await this.f(`${this.o.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, format: schema, options: { temperature: 0, num_ctx: 8192 }, keep_alive: "30m" }),
      signal: AbortSignal.timeout(this.o.timeoutMs),
    });
    if (!r.ok) { logger.warn({ status: r.status }, "ollama generate"); return null; }
    const j = (await r.json()) as { response: string };
    this.ok();
    try { return JSON.parse(j.response) as T; } catch { return null; }
  }

  async embed(model: string, text: string): Promise<Float32Array | null> {
    try { return await this.embedInner(model, text); } catch (e) { this.fail(e); throw e; }
  }
  private async embedInner(model: string, text: string): Promise<Float32Array | null> {
    const r = await this.f(`${this.o.baseUrl}/api/embed`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(this.o.timeoutMs),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { embeddings?: number[][] };
    const v = j.embeddings?.[0];
    return v ? Float32Array.from(v) : null;
  }
}
