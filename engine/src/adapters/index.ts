/** Adaptateurs livrés : Secib / e-Carpa / Opalexe en mode assisté, Pappers en lecture (§8). */
import type { AdapterAction, ExternalAdapter, LookupQuery, LookupRecord, PreparedPayload } from "./ExternalAdapter.js";
import type { SecretStore } from "../services/SecretStore.js";

class AssistedAdapter implements ExternalAdapter {
  readonly capability = "assisted" as const;
  readonly enabled = true;
  constructor(readonly name: string, private portal: string | null, private steps: (a: AdapterAction) => string[]) {}
  async prepare(action: AdapterAction): Promise<PreparedPayload> {
    return { adapter: this.name, kind: action.kind, instructions: this.steps(action), deepLink: this.portal ?? undefined, payload: action.payload };
  }
}

export class PappersAdapter implements ExternalAdapter {
  readonly name = "pappers";
  readonly capability = "read" as const;
  private cache = new Map<string, { at: number; recs: LookupRecord[] }>();
  constructor(private secrets: SecretStore, private allowed: string[], private fetchImpl: typeof fetch = fetch) {}
  get enabled() { return this.allowed.includes("api.pappers.fr"); }
  async lookup(q: LookupQuery): Promise<LookupRecord[]> {
    const key = await this.secrets.get("pappers.api_key");
    if (!key || !this.enabled || !q.siren) throw new Error("Pappers indisponible (clé absente ou domaine non autorisé)");
    const c = this.cache.get(q.siren);
    if (c && Date.now() - c.at < 24 * 3600_000) return c.recs;
    const r = await this.fetchImpl(`https://api.pappers.fr/v2/entreprise?siren=${encodeURIComponent(q.siren)}`, { headers: { "api-key": key }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Pappers ${r.status}`);
    const j = (await r.json()) as any;
    const recs: LookupRecord[] = [{ name: j.denomination ?? j.nom_entreprise ?? "", siren: j.siren, address: j.siege ? `${j.siege.adresse_ligne_1 ?? ""} ${j.siege.code_postal ?? ""} ${j.siege.ville ?? ""}`.trim() : undefined, status: j.statut_rcs, source: "pappers", raw: j }];
    this.cache.set(q.siren, { at: Date.now(), recs });
    return recs;
  }
  async prepare(action: AdapterAction): Promise<PreparedPayload> { return { adapter: this.name, kind: action.kind, instructions: ["Consultation Pappers (lecture seule)"], payload: action.payload }; }
}

export function buildAdapters(secrets: SecretStore, allowedDomains: string[]): ExternalAdapter[] {
  return [
    new AssistedAdapter("secib", null, (a) => a.kind === "attach_pieces"
      ? ["Ouvrir le dossier dans Secib", "Glisser-déposer le dossier de sortie préparé par Guga", "Cocher « rattaché » dans Guga"]
      : ["Ouvrir Secib → Nouveau dossier", "Copier-coller la fiche « prête à saisir »", "Reporter la référence Secib dans Guga"]),
    new AssistedAdapter("ecarpa", "https://www.e-carpa.fr", () => ["Ouvrir le portail e-Carpa", "Créer le sous-compte du dossier", "Cocher « dossier e-Carpa créé » dans la demande RIB"]),
    new AssistedAdapter("opalexe", "https://www.opalexe.fr", () => ["Ouvrir Opalexe", "Vérifier le dépôt / l'échéance d'expertise", "Mettre à jour le statut dans Guga"]),
    new PappersAdapter(secrets, allowedDomains),
  ];
}
