import { CliExpectedError } from "../../cli/expected-error.js";
import { executeWrite } from "../../db/write-retry.js";
import { getAgent, loadRouterConfig } from "../../router/index.js";
import { dbGetChat, getDb } from "../../router/router-db.js";
import {
  clearProviderSession,
  getSession,
  listSessionSubscriptions,
  updateSessionEffortOverride,
  updateSessionModelOverride,
  updateSessionRuntimeProviderOverride,
  updateSessionThinkingLevel,
} from "../../router/sessions.js";
import type { SessionEntry } from "../../router/types.js";
import {
  rematerializeSessionToAgentRuntime,
  resolveAgentRuntimeDefaultProvider,
} from "../../runtime/agent-session-runtime-sync.js";
import { parseRuntimeEffort, type RuntimeEffort } from "../../runtime/effort.js";
import { validateRuntimeModelSelector } from "../../runtime/model-validation.js";
import { DEFAULT_RUNTIME_PROVIDER_ID, listRegisteredRuntimeProviderIds } from "../../runtime/provider-registry.js";
import { resolveEffectiveSessionRuntime } from "../../runtime/runtime-selection.js";
import {
  findSlackThreadForParent,
  slackThreadError,
  slackThreadParentSessionKey,
  summarizeSlackThread,
  type SlackThreadSummary,
} from "./thread-lifecycle.js";

export interface SlackThreadRuntimeOverrides {
  provider: string | null;
  model: string | null;
  effort: RuntimeEffort | null;
  thinking: string | null;
}

export interface ConfigureSlackThreadRuntimeInput {
  parentSession: SessionEntry;
  ref: string;
  provider?: string;
  model?: string;
  effort?: string;
  thinking?: string;
}

export interface ConfigureSlackThreadRuntimeResult {
  actionId: "thread.configure";
  status: "configured";
  changed: boolean;
  appliesOn: "next-turn";
  thread: SlackThreadSummary;
  before: SlackThreadRuntimeOverrides;
  after: SlackThreadRuntimeOverrides;
}

export function configureSlackThreadRuntime(
  input: ConfigureSlackThreadRuntimeInput,
  authorizeProviderChange: (child: SessionEntry, nextOverride: string | null) => void,
): ConfigureSlackThreadRuntimeResult {
  const patch = parseRuntimePatch(input);
  let authorizedProviderState: string | undefined;
  if (input.provider !== undefined) {
    const owned = resolveOwnedThread(input);
    const candidate = validateRuntimePatch(owned.child, patch);
    authorizedProviderState = providerAuthorizationState(owned, candidate.agent);
    // A refusal records and emits an audit. It must not be rolled back with
    // configuration writes; the lock below rechecks everything it authorized.
    authorizeProviderChange(owned.child, candidate.next.provider);
  }
  // The caller authorizes modification of the parent. Ownership and runtime
  // state must then be read under the same lock as the child-only mutation.
  return executeWrite(
    getDb(),
    () => {
      const { child, record } = resolveOwnedThread(input);
      const agent = getAgent(child.agentId) ?? loadRouterConfig().agents[child.agentId] ?? null;
      if (
        authorizedProviderState !== undefined &&
        authorizedProviderState !== providerAuthorizationState({ child, record }, agent)
      ) {
        throw slackThreadError(
          "THREAD_IDENTITY_MISMATCH",
          "Thread provider authority changed during configuration; retry the command",
        );
      }
      const { before, next } = validateRuntimePatch(child, patch, agent);

      // Even a repeated clear is new intent for an already-running handle.
      if (patch.provider !== undefined) {
        updateSessionRuntimeProviderOverride(child.sessionKey, next.provider);
      }
      if (
        patch.provider &&
        child.providerSessionId &&
        child.runtimeProvider &&
        child.runtimeProvider !== patch.provider
      ) {
        clearProviderSession(child.sessionKey);
      }
      if (patch.provider === null) {
        const cleared = getSession(child.sessionKey)!;
        rematerializeSessionToAgentRuntime(cleared, agent ?? { id: child.agentId });
      }
      if (patch.model !== undefined && next.model !== before.model) {
        updateSessionModelOverride(child.sessionKey, next.model);
      }
      if (patch.effort !== undefined && next.effort !== before.effort) {
        updateSessionEffortOverride(child.sessionKey, next.effort);
      }
      if (patch.thinking !== undefined && next.thinking !== before.thinking) {
        updateSessionThinkingLevel(child.sessionKey, next.thinking);
      }

      const persisted = getSession(child.sessionKey)!;
      const after = runtimeOverrides(persisted);
      if (!sameRuntimeOverrides(after, next)) {
        throw new Error("Thread runtime configuration readback did not match the requested patch");
      }
      return {
        actionId: "thread.configure",
        status: "configured",
        changed:
          !sameRuntimeOverrides(before, after) ||
          child.runtimeProvider !== persisted.runtimeProvider ||
          child.providerSessionId !== persisted.providerSessionId,
        appliesOn: "next-turn",
        thread: summarizeSlackThread(record),
        before,
        after,
      };
    },
    { label: "slack_thread_runtime_configure" },
  );
}

