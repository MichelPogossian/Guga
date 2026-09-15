/**
 * Connecteur Microsoft Graph (§4, onglet « Graph API »).
 * - Requêtes delta par boîte × dossier, jeton persisté dans mailbox.delta_state.
 * - Lecture : ne touche jamais isRead.
 * - Écriture (GraphWriter) : déplacement, catégories, suppression douce (move → deleteditems),
 *   brouillons, envoi, transfert. Jamais permanentDelete.
 * Le jeton d'accès est fourni par un TokenProvider (MSAL / DPAPI côté application ; ici un
 * rafraîchissement OAuth2 « public client » minimal sans dépendance).
 */
import type { ActionResult, Draft, DraftRef, Folder, Mailbox, Message, MessageDelta } from "../domain.js";
import type { MailboxReader, MailboxWriter, SyncDeltaResult } from "./MailboxConnector.js";
import { logger } from "../logger.js";

export interface TokenProvider { getAccessToken(): Promise<string> }

export interface GraphOptions {
  primaryAddress: string;
  sharedMailboxes: { address: string; label: string; defaultColumn?: string | null }[];
  historyYears: number;
  fetchImpl?: typeof fetch;
}

/** Rafraîchissement OAuth2 (authorization code + PKCE réalisé par l'application, refresh token en DPAPI). */
export class RefreshTokenProvider implements TokenProvider {
  private access: { token: string; exp: number } | null = null;
  constructor(private tenant: string, private clientId: string, private refreshToken: () => Promise<string>,
    private saveRefreshToken: (t: string) => Promise<void>, private fetchImpl: typeof fetch = fetch) {}
  async getAccessToken(): Promise<string> {
    if (this.access && this.access.exp > Date.now() + 60_000) return this.access.token;
    const body = new URLSearchParams({
      client_id: this.clientId, grant_type: "refresh_token", refresh_token: await this.refreshToken(),
      scope: "https://graph.microsoft.com/.default offline_access",
    });
    const r = await this.fetchImpl(`https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    });
    if (!r.ok) throw new Error(`Graph token: ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    if (j.refresh_token) await this.saveRefreshToken(j.refresh_token);
    this.access = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }
}

const GRAPH = "https://graph.microsoft.com/v1.0";

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export class GraphClient {
  constructor(private tokens: TokenProvider, private fetchImpl: typeof fetch = fetch) {}
  async request<T>(method: string, url: string, body?: unknown, attempt = 0): Promise<T> {
    const token = await this.tokens.getAccessToken();
    const r = await this.fetchImpl(url.startsWith("http") ? url : GRAPH + url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: 'IdType="ImmutableId"' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ((r.status === 429 || r.status === 503) && attempt < 6) {
      const retry = Number(r.headers.get("retry-after") ?? 0) * 1000 || Math.min(60_000, 2 ** attempt * 1000);
      logger.warn({ status: r.status, retry }, "Graph backoff");
      await sleep(retry);
      return this.request<T>(method, url, body, attempt + 1);
    }
    if (r.status === 204) return undefined as T;
    if (!r.ok) throw new Error(`Graph ${method} ${url}: ${r.status} ${await r.text()}`);
    const ct = r.headers.get("content-type") ?? "";
    return (ct.includes("json") ? await r.json() : await r.arrayBuffer()) as T;
  }
}

interface GraphMessage {
  id: string; internetMessageId?: string; conversationId?: string;
  from?: { emailAddress: { address: string; name?: string } };
  toRecipients?: { emailAddress: { address: string; name?: string } }[];
  ccRecipients?: { emailAddress: { address: string; name?: string } }[];
  replyTo?: { emailAddress: { address: string } }[];
  subject?: string; receivedDateTime: string; body?: { contentType: string; content: string };
  bodyPreview?: string; hasAttachments?: boolean; parentFolderId?: string; isRead?: boolean;
  internetMessageHeaders?: { name: string; value: string }[];
  "@removed"?: { reason: string };
}

const SELECT = "id,internetMessageId,conversationId,from,toRecipients,ccRecipients,replyTo,subject,receivedDateTime,body,hasAttachments,parentFolderId,isRead,internetMessageHeaders";

export class GraphConnector implements MailboxReader {
  readonly kind = "graph";
  constructor(private client: GraphClient, private opts: GraphOptions) {}

  private base(mb: Mailbox) { return mb.kind === "primary" ? "/me" : `/users/${encodeURIComponent(mb.address)}`; }

  async listMailboxes(): Promise<Mailbox[]> {
    const list: Mailbox[] = [{
      id: "graph-primary", label: "Boîte principale", kind: "primary", address: this.opts.primaryAddress,
      connector: "graph", defaultColumn: null, deltaState: {},
    }];
    for (const s of this.opts.sharedMailboxes) {
      list.push({ id: `graph-${s.address}`, label: s.label, kind: "shared", address: s.address, connector: "graph",
        defaultColumn: (s.defaultColumn as Mailbox["defaultColumn"]) ?? null, deltaState: {} });
    }
    return list;
  }

  async listFolders(mb: Mailbox): Promise<Folder[]> {
    const r = await this.client.request<{ value: { id: string; displayName: string; parentFolderId?: string; wellKnownName?: string }[] }>(
      "GET", `${this.base(mb)}/mailFolders?$top=200&includeHiddenFolders=false`);
    return r.value.map((f) => ({ extId: f.id, name: f.displayName, parentExtId: f.parentFolderId, wellKnown: f.wellKnownName }));
  }

  async syncDelta(mb: Mailbox, token?: string): Promise<SyncDeltaResult> {
    let url: string;
    if (token) url = token;
    else {
      const since = new Date();
      since.setFullYear(since.getFullYear() - this.opts.historyYears);
      url = `${GRAPH}${this.base(mb)}/mailFolders/inbox/messages/delta?$select=${SELECT}&$top=50&$filter=receivedDateTime ge ${since.toISOString()}`;
    }
    const page = await this.client.request<{ value: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>("GET", url);
    const changes: MessageDelta[] = page.value.map((g) => g["@removed"] ? { kind: "delete", extId: g.id } : { kind: "upsert", message: this.toMessage(g) });
    const next = page["@odata.nextLink"] ?? page["@odata.deltaLink"] ?? url;
    return { changes, nextToken: next, more: !!page["@odata.nextLink"] };
  }

  async fetchMessage(mb: Mailbox, extId: string): Promise<Message> {
    const g = await this.client.request<GraphMessage>("GET", `${this.base(mb)}/messages/${extId}?$select=${SELECT}`);
    const msg = this.toMessage(g);
    if (g.hasAttachments) {
      const atts = await this.client.request<{ value: { id: string; name: string; contentType?: string; size?: number }[] }>(
        "GET", `${this.base(mb)}/messages/${extId}/attachments?$select=id,name,contentType,size`);
      msg.attachments = atts.value.map((a) => ({ extId: a.id, name: a.name, mime: a.contentType, size: a.size }));
    }
    return msg;
  }

  async fetchAttachment(mb: Mailbox, msgExtId: string, attExtId: string): Promise<Buffer> {
    const buf = await this.client.request<ArrayBuffer>("GET", `${this.base(mb)}/messages/${msgExtId}/attachments/${attExtId}/$value`);
    return Buffer.from(buf);
  }

  private toMessage(g: GraphMessage): Message {
    const headers: Record<string, string> = {};
    for (const h of g.internetMessageHeaders ?? []) headers[h.name] = h.value;
    const html = g.body?.contentType?.toLowerCase() === "html" ? g.body.content : undefined;
    return {
      extId: g.id, internetMessageId: g.internetMessageId, conversationId: g.conversationId,
      from: { address: g.from?.emailAddress.address ?? "", name: g.from?.emailAddress.name },
      to: (g.toRecipients ?? []).map((r) => ({ address: r.emailAddress.address, name: r.emailAddress.name })),
      cc: (g.ccRecipients ?? []).map((r) => ({ address: r.emailAddress.address, name: r.emailAddress.name })),
      replyTo: g.replyTo?.[0]?.emailAddress.address,
      subject: g.subject ?? "", receivedAt: g.receivedDateTime,
      bodyHtml: html, bodyText: html ? undefined : g.body?.content ?? g.bodyPreview,
      headers, attachments: [], folderExtId: g.parentFolderId, isRead: g.isRead,
    };
  }
}

export class GraphWriter implements MailboxWriter {
  readonly kind = "graph";
  constructor(private client: GraphClient) {}
  private base(mb: Mailbox) { return mb.kind === "primary" ? "/me" : `/users/${encodeURIComponent(mb.address)}`; }
  async move(mb: Mailbox, id: string, folderExtId: string): Promise<ActionResult> {
    const cur = await this.client.request<{ parentFolderId: string }>("GET", `${this.base(mb)}/messages/${id}?$select=parentFolderId`);
    await this.client.request("POST", `${this.base(mb)}/messages/${id}/move`, { destinationId: folderExtId });
    return { ok: true, undo: { folderExtId: cur.parentFolderId } };
  }
  async setCategories(mb: Mailbox, id: string, categories: string[]): Promise<ActionResult> {
    await this.client.request("PATCH", `${this.base(mb)}/messages/${id}`, { categories });
    return { ok: true };
  }
  async softDelete(mb: Mailbox, id: string): Promise<ActionResult> { return this.move(mb, id, "deleteditems"); }
  async markRead(mb: Mailbox, id: string, read: boolean): Promise<ActionResult> {
    await this.client.request("PATCH", `${this.base(mb)}/messages/${id}`, { isRead: read });
    return { ok: true };
  }
  async createDraft(mb: Mailbox, d: Draft): Promise<DraftRef> {
    const body = {
      subject: d.subject, body: { contentType: "HTML", content: d.bodyHtml },
      toRecipients: d.to.map((a) => ({ emailAddress: { address: a } })),
      ccRecipients: (d.cc ?? []).map((a) => ({ emailAddress: { address: a } })),
    };
    const url = d.replyToExtId ? `${this.base(mb)}/messages/${d.replyToExtId}/createReply` : `${this.base(mb)}/messages`;
    const r = await this.client.request<{ id: string; webLink?: string }>("POST", url, d.replyToExtId ? { message: body } : body);
    return { extId: r.id, webLink: r.webLink };
  }
  async sendDraft(mb: Mailbox, draftId: string): Promise<ActionResult> {
    await this.client.request("POST", `${this.base(mb)}/messages/${draftId}/send`);
    return { ok: true };
  }
  async forward(mb: Mailbox, id: string, to: string[], comment?: string): Promise<ActionResult> {
    await this.client.request("POST", `${this.base(mb)}/messages/${id}/forward`, {
      comment: comment ?? "", toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
    });
    return { ok: true };
  }
}
