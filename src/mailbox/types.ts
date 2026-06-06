export type MailProvider = "ravi-mail" | "gmail" | "imap-smtp" | (string & {});

export type MailAccountStatus = "active" | "paused" | "auth_required" | "disabled";
export type MailMailboxRole = "primary" | "alias" | "shared" | "system" | "unknown";
export type MailMailboxStatus = "active" | "paused" | "disabled";
export type MailDirection = "inbound" | "outbound" | "draft" | "system";
export type MailMessageStatus =
  | "received"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "archived"
  | "trashed"
  | "spam";
export type MailBodyRedactionStatus = "full_local" | "preview_only" | "redacted" | "missing";
export type MailAddressKind = "from" | "to" | "cc" | "bcc" | "reply_to" | "sender";
export type MailOutboxOperation = "send" | "reply" | "draft" | "update_draft" | "delete_draft";
export type MailOutboxStatus = "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";

export interface MailAccount {
  id: string;
  provider: MailProvider;
  displayName: string;
  status: MailAccountStatus;
  defaultMailboxId: string | null;
  credentialsRef: string | null;
  capabilities: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface MailMailbox {
  id: string;
  accountId: string;
  address: string;
  normalizedAddress: string;
  displayName: string | null;
  role: MailMailboxRole;
  status: MailMailboxStatus;
  providerMailboxId: string | null;
  isDefault: boolean;
  lastSyncedAt: number | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface MailThread {
  id: string;
  subjectNormalized: string | null;
  latestMessageAt: number | null;
  lastLocalMessageId: string | null;
  participants: unknown[];
  providerThreadRefs: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface MailMessage {
  id: string;
  threadId: string;
  mailboxId: string;
  accountId: string;
  direction: MailDirection;
  status: MailMessageStatus;
  rfcMessageId: string | null;
  providerMessageId: string | null;
  providerThreadId: string | null;
  providerHistoryId: string | null;
  subject: string | null;
  subjectNormalized: string | null;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyRedactionStatus: MailBodyRedactionStatus;
  dateHeaderAt: number | null;
  receivedAt: number | null;
  sentAt: number | null;
  rawHeaders: Record<string, unknown>;
  safePayload: Record<string, unknown>;
  providerProvenance: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface MailAddress {
  id: string;
  messageId: string;
  kind: MailAddressKind;
  address: string;
  normalizedAddress: string;
  displayName: string | null;
  contactId: string | null;
  agentId: string | null;
  platformIdentityId: string | null;
  raw: Record<string, unknown>;
}

export interface MailAttachment {
  id: string;
  messageId: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  localBlobRef: string | null;
  providerAttachmentId: string | null;
  redactionStatus: string | null;
  metadata: Record<string, unknown>;
}

export interface MailMessageWithAddresses extends MailMessage {
  addresses: MailAddress[];
  attachments: MailAttachment[];
}

export interface MailOutboxRow {
  id: string;
  mailboxId: string;
  accountId: string;
  messageId: string;
  operation: MailOutboxOperation;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: MailOutboxStatus;
  attemptCount: number;
  nextAttemptAt: number;
  lastErrorCode: string | null;
  providerResult: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  ackedAt: number | null;
}

export interface MailAddressInput {
  kind: MailAddressKind;
  address: string;
  displayName?: string | null;
  contactId?: string | null;
  agentId?: string | null;
  platformIdentityId?: string | null;
  raw?: Record<string, unknown> | null;
}

export interface MailAttachmentInput {
  id?: string;
  filename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  localBlobRef?: string | null;
  providerAttachmentId?: string | null;
  redactionStatus?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateMailAccountInput {
  id?: string;
  provider: MailProvider;
  displayName?: string;
  status?: MailAccountStatus;
  credentialsRef?: string | null;
  capabilities?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  now?: number;
}

export interface CreateMailMailboxInput {
  id?: string;
  accountId: string;
  address: string;
  displayName?: string | null;
  role?: MailMailboxRole;
  status?: MailMailboxStatus;
  providerMailboxId?: string | null;
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface ImportMailMessageInput {
  id?: string;
  threadId?: string;
  accountId?: string;
  mailboxId?: string;
  mailbox?: string;
  direction?: MailDirection;
  status?: MailMessageStatus;
  provider?: MailProvider;
  providerMessageId?: string | null;
  providerThreadId?: string | null;
  providerHistoryId?: string | null;
  inReplyToRfcMessageId?: string | null;
  referencesRfcMessageIds?: string[];
  rfcMessageId?: string | null;
  subject?: string | null;
  snippet?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  bodyRedactionStatus?: MailBodyRedactionStatus;
  dateHeaderAt?: number | null;
  receivedAt?: number | null;
  sentAt?: number | null;
  rawHeaders?: Record<string, unknown>;
  safePayload?: Record<string, unknown>;
  providerProvenance?: Record<string, unknown>;
  addresses?: MailAddressInput[];
  attachments?: MailAttachmentInput[];
  idempotencyKey?: string | null;
  now?: number;
}

export interface ListMailMessagesInput {
  mailbox?: string;
  accountId?: string;
  threadId?: string;
  status?: MailMessageStatus;
  direction?: MailDirection;
  query?: string;
  limit?: number;
  offset?: number;
  includeAddresses?: boolean;
}

export interface EnqueueMailSendInput {
  from?: string;
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  operation?: Extract<MailOutboxOperation, "send" | "reply">;
  replyToMessageId?: string | null;
  threadId?: string | null;
  inReplyToRfcMessageId?: string | null;
  referencesRfcMessageIds?: string[];
  idempotencyKey?: string;
  now?: number;
}

export interface EnqueueMailReplyInput {
  messageId: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  idempotencyKey?: string;
  now?: number;
}
