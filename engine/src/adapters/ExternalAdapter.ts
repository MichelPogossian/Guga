/** Contrat commun des intégrations tierces (§8). Niveau de capacité déclaré par l'adaptateur. */
export interface LookupQuery { siren?: string; name?: string; barId?: string; lawyerName?: string }
export interface LookupRecord { name: string; siren?: string; address?: string; status?: string; source: string; raw?: unknown }
export interface AdapterAction { kind: string; payload: Record<string, unknown> }
export interface PreparedPayload { adapter: string; kind: string; instructions: string[]; deepLink?: string; sheet?: string; payload: Record<string, unknown> }
export interface AdapterResult { ok: boolean; detail?: string }

export interface ExternalAdapter {
  readonly name: string;
  readonly capability: "assisted" | "read" | "read_write";
  readonly enabled: boolean;
  lookup?(query: LookupQuery): Promise<LookupRecord[]>;
  prepare(action: AdapterAction): Promise<PreparedPayload>;
  execute?(prepared: PreparedPayload): Promise<AdapterResult>;
}
