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

/** Snapshot at projection time; the queue must not retain a mutable binding object. */
export function createChannelBackendAutomaticOutputOrigin(
  binding: ChannelBackendPromptMetadata["binding"],
): ChannelAutomaticOutputOrigin {
  assertBinding(binding);
  return Object.freeze({ kind: "channel_backend", binding: Object.freeze({ ...binding }) });
}

/** Resolve only the durable native ingress. Unknown actors are human when the canonical senderKind is user. */
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

/** Explicit actions and non-native responses have no automatic binding and remain outside this projection. */
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

/** Media uses this same destination check without fabricating a text delivery job. */
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

function installationKey(account: Extract<OutboundAccountResolution, { kind: "native" }>): string {
  return (account.channel.credentialConnection?.trim() || account.channelName).toLowerCase();
}

function assertBinding(binding: ChannelBackendPromptMetadata["binding"]): void {
  if (!binding || bindingFields.some((field) => typeof binding[field] !== "string" || !binding[field].trim())) {
    invalid("binding malformed");
  }
}

function invalid(reason: string): never {
  throw new SlackAutomaticOutputOriginError(reason);
}
