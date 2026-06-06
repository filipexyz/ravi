import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../router/router-db.js";
import { executeWrite } from "../db/write-retry.js";
import type {
  CreateMailAccountInput,
  CreateMailMailboxInput,
  EnqueueMailReplyInput,
  EnqueueMailSendInput,
  ImportMailMessageInput,
  ListMailMessagesInput,
  MailAccount,
  MailAccountStatus,
  MailAddress,
  MailAddressInput,
  MailAttachment,
  MailAttachmentInput,
  MailBodyRedactionStatus,
  MailDirection,
  MailMailbox,
  MailMailboxRole,
  MailMailboxStatus,
  MailMessage,
  MailMessageStatus,
  MailMessageWithAddresses,
  MailOutboxOperation,
  MailOutboxRow,
  MailOutboxStatus,
  MailProvider,
  MailThread,
} from "./types.js";

interface MailAccountRow {
  id: string;
  provider: string;
  display_name: string;
  status: MailAccountStatus;
  default_mailbox_id: string | null;
  credentials_ref: string | null;
  capabilities_json: string | null;
  settings_json: string | null;
  created_at: number;
  updated_at: number;
}

interface MailMailboxRow {
  id: string;
  account_id: string;
  address: string;
  normalized_address: string;
  display_name: string | null;
  role: MailMailboxRole;
  status: MailMailboxStatus;
  provider_mailbox_id: string | null;
  is_default: number;
  last_synced_at: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface MailThreadRow {
  id: string;
  subject_normalized: string | null;
  latest_message_at: number | null;
  last_local_message_id: string | null;
  participants_json: string | null;
  provider_thread_refs_json: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface MailMessageRow {
  id: string;
  thread_id: string;
  mailbox_id: string;
  account_id: string;
  direction: MailDirection;
  status: MailMessageStatus;
  rfc_message_id: string | null;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  provider_history_id: string | null;
  subject: string | null;
  subject_normalized: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  body_redaction_status: MailBodyRedactionStatus;
  date_header_at: number | null;
  received_at: number | null;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
  raw_headers_json: string | null;
  safe_payload_json: string | null;
  provider_provenance_json: string | null;
}

interface MailAddressRow {
  id: string;
  message_id: string;
  kind: string;
  address: string;
  normalized_address: string;
  display_name: string | null;
  contact_id: string | null;
  agent_id: string | null;
  platform_identity_id: string | null;
  raw_json: string | null;
}

interface MailAttachmentRow {
  id: string;
  message_id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  local_blob_ref: string | null;
  provider_attachment_id: string | null;
  redaction_status: string | null;
  metadata_json: string | null;
}

interface MailOutboxDbRow {
  id: string;
  mailbox_id: string;
  account_id: string;
  message_id: string;
  operation: MailOutboxOperation;
  idempotency_key: string;
  payload_json: string;
  status: MailOutboxStatus;
  attempt_count: number;
  next_attempt_at: number;
  last_error_code: string | null;
  provider_result_json: string | null;
  created_at: number;
  updated_at: number;
  acked_at: number | null;
}

export function ensureMailSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS mail_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','paused','auth_required','disabled')),
      default_mailbox_id TEXT,
      credentials_ref TEXT,
      capabilities_json TEXT,
      settings_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mail_accounts_provider_status
      ON mail_accounts(provider, status);

    CREATE TABLE IF NOT EXISTS mail_mailboxes (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      normalized_address TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL CHECK(role IN ('primary','alias','shared','system','unknown')),
      status TEXT NOT NULL CHECK(status IN ('active','paused','disabled')),
      provider_mailbox_id TEXT,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
      last_synced_at INTEGER,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_id, normalized_address)
    );
    CREATE INDEX IF NOT EXISTS idx_mail_mailboxes_address
      ON mail_mailboxes(normalized_address);
    CREATE INDEX IF NOT EXISTS idx_mail_mailboxes_account_status
      ON mail_mailboxes(account_id, status);

