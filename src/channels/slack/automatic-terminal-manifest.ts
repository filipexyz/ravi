import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { getDb } from "../../router/router-db.js";
import type { MessageTarget, ResponseMediaAttachment } from "../../runtime/message-types.js";

export interface SlackAutomaticTerminalManifestInput {
  turnId: string;
  sourceId: string;
  sourceReceivedAt: number;
  scope: string;
  /** Canonical authorized projection destination, frozen before release. */
  target: MessageTarget;
  kind: "final_answer" | "safe_error" | "cancelled";
  text: string;
  media: readonly ResponseMediaAttachment[];
}

export interface SlackAutomaticTerminalManifest {
  responseId: string;
  requestFingerprint: string;
  turnId: string;
  sourceId: string;
  sourceReceivedAt: number;
  scope: string;
  target: MessageTarget;
  kind: SlackAutomaticTerminalManifestInput["kind"];
  textFingerprint: string;
  mediaFingerprints: readonly string[];
  /** Digest of actual frozen file bytes, or null for an unavailable member. */
  mediaByteFingerprints: readonly (string | null)[];
  /** Immutable per-member failures; never store filesystem errors or paths. */
  mediaAvailabilityErrors: readonly ("file_unavailable" | null)[];
}

/** Hash identities and part membership only; do not duplicate bodies or file paths in the ledger. */
export function prepareSlackAutomaticTerminalManifest(
  input: SlackAutomaticTerminalManifestInput,
): SlackAutomaticTerminalManifest {
  requireText(input.turnId, "turnId");
  requireText(input.sourceId, "sourceId");
  requireText(input.scope, "scope");
  if (!Number.isSafeInteger(input.sourceReceivedAt) || input.sourceReceivedAt < 0) {
    throw new Error("Terminal source acceptance time is required");
  }
  const target = canonicalTarget(input.target);
  const responseId = slackAutomaticTerminalResponseId(input.turnId, target);
  const mediaBytes = input.media.map((media) => {
    try {
      return { fingerprint: fingerprintMediaFile(media.filePath), error: null };
    } catch {
      // Keep the failed ordinal in the complete terminal. A missing attachment
      // must not prevent text or other attachments from reaching delivery.
      return { fingerprint: null, error: "file_unavailable" as const };
    }
  });
  const content = {
    responseId,
    turnId: input.turnId,
    sourceId: input.sourceId,
    sourceReceivedAt: input.sourceReceivedAt,
    scope: input.scope,
    target,
    kind: input.kind,
    textFingerprint: fingerprint(input.text),
    mediaFingerprints: input.media.map((media) => fingerprint(media)),
    mediaByteFingerprints: mediaBytes.map((media) => media.fingerprint),
    mediaAvailabilityErrors: mediaBytes.map((media) => media.error),
  };
  return { ...content, requestFingerprint: fingerprint(content) };
}

/** Persist within the caller's transaction, without reading attachment files again. */
export function persistPreparedSlackAutomaticTerminalManifest(
  database: Database,
  prepared: SlackAutomaticTerminalManifest,
): SlackAutomaticTerminalManifest {
  database
    .prepare(`INSERT OR IGNORE INTO slack_automatic_terminal_manifests
      (response_id, request_fingerprint, manifest_json) VALUES (?, ?, ?)`)
    .run(prepared.responseId, prepared.requestFingerprint, JSON.stringify(prepared));
  const saved = readManifest(database, prepared.responseId);
  if (!saved || saved.requestFingerprint !== prepared.requestFingerprint) {
    throw new Error("Slack automatic terminal manifest identity conflict");
  }
  return saved;
}

export function freezeSlackAutomaticTerminalManifest(
  input: SlackAutomaticTerminalManifestInput,
): SlackAutomaticTerminalManifest {
  const prepared = prepareSlackAutomaticTerminalManifest(input);
  const database = getDb();
  return database.transaction(() => persistPreparedSlackAutomaticTerminalManifest(database, prepared)).immediate();
}

