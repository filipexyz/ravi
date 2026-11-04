import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { getDb } from "../../router/router-db.js";
import type { MessageTarget, ResponseMediaAttachment } from "../../runtime/message-types.js";
import { reportErrorDiagnostic } from "../../utils/error-reporting.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("channels:slack:automatic-terminal-manifest");

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

/**
 * Prepare terminal identity and ordered membership without persisting anything.
 * The caller must supply an already authorized canonical target and trusted local
 * acceptance time. Descriptor hashes and file-byte hashes are separate; an
 * unavailable file retains its ordinal with a sanitized error and null byte hash.
 *
 * This records digests, not bodies, file paths or a snapshot of attachment bytes.
 * It does not Object.freeze the result: keep the prepared object unchanged until
 * persistence, and verify current bytes again before a fresh upload.
 */
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
    } catch (error) {
      // Keep the failed ordinal in the complete terminal. A missing attachment
      // must not prevent text or other attachments from reaching delivery.
      return unavailableMediaFingerprint(error);
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

/** Diagnose the failure without adding mutable error details to immutable identity. */
function unavailableMediaFingerprint(error: unknown): { fingerprint: null; error: "file_unavailable" } {
  reportErrorDiagnostic(log, "Could not fingerprint an automatic-terminal media file", error, {
    operation: "slack_terminal_media_fingerprint",
  });
  return { fingerprint: null, error: "file_unavailable" };
}

/**
 * Persist an unchanged prepared manifest using the caller's initialized Database
 * and transaction, without opening a transaction or rereading attachment files.
 * To commit it atomically with runtime terminal state, both writes must share
 * that same Database and transaction.
 *
 * Reusing an ID with the same fingerprint returns the saved manifest. A conflicting
 * fingerprint leaves the original row intact and throws; this does not recompute
 * hashes, authorize the target, reserve quota or prove transport delivery.
 */
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

/**
 * Prepare outside an IMMEDIATE transaction, then persist within it. This wrapper
 * records only the manifest, not a runtime terminal event; use prepare/persist
 * with the caller's shared transaction when both records must commit together.
 * Reinvocation hashes files again and can conflict if their bytes changed.
 */
export function freezeSlackAutomaticTerminalManifest(
  input: SlackAutomaticTerminalManifestInput,
): SlackAutomaticTerminalManifest {
  const prepared = prepareSlackAutomaticTerminalManifest(input);
  const database = getDb();
  return database.transaction(() => persistPreparedSlackAutomaticTerminalManifest(database, prepared)).immediate();
}

/**
 * Derive one response ID from turn, account, instance, chat and optional thread.
 * Content, outcome, source and canonicalChatId are excluded from this ID; changes
 * to those manifest fields instead conflict through the full request fingerprint.
 * The target must already use authorized canonical account names, not aliases.
 */
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

/**
 * Read a saved manifest or null from the initialized database. Lookup neither
 * admits output nor authorizes its destination or checks attachment availability.
 */
export function getSlackAutomaticTerminalManifest(responseId: string): SlackAutomaticTerminalManifest | null {
  requireText(responseId, "responseId");
  const database = getDb();
  return readManifest(database, responseId);
}

/**
 * Check membership and return the stable :text or :media:index delivery identity.
 * Cancelled manifests reject every part; text must match its hash, and media must
 * match the descriptor at a safe nonnegative ordinal. Equal descriptors at two
 * ordinals remain distinct parts. This checks no current file bytes and does not
 * establish manifest persistence, quota admission or delivery authorization.
 */
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

/**
 * Read only after receipt lookup establishes that a fresh upload is required;
 * receipted retries must not depend on the local file. Reject a nonmember,
 * originally unavailable member, unreadable file or changed byte digest.
 * Pass the exact verified Buffer to transport rather than reopening its path,
 * so upload uses the bytes checked here. This function does not persist the bytes.
 */
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

/**
 * Hash observed file bytes with SHA-256 in 64 KiB chunks and close the descriptor
 * even on read failure. Errors propagate for preparation to sanitize; this does
 * not lock the file or retain a byte snapshot against concurrent modification.
 */
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

/**
 * Copy the supported Slack destination fields, requiring nonblank account,
 * instance and chat strings and retaining truthy optional IDs. Values remain
 * unnormalized: callers must resolve aliases and authorize the destination first.
 */
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

/**
 * Hash JSON with recursively sorted object keys and original array order.
 * JSON serialization semantics and SHA-256 together define persisted manifest
 * identity; this is distinct from hashing raw file bytes. Unsupported top-level
 * values or serialization errors throw rather than yielding an identity.
 */
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

/**
 * Deserialize a trusted stored row or return null. This neither validates the
 * manifest shape nor recomputes its fingerprint; malformed stored JSON throws.
 */
function readManifest(database: Database, responseId: string): SlackAutomaticTerminalManifest | null {
  const row = database
    .prepare("SELECT manifest_json FROM slack_automatic_terminal_manifests WHERE response_id = ?")
    .get(responseId) as { manifest_json: string } | null;
  return row ? (JSON.parse(row.manifest_json) as SlackAutomaticTerminalManifest) : null;
}

/** Reject blank identity fields without trimming the values used in fingerprints. */
function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
}