function validateRuntimePatch(
  child: SessionEntry,
  patch: Partial<SlackThreadRuntimeOverrides>,
  agent = getAgent(child.agentId) ?? loadRouterConfig().agents[child.agentId] ?? null,
) {
  const before = runtimeOverrides(child);
  const next = { ...before, ...patch };
  const candidate = {
    ...child,
    runtimeProviderOverride: next.provider ?? undefined,
    modelOverride: next.model ?? undefined,
    effortOverride: next.effort ?? undefined,
    thinkingLevel: (next.thinking ?? undefined) as SessionEntry["thinkingLevel"],
    // A clear follows agent defaults, not the provider used on an old turn.
    ...(patch.provider === null ? { runtimeProvider: undefined } : {}),
  };
  const effective = resolveEffectiveSessionRuntime({ session: candidate, agent });
  if (effective.model.error && !next.model) throw slackThreadError("THREAD_MODEL_INVALID", effective.model.error);
  if (effective.model.value) {
    const validation = validateRuntimeModelSelector(effective.provider.value, effective.model.value);
    if (!validation.ok)
      throw slackThreadError("THREAD_MODEL_INVALID", validation.error ?? "Invalid thread runtime model");
  }
  return { before, next, agent };
}

function providerAuthorizationState(
  owned: ReturnType<typeof resolveOwnedThread>,
  agent: ReturnType<typeof getAgent> | null,
): string {
  let defaultProvider: string;
  try {
    defaultProvider = resolveAgentRuntimeDefaultProvider(agent ?? {});
  } catch {
    defaultProvider = agent?.provider ?? DEFAULT_RUNTIME_PROVIDER_ID;
  }
  // These are the persisted identity and inputs to set-provider's authority
  // rule. Include creation time so deleting/recreating the key cannot reuse it.
  return JSON.stringify([
    owned.record.requestId,
    owned.child.sessionKey,
    owned.child.createdAt,
    owned.child.agentId,
    owned.child.runtimeProviderOverride ?? null,
    owned.child.runtimeProviderConfigRevision ?? 0,
    defaultProvider,
  ]);
}

function runtimeOverrides(session: SessionEntry): SlackThreadRuntimeOverrides {
  return {
    provider: session.runtimeProviderOverride ?? null,
    model: session.modelOverride ?? null,
    effort: session.effortOverride ?? null,
    thinking: session.thinkingLevel ?? null,
  };
}

function sameRuntimeOverrides(left: SlackThreadRuntimeOverrides, right: SlackThreadRuntimeOverrides): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.thinking === right.thinking
  );
}

function invalidArgument(message: string): never {
  throw new CliExpectedError(message, "INVALID_ARGUMENT", 2);
}

