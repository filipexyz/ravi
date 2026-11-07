import { realpathSync } from "node:fs";
import { dbGetChannelBackendRuntimeState, getDb } from "../../router/router-db.js";
import type { GeneratedMediaAllocation } from "../../runtime/generated-media-allocation.js";
import type {
  ChannelAutomaticOutputOrigin,
  ChannelBackendPromptMetadata,
  ResponseMediaAttachment,
} from "../../runtime/message-types.js";
import {
  createChannelBackendAutomaticOutputOrigin,
  resolveSlackAutomaticOutputContextFromBinding,
  type SlackAutomaticOutputContext,
} from "./automatic-output-origin.js";
import {
  getSlackAutomaticTerminalManifest,
  slackAutomaticTerminalResponseId,
  type SlackAutomaticTerminalManifest,
} from "./automatic-terminal-manifest.js";

export interface SlackAutomaticPendingReply {
  context: SlackAutomaticOutputContext;
  origin: ChannelAutomaticOutputOrigin;
  media: ResponseMediaAttachment[];
  mediaKeys: Set<string>;
  /** Private producer capabilities, never reconstructed from serialized descriptors. */
  ownedMediaAllocations: Set<GeneratedMediaAllocation>;
  manifest?: SlackAutomaticTerminalManifest;
  mediaReleased?: boolean;
}

// Only pending logical replies live here. Provider relaunches and SQLite reopen
// in this process keep them; process exit loses them. This is not an outbox.
// Canonical database paths isolate projects/test states without tying lifetime
// to a replaceable Database or RuntimeHostStreamingSession object.
const pendingByDatabase = new Map<string, Map<string, SlackAutomaticPendingReply>>();

/**
 * Key process-local state by the SQLite file's real path, merging path aliases
 * and surviving Database object reopen. The database path must exist and resolve.
 */
function databaseKey(): string {
  return realpathSync(getDb().filename);
}

/**
 * Get or create the mutable reply accumulator for this physical database and
 * turn after validating durable ingress. Return undefined for out-of-scope input;
 * mismatched source, acceptance time, scope, target or binding throws.
 * A persisted manifest or terminal runtime state discards the registry entry
 * and throws, preventing a terminal logical reply from being opened again.
 *
 * The accumulator survives provider relaunch and Database reopen in this process,
 * but is lost on process exit. Its media descriptors are not a durable outbox,
 * and a locally prepared manifest alone does not establish durable terminal state.
 */
export function getSlackAutomaticPendingReply(
  metadata: ChannelBackendPromptMetadata | undefined,
): SlackAutomaticPendingReply | undefined {
  if (metadata?.target.channelKind !== "slack") return undefined;
  const context = resolveSlackAutomaticOutputContextFromBinding(metadata.binding);
  if (!context) return undefined;
  const key = databaseKey();
  const pending = pendingByDatabase.get(key);
  const runtime = dbGetChannelBackendRuntimeState(context.turnId);
  if (
    getSlackAutomaticTerminalManifest(slackAutomaticTerminalResponseId(context.turnId, context.target)) ||
    runtime?.state === "completed" ||
    runtime?.state === "failed" ||
    runtime?.state === "interrupted"
  ) {
    discardSlackAutomaticPendingReply(metadata.binding);
    throw new Error("Slack automatic logical reply is already terminal");
  }
  const existing = pending?.get(context.turnId);
  if (existing) {
    if (
      existing.context.sourceId !== context.sourceId ||
      existing.context.sourceReceivedAt !== context.sourceReceivedAt ||
      existing.context.scope !== context.scope ||
      JSON.stringify(existing.context.target) !== JSON.stringify(context.target) ||
      Object.entries(existing.origin.binding).some(
        ([field, value]) => metadata.binding[field as keyof typeof metadata.binding] !== value,
      )
    )
      throw new Error("Slack automatic pending reply identity conflict");
    return existing;
  }
  const reply: SlackAutomaticPendingReply = {
    context,
    origin: createChannelBackendAutomaticOutputOrigin(metadata.binding),
    media: [],
    mediaKeys: new Set(),
    ownedMediaAllocations: new Set(),
  };
  const entries = pending ?? new Map<string, SlackAutomaticPendingReply>();
  entries.set(context.turnId, reply);
  pendingByDatabase.set(key, entries);
  return reply;
}

/**
 * Idempotently remove registry ownership for the current database and turn.
 * Return the detached reply so an accepted terminal can settle its private
 * allocation capabilities. In-flight work keeps its local copy; removal alone
 * grants no file-disposal authority and changes no durable state.
 */
export function discardSlackAutomaticPendingReply(
  binding: ChannelBackendPromptMetadata["binding"],
): SlackAutomaticPendingReply | undefined {
  const key = databaseKey();
  const entries = pendingByDatabase.get(key);
  const reply = entries?.get(binding.turnId);
  entries?.delete(binding.turnId);
  if (entries?.size === 0) pendingByDatabase.delete(key);
  return reply;
}

/** Aggregate only: test cleanup/lifetime observability, never expose descriptors. */
export function countSlackAutomaticPendingReplies(): number {
  return pendingByDatabase.get(databaseKey())?.size ?? 0;
}
