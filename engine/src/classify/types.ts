import type { ColumnCode } from "../domain.js";
import type { NormalizedMessage } from "../normalize/message.js";

export type UserPosition = "to" | "cc" | "none";

/** Faits vérifiables sans IA (étape 2) — contraintes dures. */
export interface Facts {
  userPosition: UserPosition;
  senderRole: string | null;
  senderContactId: string | null;
  senderIsFirm: boolean;
  mailboxKind: "primary" | "shared";
  mailboxDefaultColumn: ColumnCode | null;
  caseRefs: string[];
  hasSecureLink: boolean;
  onlyRecipientAlert: boolean;
}

export type Scores = Partial<Record<ColumnCode, number>>;

export interface StageResult { stage: string; scores: Scores; notes: string[] }

export interface LlmOutput {
  column: ColumnCode;
  confidence: number;
  is_urgent: boolean;
  deadline_iso: string | null;
  deadline_evidence: string | null;
  case_hint: string | null;
  entities: { parties: string[]; counsel: string[]; court: string | null; refs: string[] };
  summary: string;
}

export interface ClassificationInput {
  message: NormalizedMessage;
  facts: Facts;
  messageId: string;
}

export interface Decision {
  column: ColumnCode;
  confidence: number;
  toConfirm: boolean;
  isUrgent: boolean;
  deadlineAt: string | null;
  summary: string | null;
  caseHint: string | null;
  evidence: {
    stages: StageResult[];
    hardConstraints: string[];
    llm?: LlmOutput | null;
    deadlineEvidence?: string | null;
    similarNeighbors?: { messageId: string; column: string; score: number }[];
  };
}