function parseRuntimePatch(input: ConfigureSlackThreadRuntimeInput): Partial<SlackThreadRuntimeOverrides> {
  const patch: Partial<SlackThreadRuntimeOverrides> = {};
  if (input.provider !== undefined) {
    const provider = input.provider.trim().toLowerCase();
    if (provider === "clear") patch.provider = null;
    else if (listRegisteredRuntimeProviderIds().includes(provider)) patch.provider = provider;
    else
      invalidArgument(
        `Unknown runtime provider: ${input.provider}. Use ${listRegisteredRuntimeProviderIds().join("|")}|clear`,
      );
  }
  if (input.model !== undefined) {
    const model = input.model.trim();
    if (!model) throw slackThreadError("THREAD_MODEL_INVALID", "Thread model cannot be empty");
    patch.model = model === "clear" ? null : model;
  }
  if (input.effort !== undefined) {
    if (input.effort.trim().toLowerCase() === "clear") patch.effort = null;
    else {
      try {
        const effort = parseRuntimeEffort(input.effort);
        if (!effort) invalidArgument("Thread effort cannot be empty");
        patch.effort = effort;
      } catch (error) {
        invalidArgument(error instanceof Error ? error.message : "Invalid thread effort");
      }
    }
  }
  if (input.thinking !== undefined) {
    const thinking = input.thinking.trim().toLowerCase();
    if (thinking === "clear") patch.thinking = null;
    else if (["off", "normal", "verbose"].includes(thinking)) patch.thinking = thinking;
    else invalidArgument("Invalid thread thinking level. Use off|normal|verbose|clear");
  }
  if (Object.keys(patch).length === 0)
    invalidArgument("Provide at least one of --provider, --model, --effort or --thinking");
  return patch;
}

function resolveOwnedThread(input: ConfigureSlackThreadRuntimeInput) {
  if (slackThreadParentSessionKey(input.parentSession.sessionKey) !== input.parentSession.sessionKey) {
    throw slackThreadError("THREAD_NOT_CHANNEL_ROOT", "Only the Slack root session can configure its threads");
  }
  const parent = getSession(input.parentSession.sessionKey);
  if (!parent) throw slackThreadError("THREAD_PARENT_MISSING", "Slack thread parent session no longer exists");
  if (parent.agentId !== input.parentSession.agentId) {
    throw slackThreadError("THREAD_IDENTITY_MISMATCH", "Slack thread parent identity changed");
  }
  const record = findSlackThreadForParent(parent.sessionKey, input.ref);
  if (!record) throw slackThreadError("THREAD_NOT_FOUND", "Slack thread not found for this session");
  if (
    (record.status !== "open" && record.status !== "closed") ||
    !record.childSessionKey ||
    !record.providerThreadId ||
    !record.threadCanonicalChatId
  ) {
    throw slackThreadError("THREAD_NOT_STARTED", `Slack thread has not started yet: ${record.requestId}`);
  }
  const child = getSession(record.childSessionKey);
  if (!child) throw slackThreadError("THREAD_SESSION_MISSING", "Slack thread child session no longer exists");
  const threadChat = dbGetChat(record.threadCanonicalChatId);
  const rootChat = record.rootCanonicalChatId ? dbGetChat(record.rootCanonicalChatId) : null;
  const isMatchingSlackRoot = (chat: ReturnType<typeof dbGetChat>) =>
    chat?.channel === "slack" &&
    chat.chatType !== "thread" &&
    chat.instanceId === record.instanceId &&
    chat.platformChatId === record.platformChatId;
  // A multi-channel session keeps its original channel. The persisted Slack
  // lifecycle proves this parent; legacy rows can use an aligned subscription.
  if (
    !record.rootCanonicalChatId &&
    !listSessionSubscriptions(parent.sessionKey).some((subscription) =>
      isMatchingSlackRoot(dbGetChat(subscription.chatId)),
    )
  ) {
    throw slackThreadError("THREAD_NOT_CHANNEL_ROOT", "The parent has no persisted Slack root binding for this thread");
  }
  if (
    record.parentSessionName !== (parent.name ?? parent.sessionKey) ||
    record.childSessionKey !== `${parent.sessionKey}:thread:${record.providerThreadId}` ||
    record.childSessionName !== (child.name ?? child.sessionKey) ||
    child.agentId !== parent.agentId ||
    !threadChat ||
    threadChat.channel !== "slack" ||
    threadChat.chatType !== "thread" ||
    threadChat.instanceId !== record.instanceId ||
    threadChat.platformChatId !== `${record.platformChatId}#${record.providerThreadId}` ||
    (record.rootCanonicalChatId && !isMatchingSlackRoot(rootChat))
  ) {
    throw slackThreadError(
      "THREAD_IDENTITY_MISMATCH",
      "Slack thread lifecycle and persisted session identity do not match",
    );
  }
  return { child, record };
}
