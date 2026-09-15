/** Types du domaine partagés par le moteur, l'API et les tests. */

export type ColumnCode =
  | "PUBS" | "CC" | "RIB" | "PLAIDOIRIE" | "INSTR_ASSOC" | "INSTR_COLLAB"
  | "NOUVEAUX" | "PROCEDURE" | "PIECES" | "EXPERTISE" | "CONTACT" | "CLAIRE";

export const COLUMN_CODES: ColumnCode[] = [
  "PUBS", "CC", "RIB", "PLAIDOIRIE", "INSTR_ASSOC", "INSTR_COLLAB",
  "NOUVEAUX", "PROCEDURE", "PIECES", "EXPERTISE", "CONTACT", "CLAIRE",
];

export type ContactRole = "partner" | "associate" | "opponent" | "expert" | "client" | "clerk" | "accounting" | "other";

export interface Mailbox {
  id: string;
  label: string;
  kind: "primary" | "shared";
  address: string;
  connector: string;
  defaultColumn: ColumnCode | null;
  deltaState: Record<string, unknown>;
}

export interface Address { address: string; name?: string }

export interface AttachmentMeta {
  extId?: string;
  name: string;
  mime?: string;
  size?: number;
}

/** Message canonique produit par tout connecteur (§4.1). */
export interface Message {
  extId: string;
  internetMessageId?: string;
  conversationId?: string;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc?: Address[];
  replyTo?: string;
  subject: string;
  receivedAt: string; // ISO
  bodyHtml?: string;
  bodyText?: string;
  headers: Record<string, string>;
  attachments: AttachmentMeta[];
  folderExtId?: string;
  isRead?: boolean;
}

export type MessageDelta =
  | { kind: "upsert"; message: Message }
  | { kind: "delete"; extId: string };

export interface Folder { extId: string; name: string; parentExtId?: string; wellKnown?: string }

export interface Contact {
  id: string;
  name: string;
  emails: string[];
  role: ContactRole;
  barId?: string;
  firm?: string;
  phone?: string;
}

export interface Placement {
  messageId: string;
  columnCode: ColumnCode;
  status: string | null;
  isUrgent: boolean;
  deadlineAt: string | null;
  source: "ai" | "user" | "rule";
  confidence: number;
  toConfirm: boolean;
  caseId: string | null;
  processed: boolean;
  summary: string | null;
  evidence: Record<string, unknown>;
  updatedAt: string;
}

export interface ActionResult { ok: boolean; detail?: string; undo?: Record<string, unknown> }
export interface Draft { to: string[]; cc?: string[]; subject: string; bodyHtml: string; replyToExtId?: string }
export interface DraftRef { extId: string; webLink?: string }
