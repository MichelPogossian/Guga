/** Fabrique des connecteurs selon config.connector. Le writer n'est jamais exposé au moteur (C2). */
import type { GugaConfig } from "../config.js";
import type { MailboxReader, MailboxWriter } from "./MailboxConnector.js";
import { FakeConnector, FakeWriter } from "./FakeConnector.js";
import { GraphClient, GraphConnector, GraphWriter, RefreshTokenProvider } from "./GraphConnector.js";
import type { SecretStore } from "../services/SecretStore.js";

export interface ConnectorPair { reader: MailboxReader; writer: MailboxWriter }

export async function buildConnectors(cfg: GugaConfig, secrets: SecretStore): Promise<ConnectorPair> {
  switch (cfg.connector) {
    case "fake": {
      const reader = new FakeConnector();
      return { reader, writer: new FakeWriter(reader) };
    }
    case "graph": {
      const tenant = (await secrets.get("graph.tenant")) ?? "common";
      const clientId = await secrets.get("graph.client_id");
      if (!clientId) throw new Error("Graph : client_id absent (assistant de première ouverture non exécuté)");
      const tokens = new RefreshTokenProvider(tenant, clientId,
        async () => { const t = await secrets.get("graph.refresh_token"); if (!t) throw new Error("Graph : refresh_token absent"); return t; },
        (t) => secrets.set("graph.refresh_token", t));
      const client = new GraphClient(tokens);
      const shared = (await secrets.get("graph.shared_mailboxes")) ?? "[]";
      const reader = new GraphConnector(client, {
        primaryAddress: cfg.userAddresses[0], historyYears: cfg.historyYears, sharedMailboxes: JSON.parse(shared),
      });
      return { reader, writer: new GraphWriter(client) };
    }
    case "imap":
      throw new Error("Connecteur IMAP : prévu en repli (D1), non livré dans cette version");
    default:
      throw new Error(`connecteur inconnu ${cfg.connector}`);
  }
}
