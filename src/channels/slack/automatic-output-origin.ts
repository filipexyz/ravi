import { dbGetChannelBackendIngressReceiptByTurnId, dbGetChatMessage } from "../../router/router-db.js";
import type {
  ChannelAutomaticOutputOrigin,
  ChannelBackendPromptMetadata,
  MessageTarget,
} from "../../runtime/message-types.js";
import { resolveOutboundAccount, type OutboundAccountResolution } from "../account-resolution.js";
import type { ChannelOutboundJob } from "../outbound-stream.js";
import { decodeSlackBackendConversationId } from "./socket-mode.js";

export interface SlackAutomaticOutputContext {
  readonly turnId: string;
  readonly sourceId: string;
  readonly sourceReceivedAt: number;
  readonly senderKind: "bot";
  readonly scope: string;
  readonly target: MessageTarget;
}

export class SlackAutomaticOutputOriginError extends Error {
  readonly code = "SLACK_AUTOMATIC_OUTPUT_ORIGIN_INVALID";

  constructor(reason: string) {
    super(`Invalid Slack automatic output origin: ${reason}`);
    this.name = "SlackAutomaticOutputOriginError";
  }
}

export interface SlackAutomaticOutputOriginDependencies {
  getReceipt?: typeof dbGetChannelBackendIngressReceiptByTurnId;
  getMessage?: typeof dbGetChatMessage;
  resolveAccount?: (accountId: string) => OutboundAccountResolution;
}

const bindingFields = ["channelInstanceId", "agentId", "chatId", "messageId", "sessionId", "turnId"] as const;

/**
 * Validate the six required binding strings, copy the binding, and freeze both
 * objects so later mutation of the input cannot redirect queued output. This
 * snapshot preserves field values; it does not establish ingress provenance.
 */
export function createChannelBackendAutomaticOutputOrigin(
  binding: ChannelBackendPromptMetadata["binding"],
): ChannelAutomaticOutputOrigin {
  assertBinding(binding);
  return Object.freeze({ kind: "channel_backend", binding: Object.freeze({ ...binding }) });
}

/**
 * Match the complete binding to its durable ingress receipt and canonical input.
 * Return null for non-Slack ingress, the sanctioned Ravi actor producer, or a
 * canonical user sender regardless of actor resolution. Invalid native ingress
 * throws SlackAutomaticOutputOriginError instead of escaping the automatic guard.
 *
 * Bot context uses the receipt's local acceptance time and authorized destination.
 * Source and destination account aliases must resolve to the same installation;
 * its quota scope is shared across threads in a channel, while the frozen target
 * preserves the specific thread. No mutable session latest-source state is used.
 */
export function resolveSlackAutomaticOutputContextFromBinding(
  binding: ChannelBackendPromptMetadata["binding"],
  dependencies: SlackAutomaticOutputOriginDependencies = {},
): SlackAutomaticOutputContext | null {
  assertBinding(binding);
  const receipt = (dependencies.getReceipt ?? dbGetChannelBackendIngressReceiptByTurnId)(binding.turnId);
  if (!receipt) invalid("ingress receipt missing");
  const persistedBinding = {
    channelInstanceId: receipt.channelInstanceId,
    agentId: receipt.agentId,
    chatId: receipt.chatId,
    messageId: receipt.messageId,
    sessionId: receipt.sessionName,
    turnId: receipt.turnId,
  };
  if (bindingFields.some((field) => binding[field] !== persistedBinding[field])) invalid("ingress binding mismatch");
  if (receipt.external.channelKind !== "slack") return null;

  const message = (dependencies.getMessage ?? dbGetChatMessage)(receipt.messageId);
  if (!message) invalid("canonical input missing");
  if (message.id !== receipt.messageId || message.chatId !== receipt.chatId) invalid("canonical input mismatch");
  // Generic actor-authored backend ingress is a separate sanctioned producer.
  // It owns a local Ravi Message, not a Slack Socket Mode message or sender kind.
  if (
    message.channel === "ravi" &&
    message.instanceId === "" &&
    message.actorType === "actor" &&
    message.actorId === receipt.localActorId &&
    message.clientMessageId &&
    !message.rawProvenance
  ) {
    return null;
  }
  if (
    message.channel !== "slack" ||
    message.instanceId !== receipt.channelInstanceId ||
    message.providerMessageId !== receipt.external.messageId ||
    message.rawProvenance?.source !== "slack.socket_mode"
  ) {
    invalid("canonical input mismatch");
  }
  const senderKind = message.rawProvenance.senderKind;
  if (senderKind !== "bot" && senderKind !== "user") invalid("canonical sender kind missing");
  if (senderKind === "user") return null;
  if (!Number.isSafeInteger(receipt.acceptedAt) || receipt.acceptedAt < 0) invalid("local acceptance time missing");

  let destination: ReturnType<typeof decodeSlackBackendConversationId>;
  try {
    destination = decodeSlackBackendConversationId(receipt.external.conversationId);
  } catch {
    return invalid("canonical destination malformed");
  }
  if (!destination.channelId || message.rawChatId !== destination.channelId) invalid("canonical channel mismatch");
  const account = resolveNativeAccount(receipt.external.connectionId, dependencies);
  const sourceAccount = resolveNativeAccount(receipt.channelInstanceId, dependencies);
  if (installationKey(account) !== installationKey(sourceAccount)) invalid("canonical installation mismatch");
  const target: MessageTarget = Object.freeze({
    channel: "slack",
    accountId: account.channelName,
    instanceId: account.channelName,
    chatId: destination.channelId,
    ...(destination.threadTs ? { threadId: destination.threadTs } : {}),
    canonicalChatId: receipt.chatId,
  });
  return Object.freeze({
    turnId: receipt.turnId,
    sourceId: receipt.messageId,
    sourceReceivedAt: receipt.acceptedAt,
    senderKind,
    scope: JSON.stringify(["slack", installationKey(account), destination.channelId]),
    target,
  });
}