export function slackAutomaticTerminalResponseId(turnId: string, target: MessageTarget): string {
  requireText(turnId, "turnId");
  const destination = canonicalTarget(target);
  return `slack-terminal:${fingerprint([
    turnId,
    destination.accountId,
    destination.instanceId,
    destination.chatId,
    destination.threadId ?? null,
  ])}`;
}

export function getSlackAutomaticTerminalManifest(responseId: string): SlackAutomaticTerminalManifest | null {
  requireText(responseId, "responseId");
  const database = getDb();
  return readManifest(database, responseId);
}

/** Returns a stable delivery identity for this exact frozen part, never for newly appended content. */
export function assertSlackAutomaticTerminalPart(
  manifest: SlackAutomaticTerminalManifest,
  part: { type: "text"; text: string } | { type: "media"; index: number; media: ResponseMediaAttachment },
): string {
  if (manifest.kind === "cancelled") throw new Error("Cancelled Slack automatic terminal has no deliverable parts");
  if (part.type === "text") {
    if (fingerprint(part.text) !== manifest.textFingerprint) {
      throw new Error("Text is not part of the frozen Slack automatic terminal");
    }
    return `${manifest.responseId}:text`;
  }
  if (
    !Number.isSafeInteger(part.index) ||
    part.index < 0 ||
    manifest.mediaFingerprints[part.index] !== fingerprint(part.media)
  ) {
    throw new Error("Media is not part of the frozen Slack automatic terminal at this ordinal");
  }
  return `${manifest.responseId}:media:${part.index}`;
}

/** Read only for a fresh upload. Receipted retries must not need the local file. */
export function readSlackAutomaticTerminalMediaBytes(
  manifest: SlackAutomaticTerminalManifest,
  part: { index: number; media: ResponseMediaAttachment },
): Buffer {
  assertSlackAutomaticTerminalPart(manifest, { type: "media", ...part });
  if (manifest.mediaAvailabilityErrors[part.index] !== null) {
    throw new Error("Media was unavailable when the Slack automatic terminal was frozen");
  }
  // The existing Slack uploader already reads the complete file once. Return
  // that same verified buffer to it, closing the hash-then-reopen race without
  // an additional copy, a new file-size cap, or storing bytes in the ledger.
  const bytes = readFileSync(part.media.filePath);
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.mediaByteFingerprints[part.index]) {
    throw new Error("Media bytes changed after the Slack automatic terminal was frozen");
  }
  return bytes;
}

function fingerprintMediaFile(filePath: string): string {
  const descriptor = openSync(filePath, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let length: number;
    while ((length = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, length));
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function canonicalTarget(target: MessageTarget): MessageTarget {
  if (target.channel !== "slack") throw new Error("Slack automatic terminal requires a Slack destination");
  requireText(target.accountId, "target.accountId");
  requireText(target.instanceId, "target.instanceId");
  requireText(target.chatId, "target.chatId");
  return {
    channel: "slack",
    accountId: target.accountId,
    instanceId: target.instanceId,
    chatId: target.chatId,
    ...(target.threadId ? { threadId: target.threadId } : {}),
    ...(target.canonicalChatId ? { canonicalChatId: target.canonicalChatId } : {}),
  };
}

function fingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
  if (canonical === undefined) throw new Error("Slack automatic terminal value cannot be fingerprinted");
  return createHash("sha256").update(canonical).digest("hex");
}

function readManifest(database: Database, responseId: string): SlackAutomaticTerminalManifest | null {
  const row = database
    .prepare("SELECT manifest_json FROM slack_automatic_terminal_manifests WHERE response_id = ?")
    .get(responseId) as { manifest_json: string } | null;
  return row ? (JSON.parse(row.manifest_json) as SlackAutomaticTerminalManifest) : null;
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
}
