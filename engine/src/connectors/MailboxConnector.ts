/**
 * Contrat du connecteur messagerie (§4).
 * MailboxReader = plan de lecture (moteur, jobs).
 * MailboxWriter = plan d'action : injecté UNIQUEMENT dans ActionService (contrainte C2).
 * Le test `invariants.test.ts` vérifie qu'aucun module de src/classify ou src/services/sync
 * n'importe MailboxWriter ni une implémentation d'écriture.
 */
import type { ActionResult, Draft, DraftRef, Folder, Mailbox, Message, MessageDelta } from "../domain.js";

export interface SyncDeltaResult { changes: MessageDelta[]; nextToken: string; more?: boolean }

export interface MailboxReader {
  readonly kind: string;
  listMailboxes(): Promise<Mailbox[]>;
  listFolders(mailbox: Mailbox): Promise<Folder[]>;
  syncDelta(mailbox: Mailbox, token?: string): Promise<SyncDeltaResult>;
  fetchMessage(mailbox: Mailbox, extId: string, withBody?: boolean): Promise<Message>;
  fetchAttachment(mailbox: Mailbox, msgExtId: string, attExtId: string): Promise<Buffer>;
}

export interface MailboxWriter {
  readonly kind: string;
  move(mailbox: Mailbox, msgExtId: string, folderExtId: string): Promise<ActionResult>;
  setCategories(mailbox: Mailbox, msgExtId: string, categories: string[]): Promise<ActionResult>;
  /** Déplacement vers « Éléments supprimés » — jamais de suppression définitive (C4). */
  softDelete(mailbox: Mailbox, msgExtId: string): Promise<ActionResult>;
  markRead(mailbox: Mailbox, msgExtId: string, read: boolean): Promise<ActionResult>;
  createDraft(mailbox: Mailbox, draft: Draft): Promise<DraftRef>;
  sendDraft(mailbox: Mailbox, draftExtId: string): Promise<ActionResult>;
  forward(mailbox: Mailbox, msgExtId: string, to: string[], comment?: string): Promise<ActionResult>;
}