/**
 * Resolve a job's durable automatic origin and validate both its request-level
 * destination and nested target, including every supplied account/instance alias.
 * A missing origin is out of scope only without an automatic terminal ID; other
 * invalid origins or redirected destinations throw SlackAutomaticOutputOriginError.
 * A null binding context remains outside this guard. A valid context establishes
 * provenance and destination, not terminal membership or quota admission.
 */
export function resolveSlackAutomaticOutputContext(
  job: ChannelOutboundJob,
  dependencies: SlackAutomaticOutputOriginDependencies = {},
): SlackAutomaticOutputContext | null {
  const origin = job.request.origin.automatic;
  if (origin === undefined) {
    if (job.request.origin.automaticTerminalResponseId !== undefined) invalid("terminal manifest has no origin");
    return null;
  }
  if (!origin || origin.kind !== "channel_backend") invalid("unsupported automatic origin");
  const context = resolveSlackAutomaticOutputContextFromBinding(origin.binding, dependencies);
  if (!context) return null;
  const target = job.request.target;
  if (
    typeof job.request.channelId !== "string" ||
    job.request.channelId.toLowerCase() !== "slack" ||
    job.request.targetChatId !== context.target.chatId ||
    job.request.targetThreadId !== context.target.threadId
  ) {
    invalid("output escaped the authorized destination");
  }
  assertSlackAutomaticOutputTarget(context, target, dependencies);
  for (const accountId of [job.request.accountId, job.request.instanceId]) {
    if (accountId === undefined) continue;
    const account = resolveNativeAccount(accountId, dependencies);
    if (JSON.stringify(["slack", installationKey(account), target.chatId]) !== context.scope) {
      invalid("output escaped the authorized installation");
    }
  }
  return context;
}

/**
 * Require Slack, the exact authorized chat/thread, and the same installation for
 * every supplied account/instance alias. The context must already come from
 * validated durable ingress; this check does not establish its provenance.
 * Throws SlackAutomaticOutputOriginError on mismatch and also serves media
 * without requiring a text delivery job.
 */
export function assertSlackAutomaticOutputTarget(
  context: SlackAutomaticOutputContext,
  target: MessageTarget,
  dependencies: SlackAutomaticOutputOriginDependencies = {},
): void {
  if (
    typeof target.channel !== "string" ||
    target.channel.toLowerCase() !== "slack" ||
    target.chatId !== context.target.chatId ||
    target.threadId !== context.target.threadId
  ) {
    invalid("output escaped the authorized destination");
  }
  for (const accountId of [target.accountId, target.instanceId]) {
    if (accountId === undefined) continue;
    const account = resolveNativeAccount(accountId, dependencies);
    if (JSON.stringify(["slack", installationKey(account), target.chatId]) !== context.scope) {
      invalid("output escaped the authorized installation");
    }
  }
}

/**
 * Resolve an alias only to a native Slack account; another adapter/provider is
 * rejected with SlackAutomaticOutputOriginError rather than used as a fallback.
 */
function resolveNativeAccount(
  accountId: string,
  dependencies: SlackAutomaticOutputOriginDependencies,
): Extract<OutboundAccountResolution, { kind: "native" }> {
  const account = dependencies.resolveAccount
    ? dependencies.resolveAccount(accountId)
    : resolveOutboundAccount(accountId, { channel: "slack" });
  if (account.kind !== "native" || account.provider !== "slack") invalid("native installation unresolved");
  return account;
}

/**
 * Define installation equivalence by the trimmed credential connection, falling
 * back to channel name, then lowercasing. This normalization is part of persisted
 * quota identity, so aliases of the same installation share the channel budget.
 */
function installationKey(account: Extract<OutboundAccountResolution, { kind: "native" }>): string {
  return (account.channel.credentialConnection?.trim() || account.channelName).toLowerCase();
}

/**
 * Check required fields without normalizing their values; durable receipt
 * comparison, not string presence, establishes the binding's provenance.
 */
function assertBinding(binding: ChannelBackendPromptMetadata["binding"]): void {
  if (!binding || bindingFields.some((field) => typeof binding[field] !== "string" || !binding[field].trim())) {
    invalid("binding malformed");
  }
}

function invalid(reason: string): never {
  throw new SlackAutomaticOutputOriginError(reason);
}