    CREATE TABLE IF NOT EXISTS mail_threads (
      id TEXT PRIMARY KEY,
      subject_normalized TEXT,
      latest_message_at INTEGER,
      last_local_message_id TEXT,
      participants_json TEXT,
      provider_thread_refs_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mail_threads_latest
      ON mail_threads(latest_message_at DESC);

    CREATE TABLE IF NOT EXISTS mail_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
      mailbox_id TEXT NOT NULL REFERENCES mail_mailboxes(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound','draft','system')),
      status TEXT NOT NULL CHECK(status IN ('received','queued','sending','sent','delivered','failed','archived','trashed','spam')),
      rfc_message_id TEXT,
      provider_message_id TEXT,
      provider_thread_id TEXT,
      provider_history_id TEXT,
      subject TEXT,
      subject_normalized TEXT,
      snippet TEXT,
      body_text TEXT,
      body_html TEXT,
      body_redaction_status TEXT NOT NULL CHECK(body_redaction_status IN ('full_local','preview_only','redacted','missing')),
      date_header_at INTEGER,
      received_at INTEGER,
      sent_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      raw_headers_json TEXT,
      safe_payload_json TEXT,
      provider_provenance_json TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_provider_message
      ON mail_messages(account_id, mailbox_id, provider_message_id)
      WHERE provider_message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_rfc_message
      ON mail_messages(mailbox_id, rfc_message_id)
      WHERE rfc_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mail_messages_mailbox_received
      ON mail_messages(mailbox_id, received_at DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mail_messages_thread
      ON mail_messages(thread_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_mail_messages_status
      ON mail_messages(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS mail_message_addresses (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('from','to','cc','bcc','reply_to','sender')),
      address TEXT NOT NULL,
      normalized_address TEXT NOT NULL,
      display_name TEXT,
      contact_id TEXT,
      agent_id TEXT,
      platform_identity_id TEXT,
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mail_message_addresses_message
      ON mail_message_addresses(message_id, kind);
    CREATE INDEX IF NOT EXISTS idx_mail_message_addresses_normalized
      ON mail_message_addresses(normalized_address);

    CREATE TABLE IF NOT EXISTS mail_labels (
      id TEXT PRIMARY KEY,
      mailbox_id TEXT NOT NULL REFERENCES mail_mailboxes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('inbox','sent','draft','archive','trash','spam','custom')),
      provider_label_id TEXT,
      metadata_json TEXT,
      UNIQUE(mailbox_id, name)
    );

    CREATE TABLE IF NOT EXISTS mail_message_labels (
      message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES mail_labels(id) ON DELETE CASCADE,
      PRIMARY KEY(message_id, label_id)
    );

    CREATE TABLE IF NOT EXISTS mail_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
      filename TEXT,
      content_type TEXT,
      size_bytes INTEGER,
      sha256 TEXT,
      local_blob_ref TEXT,
      provider_attachment_id TEXT,
      redaction_status TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mail_attachments_message
      ON mail_attachments(message_id);

    CREATE TABLE IF NOT EXISTS mail_sync_cursors (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
      mailbox_id TEXT REFERENCES mail_mailboxes(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      cursor_type TEXT NOT NULL,
      cursor_value TEXT,
      watermark_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      last_success_at INTEGER,
      last_error_code TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_id, mailbox_id, provider, cursor_type)
    );

    CREATE TABLE IF NOT EXISTS mail_outbox (
      id TEXT PRIMARY KEY,
      mailbox_id TEXT NOT NULL REFERENCES mail_mailboxes(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation IN ('send','reply','draft','update_draft','delete_draft')),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','leased','sending','sent','acked','failed','dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      provider_result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      acked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mail_outbox_status_next
      ON mail_outbox(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_mail_outbox_mailbox
      ON mail_outbox(mailbox_id, status, created_at);
  `);
}

export function createMailAccount(input: CreateMailAccountInput): MailAccount {
  ensureMailSchema();
  const now = input.now ?? Date.now();
  const provider = requireText(input.provider, "provider") as MailProvider;
  const id = input.id?.trim() || semanticId("mail_acct", [provider, input.displayName ?? provider]);
  const displayName = input.displayName?.trim() || provider;

  return executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `
        INSERT INTO mail_accounts (
          id, provider, display_name, status, default_mailbox_id, credentials_ref,
          capabilities_json, settings_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          display_name = excluded.display_name,
          status = excluded.status,
          credentials_ref = excluded.credentials_ref,
          capabilities_json = excluded.capabilities_json,
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `,
      ).run(
        id,
        provider,
        displayName,
        input.status ?? "active",
        nullableText(input.credentialsRef),
        stableJson(input.capabilities ?? {}),
        stableJson(input.settings ?? {}),
        now,
        now,
      );
      const row = getAccountRow(id);
      if (!row) throw new Error("Failed to create mail account.");
      return rowToAccount(row);
    },
    { label: "mail_account_create" },
  );
}

export function listMailAccounts(
  options: { provider?: string; status?: MailAccountStatus; limit?: number; offset?: number } = {},
): MailAccount[] {
  ensureMailSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.provider) {
    where.push("provider = ?");
    params.push(options.provider);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = clampInt(options.limit, 100, 1, 500);
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM mail_accounts
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at ASC, id ASC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params) as MailAccountRow[];
  return rows.map(rowToAccount);
}

export function getMailAccount(id: string): MailAccount | null {
  ensureMailSchema();
  const row = getAccountRow(id);
  return row ? rowToAccount(row) : null;
}

export function createMailMailbox(input: CreateMailMailboxInput): MailMailbox {
  ensureMailSchema();
  const account = getMailAccount(input.accountId);
  if (!account) throw new Error(`Mail account not found: ${input.accountId}`);

  const now = input.now ?? Date.now();
  const normalizedAddress = normalizeEmailAddress(input.address);
  const id = input.id?.trim() || semanticId("mail_box", [input.accountId, normalizedAddress]);

  return executeWrite(
    getDb(),
    (db) => {
      if (input.isDefault) {
        db.prepare(`UPDATE mail_mailboxes SET is_default = 0, updated_at = ? WHERE account_id = ?`).run(
          now,
          input.accountId,
        );
      }
      db.prepare(
        `
        INSERT INTO mail_mailboxes (
          id, account_id, address, normalized_address, display_name, role, status,
          provider_mailbox_id, is_default, last_synced_at, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(account_id, normalized_address) DO UPDATE SET
          address = excluded.address,
          display_name = excluded.display_name,
          role = excluded.role,
          status = excluded.status,
          provider_mailbox_id = excluded.provider_mailbox_id,
          is_default = excluded.is_default,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
      ).run(
        id,
        input.accountId,
        input.address.trim(),
        normalizedAddress,
        nullableText(input.displayName),
        input.role ?? "primary",
        input.status ?? "active",
        nullableText(input.providerMailboxId),
        input.isDefault ? 1 : 0,
        stableJson(input.metadata ?? {}),
        now,
        now,
      );

      const mailbox = getMailboxByRef(input.address, input.accountId);
      if (!mailbox) throw new Error("Failed to create mail mailbox.");

      if (input.isDefault || !account.defaultMailboxId) {
        db.prepare(`UPDATE mail_accounts SET default_mailbox_id = ?, updated_at = ? WHERE id = ?`).run(
          mailbox.id,
          now,
          input.accountId,
        );
      }
      return mailbox;
    },
    { label: "mail_mailbox_create" },
  );
}

export function listMailMailboxes(
  options: { accountId?: string; status?: MailMailboxStatus; limit?: number; offset?: number } = {},
): MailMailbox[] {
  ensureMailSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.accountId) {
    where.push("account_id = ?");
    params.push(options.accountId);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = clampInt(options.limit, 100, 1, 500);
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM mail_mailboxes
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY is_default DESC, created_at ASC, id ASC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params) as MailMailboxRow[];
  return rows.map(rowToMailbox);
}

export function getMailMailbox(ref: string, accountId?: string): MailMailbox | null {
  ensureMailSchema();
  return getMailboxByRef(ref, accountId);
}

export function setMailMailboxStatus(ref: string, status: MailMailboxStatus): MailMailbox {
  ensureMailSchema();
  const mailbox = requireMailbox(ref);
  const now = Date.now();
  getDb().prepare(`UPDATE mail_mailboxes SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, mailbox.id);
  return requireMailbox(mailbox.id);
}

export function importMailMessage(input: ImportMailMessageInput): MailMessageWithAddresses {
  ensureMailSchema();
  const mailbox = requireMailbox(input.mailboxId ?? input.mailbox ?? "");
  const accountId = input.accountId ?? mailbox.accountId;
  if (accountId !== mailbox.accountId) throw new Error("mailbox/account mismatch");
  const account = getMailAccount(accountId);
  if (!account) throw new Error(`Mail account not found: ${accountId}`);

  const now = input.now ?? Date.now();
  const subject = nullableText(input.subject);
  const subjectNormalized = subject ? normalizeSubject(subject) : null;
  const receivedAt = input.receivedAt ?? (input.direction === "outbound" ? null : now);
  const sentAt = input.sentAt ?? (input.direction === "outbound" ? now : null);
  const messageTime = receivedAt ?? sentAt ?? now;
  const threadId =
    input.threadId?.trim() ||
    resolveThreadId({
      accountId,
      mailboxId: mailbox.id,
      providerThreadId: nullableText(input.providerThreadId),
      inReplyToRfcMessageId: nullableText(input.inReplyToRfcMessageId),
      referencesRfcMessageIds: input.referencesRfcMessageIds ?? [],
      rfcMessageId: nullableText(input.rfcMessageId),
      subjectNormalized,
    });
  const providerThreadRefs = input.providerThreadId
    ? { [input.provider ?? account.provider]: input.providerThreadId }
    : {};
  const participants = summarizeParticipants(input.addresses ?? []);
  const messageId = resolveMessageId(input, accountId, mailbox.id);

  return executeWrite(
    getDb(),
    (db) => {
      upsertThread({
        id: threadId,
        subjectNormalized,
        latestMessageAt: messageTime,
        lastLocalMessageId: messageId,
        participants,
        providerThreadRefs,
        now,
      });

      db.prepare(
        `
        INSERT INTO mail_messages (
          id, thread_id, mailbox_id, account_id, direction, status,
          rfc_message_id, provider_message_id, provider_thread_id, provider_history_id,
          subject, subject_normalized, snippet, body_text, body_html, body_redaction_status,
          date_header_at, received_at, sent_at, created_at, updated_at,
          raw_headers_json, safe_payload_json, provider_provenance_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          thread_id = excluded.thread_id,
          mailbox_id = excluded.mailbox_id,
          account_id = excluded.account_id,
          direction = excluded.direction,
          status = excluded.status,
          rfc_message_id = excluded.rfc_message_id,
          provider_message_id = excluded.provider_message_id,
          provider_thread_id = excluded.provider_thread_id,
          provider_history_id = excluded.provider_history_id,
          subject = excluded.subject,
          subject_normalized = excluded.subject_normalized,
          snippet = excluded.snippet,
          body_text = excluded.body_text,
          body_html = excluded.body_html,
          body_redaction_status = excluded.body_redaction_status,
          date_header_at = excluded.date_header_at,
          received_at = excluded.received_at,
          sent_at = excluded.sent_at,
          raw_headers_json = excluded.raw_headers_json,
          safe_payload_json = excluded.safe_payload_json,
          provider_provenance_json = excluded.provider_provenance_json,
          updated_at = excluded.updated_at
      `,
      ).run(
        messageId,
        threadId,
        mailbox.id,
        accountId,
        input.direction ?? "inbound",
        input.status ?? (input.direction === "outbound" ? "queued" : "received"),
        nullableText(input.rfcMessageId),
        nullableText(input.providerMessageId),
        nullableText(input.providerThreadId),
        nullableText(input.providerHistoryId),
        subject,
        subjectNormalized,
        nullableText(input.snippet) ?? buildSnippet(input.bodyText),
        nullableText(input.bodyText),
        nullableText(input.bodyHtml),
        input.bodyRedactionStatus ?? (input.bodyText || input.bodyHtml ? "full_local" : "missing"),
        input.dateHeaderAt ?? null,
        receivedAt,
        sentAt,
        now,
        now,
        stableJson({
          ...(input.rawHeaders ?? {}),
          ...(input.inReplyToRfcMessageId ? { inReplyTo: input.inReplyToRfcMessageId } : {}),
          ...(input.referencesRfcMessageIds?.length ? { references: input.referencesRfcMessageIds } : {}),
        }),
        stableJson({
          ...(input.safePayload ?? {}),
          ...(input.inReplyToRfcMessageId ? { inReplyToRfcMessageId: input.inReplyToRfcMessageId } : {}),
          ...(input.referencesRfcMessageIds?.length ? { referencesRfcMessageIds: input.referencesRfcMessageIds } : {}),
        }),
        stableJson({
          provider: input.provider ?? account.provider,
          providerMessageId: input.providerMessageId ?? null,
          providerThreadId: input.providerThreadId ?? null,
          providerHistoryId: input.providerHistoryId ?? null,
          ...(input.providerProvenance ?? {}),
        }),
      );

      replaceMessageAddresses(messageId, input.addresses ?? []);
      if (input.attachments !== undefined) {
        replaceMessageAttachments(messageId, input.attachments);
      }
      const row = getMessageRow(messageId);
      if (!row) throw new Error("Failed to import mail message.");
      return messageWithAddresses(rowToMessage(row));
    },
    { label: "mail_message_import" },
  );
}

export function listMailMessages(input: ListMailMessagesInput = {}): MailMessageWithAddresses[] | MailMessage[] {
  ensureMailSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.mailbox) {
    const mailbox = requireMailbox(input.mailbox);
    where.push("mailbox_id = ?");
    params.push(mailbox.id);
  }
  if (input.accountId) {
    where.push("account_id = ?");
    params.push(input.accountId);
  }
  if (input.threadId) {
    where.push("thread_id = ?");
    params.push(input.threadId);
  }
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.direction) {
    where.push("direction = ?");
    params.push(input.direction);
  }
  if (input.query?.trim()) {
    const pattern = `%${input.query.trim()}%`;
    where.push("(subject LIKE ? OR snippet LIKE ? OR body_text LIKE ?)");
    params.push(pattern, pattern, pattern);
  }
  const limit = clampInt(input.limit, 50, 1, 500);
  const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM mail_messages
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY COALESCE(received_at, sent_at, created_at) DESC, created_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params) as MailMessageRow[];
  const messages = rows.map(rowToMessage);
  return input.includeAddresses ? messages.map(messageWithAddresses) : messages;
}

export function readMailMessage(id: string, options: { includeAddresses?: boolean } = {}): MailMessageWithAddresses {
  ensureMailSchema();
  const row = getMessageRow(id);
  if (!row) throw new Error(`Mail message not found: ${id}`);
  const message = rowToMessage(row);
  return options.includeAddresses
    ? messageWithAddresses(message)
    : { ...message, addresses: [], attachments: listMessageAttachments(id) };
}

export function enqueueMailSend(input: EnqueueMailSendInput): {
  message: MailMessageWithAddresses;
  outbox: MailOutboxRow;
} {
  ensureMailSchema();
  const mailbox = input.from ? requireMailbox(input.from) : requireDefaultMailbox();
  const now = input.now ?? Date.now();
  const operation = input.operation ?? "send";
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    semanticId("mail_send_key", [operation, mailbox.id, input.to.join(","), input.subject, input.body, String(now)]);

  const existing = getOutboxByIdempotencyKey(idempotencyKey);
  if (existing) {
    return {
      message: readMailMessage(existing.messageId, { includeAddresses: true }),
      outbox: existing,
    };
  }

  const message = importMailMessage({
    id: semanticId("mail_msg", ["local-outbound", idempotencyKey]),
    threadId: input.threadId?.trim() || undefined,
    accountId: mailbox.accountId,
    mailboxId: mailbox.id,
    direction: "outbound",
    status: "queued",
    subject: input.subject,
    bodyText: input.body,
    snippet: buildSnippet(input.body),
    sentAt: now,
    inReplyToRfcMessageId: input.inReplyToRfcMessageId,
    referencesRfcMessageIds: input.referencesRfcMessageIds,
    addresses: [
      { kind: "from", address: mailbox.address, displayName: mailbox.displayName },
      ...input.to.map((address) => ({ kind: "to" as const, address })),
      ...(input.cc ?? []).map((address) => ({ kind: "cc" as const, address })),
      ...(input.bcc ?? []).map((address) => ({ kind: "bcc" as const, address })),
    ],
    safePayload: {
      replyToMessageId: input.replyToMessageId ?? null,
      inReplyToRfcMessageId: input.inReplyToRfcMessageId ?? null,
      referencesRfcMessageIds: input.referencesRfcMessageIds ?? [],
    },
    providerProvenance: {
      localOutbox: true,
    },
    now,
  });

  const outbox = executeWrite(
    getDb(),
    () => {
      const outboxId = semanticId("mail_out", [idempotencyKey]);
      getDb()
        .prepare(
          `
          INSERT INTO mail_outbox (
            id, mailbox_id, account_id, message_id, operation, idempotency_key, payload_json,
            status, attempt_count, next_attempt_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
        `,
        )
        .run(
          outboxId,
          mailbox.id,
          mailbox.accountId,
          message.id,
          operation,
          idempotencyKey,
          stableJson({
            from: mailbox.address,
            to: input.to,
            cc: input.cc ?? [],
            bcc: input.bcc ?? [],
            subject: input.subject,
            body: input.body,
            replyToMessageId: input.replyToMessageId ?? null,
            inReplyToRfcMessageId: input.inReplyToRfcMessageId ?? null,
            referencesRfcMessageIds: input.referencesRfcMessageIds ?? [],
          }),
          now,
          now,
        );
      const outbox = getOutboxById(outboxId);
      if (!outbox) throw new Error("Failed to create mail outbox row.");
      return outbox;
    },
    { label: "mail_send_enqueue" },
  );
  return { message, outbox };
}

export function enqueueMailReply(input: EnqueueMailReplyInput): {
  message: MailMessageWithAddresses;
  outbox: MailOutboxRow;
} {
  ensureMailSchema();
  const original = readMailMessage(input.messageId, { includeAddresses: true });
  const recipients = input.to?.length
    ? input.to
    : original.addresses
        .filter((address) => address.kind === "reply_to" || address.kind === "from")
        .map((address) => address.address);
  if (!recipients.length) throw new Error(`Mail message has no reply recipient: ${input.messageId}`);
  return enqueueMailSend({
    from: input.from ?? original.mailboxId,
    to: recipients,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject?.trim() || replySubject(original.subject),
    body: input.body,
    operation: "reply",
    replyToMessageId: original.id,
    threadId: original.threadId,
    inReplyToRfcMessageId: original.rfcMessageId,
    referencesRfcMessageIds: original.rfcMessageId ? [original.rfcMessageId] : [],
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  });
}

export function listMailOutbox(
  input: { status?: MailOutboxStatus; mailbox?: string; limit?: number; offset?: number } = {},
): MailOutboxRow[] {
  ensureMailSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.mailbox) {
    const mailbox = requireMailbox(input.mailbox);
    where.push("mailbox_id = ?");
    params.push(mailbox.id);
  }
  const limit = clampInt(input.limit, 50, 1, 500);
  const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  params.push(limit, offset);
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM mail_outbox
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(...params) as MailOutboxDbRow[];
  return rows.map(rowToOutbox);
}

export function getMailOutbox(id: string): MailOutboxRow | null {
  ensureMailSchema();
  return getOutboxById(id);
}

export function retryMailOutbox(id: string): MailOutboxRow {
  ensureMailSchema();
  const existing = getOutboxById(id);
  if (!existing) throw new Error(`Mail outbox row not found: ${id}`);
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE mail_outbox
       SET status = 'pending', next_attempt_at = 0, last_error_code = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(now, id);
  return getOutboxById(id)!;
}

function upsertThread(input: {
  id: string;
  subjectNormalized: string | null;
  latestMessageAt: number;
  lastLocalMessageId: string;
  participants: unknown[];
  providerThreadRefs: Record<string, unknown>;
  now: number;
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO mail_threads (
        id, subject_normalized, latest_message_at, last_local_message_id,
        participants_json, provider_thread_refs_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        subject_normalized = COALESCE(excluded.subject_normalized, mail_threads.subject_normalized),
        latest_message_at = MAX(COALESCE(mail_threads.latest_message_at, 0), excluded.latest_message_at),
        last_local_message_id = CASE
          WHEN excluded.latest_message_at >= COALESCE(mail_threads.latest_message_at, 0)
          THEN excluded.last_local_message_id
          ELSE mail_threads.last_local_message_id
        END,
        participants_json = excluded.participants_json,
        provider_thread_refs_json = json_patch(
          COALESCE(mail_threads.provider_thread_refs_json, '{}'),
          COALESCE(excluded.provider_thread_refs_json, '{}')
        ),
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.id,
      input.subjectNormalized,
      input.latestMessageAt,
      input.lastLocalMessageId,
      stableJson(input.participants),
      stableJson(input.providerThreadRefs),
      input.now,
      input.now,
    );
}

function replaceMessageAddresses(messageId: string, addresses: MailAddressInput[]): void {
  const db = getDb();
  db.prepare(`DELETE FROM mail_message_addresses WHERE message_id = ?`).run(messageId);
  const insert = db.prepare(
    `
    INSERT INTO mail_message_addresses (
      id, message_id, kind, address, normalized_address, display_name,
      contact_id, agent_id, platform_identity_id, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  );
  for (const input of addresses) {
    const address = requireText(input.address, "address");
    insert.run(
      uniqueId("mail_addr"),
      messageId,
      input.kind,
      address,
      normalizeEmailAddress(address),
      nullableText(input.displayName),
      nullableText(input.contactId),
      nullableText(input.agentId),
      nullableText(input.platformIdentityId),
      stableJson(input.raw ?? {}),
    );
  }
}

function replaceMessageAttachments(messageId: string, attachments: MailAttachmentInput[]): void {
  const db = getDb();
  db.prepare(`DELETE FROM mail_attachments WHERE message_id = ?`).run(messageId);
  if (attachments.length === 0) return;

  const insert = db.prepare(
    `
    INSERT INTO mail_attachments (
      id, message_id, filename, content_type, size_bytes, sha256,
      local_blob_ref, provider_attachment_id, redaction_status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  );

  for (const input of attachments) {
    const providerAttachmentId = nullableText(input.providerAttachmentId);
    const id =
      nullableText(input.id) ||
      semanticId("mail_att", [
        messageId,
        providerAttachmentId,
        input.sha256,
        input.filename,
        input.contentType,
        input.sizeBytes ?? null,
      ]);
    insert.run(
      id,
      messageId,
      nullableText(input.filename),
      nullableText(input.contentType),
      nullableInteger(input.sizeBytes),
      nullableText(input.sha256),
      nullableText(input.localBlobRef),
      providerAttachmentId,
      nullableText(input.redactionStatus),
      stableJson(input.metadata ?? {}),
    );
  }
}

function getAccountRow(id: string): MailAccountRow | null {
  return (getDb().prepare(`SELECT * FROM mail_accounts WHERE id = ?`).get(id) as MailAccountRow | undefined) ?? null;
}

function getMailboxRow(ref: string, accountId?: string): MailMailboxRow | null {
  const normalized = normalizeMaybeEmailAddress(ref);
  if (accountId) {
    return (
      (getDb()
        .prepare(`SELECT * FROM mail_mailboxes WHERE account_id = ? AND (id = ? OR normalized_address = ?)`)
        .get(accountId, ref, normalized) as MailMailboxRow | undefined) ?? null
    );
  }
  return (
    (getDb()
      .prepare(`SELECT * FROM mail_mailboxes WHERE id = ? OR normalized_address = ? ORDER BY is_default DESC LIMIT 1`)
      .get(ref, normalized) as MailMailboxRow | undefined) ?? null
  );
}

function getMailboxByRef(ref: string, accountId?: string): MailMailbox | null {
  const row = getMailboxRow(ref, accountId);
  return row ? rowToMailbox(row) : null;
}

function requireMailbox(ref: string): MailMailbox {
  if (!ref.trim()) throw new Error("Missing mailbox.");
  const mailbox = getMailboxByRef(ref);
  if (!mailbox) throw new Error(`Mail mailbox not found: ${ref}`);
  return mailbox;
}

function requireDefaultMailbox(): MailMailbox {
  const row = getDb()
    .prepare(`SELECT * FROM mail_mailboxes WHERE is_default = 1 AND status = 'active' ORDER BY created_at ASC LIMIT 1`)
    .get() as MailMailboxRow | undefined;
  if (row) return rowToMailbox(row);
  const fallback = getDb()
    .prepare(`SELECT * FROM mail_mailboxes WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`)
    .get() as MailMailboxRow | undefined;
  if (!fallback) throw new Error("No active local mailbox. Create one with `ravi mail mailboxes create`.");
  return rowToMailbox(fallback);
}

function getMessageRow(id: string): MailMessageRow | null {
  return (getDb().prepare(`SELECT * FROM mail_messages WHERE id = ?`).get(id) as MailMessageRow | undefined) ?? null;
}

function getOutboxById(id: string): MailOutboxRow | null {
  const row = getDb().prepare(`SELECT * FROM mail_outbox WHERE id = ?`).get(id) as MailOutboxDbRow | undefined;
  return row ? rowToOutbox(row) : null;
}

function getOutboxByIdempotencyKey(idempotencyKey: string): MailOutboxRow | null {
  const row = getDb().prepare(`SELECT * FROM mail_outbox WHERE idempotency_key = ?`).get(idempotencyKey) as
    | MailOutboxDbRow
    | undefined;
  return row ? rowToOutbox(row) : null;
}

function resolveMessageId(input: ImportMailMessageInput, accountId: string, mailboxId: string): string {
  if (input.id?.trim()) return input.id.trim();
  const providerMessageId = nullableText(input.providerMessageId);
  if (providerMessageId) return semanticId("mail_msg", ["provider", accountId, mailboxId, providerMessageId]);
  const rfcMessageId = nullableText(input.rfcMessageId);
  if (rfcMessageId) return semanticId("mail_msg", ["rfc", mailboxId, rfcMessageId]);
  const idempotencyKey = nullableText(input.idempotencyKey);
  if (idempotencyKey) return semanticId("mail_msg", ["idem", accountId, mailboxId, idempotencyKey]);
  return uniqueId("mail_msg");
}

function resolveThreadId(input: {
  accountId: string;
  mailboxId: string;
  providerThreadId: string | null;
  inReplyToRfcMessageId: string | null;
  referencesRfcMessageIds: string[];
  rfcMessageId: string | null;
  subjectNormalized: string | null;
}): string {
  if (input.inReplyToRfcMessageId) {
    const threadId = findThreadIdByRfcMessageId(input.mailboxId, input.inReplyToRfcMessageId);
    if (threadId) return threadId;
  }
  for (const reference of input.referencesRfcMessageIds) {
    const threadId = findThreadIdByRfcMessageId(input.mailboxId, reference);
    if (threadId) return threadId;
  }
  if (input.providerThreadId) return semanticId("mail_thr", ["provider", input.accountId, input.providerThreadId]);
  if (input.rfcMessageId) return semanticId("mail_thr", ["rfc", input.mailboxId, input.rfcMessageId]);
  if (input.subjectNormalized) return semanticId("mail_thr", ["subject", input.mailboxId, input.subjectNormalized]);
  return uniqueId("mail_thr");
}

function findThreadIdByRfcMessageId(mailboxId: string, rfcMessageId: string): string | null {
  const row = getDb()
    .prepare(`SELECT thread_id FROM mail_messages WHERE mailbox_id = ? AND rfc_message_id = ? LIMIT 1`)
    .get(mailboxId, rfcMessageId) as { thread_id: string } | undefined;
  return row?.thread_id ?? null;
}

function messageWithAddresses(message: MailMessage): MailMessageWithAddresses {
  const addressRows = getDb()
    .prepare(`SELECT * FROM mail_message_addresses WHERE message_id = ? ORDER BY rowid ASC`)
    .all(message.id) as MailAddressRow[];
  return {
    ...message,
    addresses: addressRows.map(rowToAddress),
    attachments: listMessageAttachments(message.id),
  };
}

function listMessageAttachments(messageId: string): MailAttachment[] {
  const rows = getDb()
    .prepare(`SELECT * FROM mail_attachments WHERE message_id = ? ORDER BY rowid ASC`)
    .all(messageId) as MailAttachmentRow[];
  return rows.map(rowToAttachment);
}

function rowToAccount(row: MailAccountRow): MailAccount {
  return {
    id: row.id,
    provider: row.provider as MailProvider,
    displayName: row.display_name,
    status: row.status,
    defaultMailboxId: row.default_mailbox_id,
    credentialsRef: row.credentials_ref,
    capabilities: parseJsonObject(row.capabilities_json),
    settings: parseJsonObject(row.settings_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMailbox(row: MailMailboxRow): MailMailbox {
  return {
    id: row.id,
    accountId: row.account_id,
    address: row.address,
    normalizedAddress: row.normalized_address,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    providerMailboxId: row.provider_mailbox_id,
    isDefault: row.is_default === 1,
    lastSyncedAt: row.last_synced_at,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToThread(row: MailThreadRow): MailThread {
  return {
    id: row.id,
    subjectNormalized: row.subject_normalized,
    latestMessageAt: row.latest_message_at,
    lastLocalMessageId: row.last_local_message_id,
    participants: parseJsonArray(row.participants_json),
    providerThreadRefs: parseJsonObject(row.provider_thread_refs_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MailMessageRow): MailMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    mailboxId: row.mailbox_id,
    accountId: row.account_id,
    direction: row.direction,
    status: row.status,
    rfcMessageId: row.rfc_message_id,
    providerMessageId: row.provider_message_id,
    providerThreadId: row.provider_thread_id,
    providerHistoryId: row.provider_history_id,
    subject: row.subject,
    subjectNormalized: row.subject_normalized,
    snippet: row.snippet,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    bodyRedactionStatus: row.body_redaction_status,
    dateHeaderAt: row.date_header_at,
    receivedAt: row.received_at,
    sentAt: row.sent_at,
    rawHeaders: parseJsonObject(row.raw_headers_json),
    safePayload: parseJsonObject(row.safe_payload_json),
    providerProvenance: parseJsonObject(row.provider_provenance_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAddress(row: MailAddressRow): MailAddress {
  return {
    id: row.id,
    messageId: row.message_id,
    kind: row.kind as MailAddress["kind"],
    address: row.address,
    normalizedAddress: row.normalized_address,
    displayName: row.display_name,
    contactId: row.contact_id,
    agentId: row.agent_id,
    platformIdentityId: row.platform_identity_id,
    raw: parseJsonObject(row.raw_json),
  };
}

function rowToAttachment(row: MailAttachmentRow): MailAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    localBlobRef: row.local_blob_ref,
    providerAttachmentId: row.provider_attachment_id,
    redactionStatus: row.redaction_status,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function rowToOutbox(row: MailOutboxDbRow): MailOutboxRow {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    accountId: row.account_id,
    messageId: row.message_id,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    payload: parseJsonObject(row.payload_json),
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    providerResult: row.provider_result_json ? parseJsonObject(row.provider_result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ackedAt: row.acked_at,
  };
}

export function normalizeEmailAddress(address: string): string {
  const value = address.trim().toLowerCase().normalize("NFKC");
  if (!value || !value.includes("@")) throw new Error(`Invalid email address: ${address}`);
  return value;
}

function normalizeMaybeEmailAddress(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes("@") ? normalizeEmailAddress(trimmed) : trimmed;
}

function normalizeSubject(value: string): string {
  return value
    .trim()
    .replace(/^(re|fw|fwd):\s*/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function buildSnippet(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function replySubject(subject: string | null | undefined): string {
  const value = subject?.trim();
  if (!value) return "Re: (sem assunto)";
  return /^re:/i.test(value) ? value : `Re: ${value}`;
}

function summarizeParticipants(addresses: MailAddressInput[]): Array<{ kind: string; address: string; name?: string }> {
  return addresses
    .filter((address) => address.address?.trim())
    .map((address) => ({
      kind: address.kind,
      address: normalizeEmailAddress(address.address),
      ...(address.displayName ? { name: address.displayName } : {}),
    }));
}

function semanticId(prefix: string, parts: Array<string | number | null | undefined>): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\x1f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requireText(value: string | undefined | null, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`Missing ${label}.`);
  return text;
}

function nullableText(value: string | undefined | null): string | null {
  const text = value?.trim();
  return text || null;
}

function nullableInteger(value: number | undefined | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function getMailThread(id: string): MailThread | null {
  ensureMailSchema();
  const row = getDb().prepare(`SELECT * FROM mail_threads WHERE id = ?`).get(id) as MailThreadRow | undefined;
  return row ? rowToThread(row) : null;
}
