/**
 * Connecteur simulé (§14.1) : rejoue le corpus fixtures/corpus.json avec des jetons delta.
 * Sert au développement, aux tests de contrat et à la démonstration sans Outlook.
 * FakeWriter enregistre les actions en mémoire (aucun effet réel).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionResult, Draft, DraftRef, Folder, Mailbox, Message, MessageDelta } from "../domain.js";
import type { MailboxReader, MailboxWriter, SyncDeltaResult } from "./MailboxConnector.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface CorpusMessage {
  mailbox: number;
  from: [string, string?];
  to: string[];
  cc?: string[];
  subject: string;
  ageHours: number;
  headers?: Record<string, string>;
  text?: string;
  html?: string;
  attachments?: [string, string, number][];
  expected?: string;
}
export interface Corpus {
  firmDomain: string;
  mailboxes: { label: string; kind: "primary" | "shared"; address: string; defaultColumn: string | null }[];
  contacts: { name: string; emails: string[]; role: string; firm?: string; barId?: string }[];
  cases: { secibRef: string; label: string; parties: string[]; counsel: string[]; court: string; hearings: string[] }[];
  messages: CorpusMessage[];
}

export function loadCorpus(file?: string): Corpus {
  const p = file ?? path.resolve(here, "../../fixtures/corpus.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export class FakeConnector implements MailboxReader {
  readonly kind = "fake";
  private messages: Map<string, Message[]> = new Map();
  private deleted: Map<string, Set<string>> = new Map();
  private extra: Map<string, Message[]> = new Map();
  public readonly corpus: Corpus;

  constructor(corpus?: Corpus, private now: Date = new Date()) {
    this.corpus = corpus ?? loadCorpus();
    this.corpus.mailboxes.forEach((mb, i) => {
      const list = this.corpus.messages
        .map((m, idx) => ({ m, idx }))
        .filter(({ m }) => m.mailbox === i)
        .map(({ m, idx }) => this.toMessage(m, idx));
      this.messages.set(mb.address, list);
    });
  }

  private toMessage(m: CorpusMessage, idx: number): Message {
    const received = new Date(this.now.getTime() - m.ageHours * 3600_000).toISOString();
    return {
      extId: `fake-${idx}`,
      internetMessageId: `<fake-${idx}@${m.from[0].split("@")[1]}>`,
      conversationId: `conv-${idx}`,
      from: { address: m.from[0], name: m.from[1] },
      to: m.to.map((a) => ({ address: a })),
      cc: (m.cc ?? []).map((a) => ({ address: a })),
      subject: m.subject,
      receivedAt: received,
      bodyText: m.text,
      bodyHtml: m.html,
      headers: m.headers ?? {},
      attachments: (m.attachments ?? []).map(([name, mime, size], j) => ({ extId: `att-${idx}-${j}`, name, mime, size })),
      folderExtId: "inbox",
      isRead: false,
    };
  }

  /** Injecte un message supplémentaire (tests : « un e-mail similaire reçu ensuite »). */
  inject(mailboxAddress: string, msg: Message): void {
    const l = this.extra.get(mailboxAddress) ?? [];
    l.push(msg);
    this.extra.set(mailboxAddress, l);
  }

  async listMailboxes(): Promise<Mailbox[]> {
    return this.corpus.mailboxes.map((mb, i) => ({
      id: `fake-mb-${i}`,
      label: mb.label,
      kind: mb.kind,
      address: mb.address,
      connector: "fake",
      defaultColumn: (mb.defaultColumn as Mailbox["defaultColumn"]) ?? null,
      deltaState: {},
    }));
  }

  async listFolders(): Promise<Folder[]> {
    return [
      { extId: "inbox", name: "Boîte de réception", wellKnown: "inbox" },
      { extId: "deleteditems", name: "Éléments supprimés", wellKnown: "deleteditems" },
      { extId: "archive", name: "Archive", wellKnown: "archive" },
    ];
  }

  async syncDelta(mailbox: Mailbox, token?: string): Promise<SyncDeltaResult> {
    const all = [...(this.messages.get(mailbox.address) ?? []), ...(this.extra.get(mailbox.address) ?? [])];
    const start = token ? Number(token) : 0;
    const slice = all.slice(start);
    const del = this.deleted.get(mailbox.address) ?? new Set();
    const changes: MessageDelta[] = slice.map((m) => del.has(m.extId) ? { kind: "delete", extId: m.extId } : { kind: "upsert", message: m });
    return { changes, nextToken: String(all.length), more: false };
  }

  async fetchMessage(mailbox: Mailbox, extId: string): Promise<Message> {
    const all = [...(this.messages.get(mailbox.address) ?? []), ...(this.extra.get(mailbox.address) ?? [])];
    const m = all.find((x) => x.extId === extId);
    if (!m) throw new Error(`message inconnu ${extId}`);
    return m;
  }

  async fetchAttachment(_mailbox: Mailbox, msgExtId: string, attExtId: string): Promise<Buffer> {
    return Buffer.from(`%PDF-1.4 fake attachment ${msgExtId}/${attExtId}\n`);
  }

  markDeletedRemote(mailboxAddress: string, extId: string): void {
    const s = this.deleted.get(mailboxAddress) ?? new Set();
    s.add(extId);
    this.deleted.set(mailboxAddress, s);
  }
}

export class FakeWriter implements MailboxWriter {
  readonly kind = "fake";
  public readonly log: { op: string; mailbox: string; args: unknown[] }[] = [];
  private draftSeq = 0;
  constructor(private reader?: FakeConnector) {}
  private rec(op: string, mailbox: Mailbox, ...args: unknown[]): ActionResult {
    this.log.push({ op, mailbox: mailbox.address, args });
    return { ok: true, detail: `fake:${op}` };
  }
  async move(mb: Mailbox, id: string, folder: string) { return this.rec("move", mb, id, folder); }
  async setCategories(mb: Mailbox, id: string, cats: string[]) { return this.rec("setCategories", mb, id, cats); }
  async softDelete(mb: Mailbox, id: string) {
    this.reader?.markDeletedRemote(mb.address, id);
    return { ...this.rec("softDelete", mb, id), undo: { folderExtId: "inbox" } };
  }
  async markRead(mb: Mailbox, id: string, read: boolean) { return this.rec("markRead", mb, id, read); }
  async createDraft(mb: Mailbox, draft: Draft): Promise<DraftRef> {
    this.rec("createDraft", mb, draft);
    return { extId: `draft-${++this.draftSeq}` };
  }
  async sendDraft(mb: Mailbox, draftId: string) { return this.rec("sendDraft", mb, draftId); }
  async forward(mb: Mailbox, id: string, to: string[], comment?: string) { return this.rec("forward", mb, id, to, comment); }
}
