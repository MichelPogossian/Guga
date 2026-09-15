/** Normalisation d'un message connecteur → ligne `message` (§4.1). */
import crypto from "node:crypto";
import type { Message } from "../domain.js";
import { extractLinks, htmlToText, stripQuotedReplies } from "./html.js";

export interface NormalizedMessage {
  extId: string;
  internetMessageId: string | null;
  conversationId: string | null;
  fromAddr: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  replyTo: string | null;
  subject: string;
  receivedAt: string;
  bodyText: string;
  bodyForAi: string;
  bodyHtml: string | null;
  bodyHash: string;
  headers: Record<string, string>;
  links: ReturnType<typeof extractLinks>;
  hasAttachments: boolean;
  attachmentNames: string;
  folderExtId: string | null;
  isRead: boolean;
}

export const normEmail = (a: string) => a.trim().toLowerCase();

export function normalizeMessage(m: Message): NormalizedMessage {
  const bodyText = (m.bodyText && m.bodyText.trim()) ? m.bodyText.trim() : htmlToText(m.bodyHtml ?? "");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.headers ?? {})) headers[k.toLowerCase()] = v;
  return {
    extId: m.extId,
    internetMessageId: m.internetMessageId ?? null,
    conversationId: m.conversationId ?? null,
    fromAddr: normEmail(m.from.address),
    fromName: m.from.name ?? null,
    to: m.to.map((a) => normEmail(a.address)),
    cc: m.cc.map((a) => normEmail(a.address)),
    replyTo: m.replyTo ? normEmail(m.replyTo) : null,
    subject: (m.subject ?? "").trim(),
    receivedAt: new Date(m.receivedAt).toISOString(),
    bodyText,
    bodyForAi: stripQuotedReplies(bodyText).slice(0, 12_000),
    bodyHtml: m.bodyHtml ?? null,
    bodyHash: crypto.createHash("sha256").update(bodyText).digest("hex"),
    headers,
    links: extractLinks(m.bodyHtml, bodyText),
    hasAttachments: m.attachments.length > 0,
    attachmentNames: m.attachments.map((a) => a.name).join(" ; "),
    folderExtId: m.folderExtId ?? null,
    isRead: !!m.isRead,
  };
}
