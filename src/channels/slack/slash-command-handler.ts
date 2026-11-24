/**
 * Daemon side of `/ravi`: the Slack adapter of the chat command engine.
 *
 * The runner has already acked Slack and published `ravi.inbound.command`
 * (src/channels/slack/slash-commands.ts). Here the adapter does what only Slack
 * can: read the event, say which contact the Slack user is, find the session an
 * agent answers in for the chat, own the Slack threads, and say the answer in
 * Slack's words through the stored `response_url` (slash-command-render.ts).
 *
 * Everything else, the same for every channel, is the engine's
 * (src/chat-commands/engine.ts): the command is never replayed and never an
 * agent prompt, reads need access to the session, `close` and `stop` need to
 * modify it AND hold the command's own capability (the two checks the CLI
 * applies to `sessions close-thread` and `sessions runtime interrupt`), the
 * operation runs, and the command is audited. The agent's ceiling never enters
 * the account: the person acts, not the agent.
 *
 * Spec: channels/slack/commands, permissions/chat-commands.
 */

import {
  CHAT_COMMAND_MAX_AGE_MS,
  type ChatCommandAudit,
  type ChatCommandChannel,
  type ChatCommandDecision,
  type ChatCommandDeps,
  type ChatCommandOutcome,
  type ChatCommandSessionResolution,
  type ChatThreadActivity,
  type ChatThreadCloseResult,
  type ChatThreadIndex,
  type ChatThreadSummary,
  type InheritedCommandAccess,
  runChatCommand,
} from "../../chat-commands/engine.js";
import { closeChildRun, findChildRunByChildSession, isChildRunSurfaceRef } from "../../automation/child-runs.js";
import { getCommandAccessMetadata } from "../../cli/decorators.js";
import { slackUserContactId } from "../../cloud-agents/chat-people.js";
import { nats as runtimeNats } from "../../nats.js";
import {
  findSessionByAttachedChat,
  getSession,
  isChatCompatibleWithSession,
  matchRoute,
  previewCommittedSessionKey,
} from "../../router/index.js";
import { dbFindChat } from "../../router/router-db.js";
import type { RouterConfig, SessionEntry } from "../../router/types.js";
import { logger } from "../../utils/logger.js";
import { resolveSubscriptionPrecedence } from "../subscription-precedence.js";
import { resolveSlackInstanceAliases } from "./instance-alias.js";
import { respondToSlackInteraction } from "./interactions.js";
import { type DeliverSlackPrivateCard, deliverSlackPrivateCard } from "./private-card.js";
import { formatSlackCommandAge, renderSlackCommandResult } from "./slash-command-render.js";
import { parseSlackCommandEvent, SLACK_COMMAND_TOPIC, type SlackCommandEvent } from "./slash-commands.js";
import {
  closeSlackThreadRecord,
  findSlackThreadForParent,
  findSlackThreadForParentInChat,
  type SlackThreadLifecycleDependencies,
  slackThreadParentSessionKey,
  summarizeSlackThread,
} from "./thread-lifecycle.js";
import {
  countSlackThreadLifecyclesByParent,
  listSlackThreadLifecyclesByParent,
  type SlackThreadLifecycleRecord,
} from "./thread-lifecycle-store.js";

const log = logger.child("channels:slack:commands");

export { formatSlackCommandAge };

export const SLACK_COMMAND_QUEUE_GROUP = "ravi-slack-commands";
/** A command older than this never runs: a restart must not execute a `stop` from minutes ago. */
export const SLACK_COMMAND_MAX_AGE_MS = CHAT_COMMAND_MAX_AGE_MS;
/** Page size when every open thread of a session is walked (the store caps a page at 500). */
const THREAD_PAGE_SIZE = 200;

export type SlackCommandDecision = ChatCommandDecision;
export type SlackCommandOutcome = ChatCommandOutcome;
export type SlackCommandAudit = ChatCommandAudit;
export type SlackCommandSessionResolution = ChatCommandSessionResolution;
export type { InheritedCommandAccess };
export type SlackThreadIndex = ChatThreadIndex;
export type SlackThreadActivity = ChatThreadActivity;
export type SlackCommandCloseResult = ChatThreadCloseResult;

/** Where a Slack command was given: the chat, the person, and the instance whose routes apply. */
export type SlackCommandLocation = Pick<SlackCommandEvent, "channelId" | "userId" | "instanceId" | "routeAccountId">;

export interface SlackCommandDeps extends ChatCommandDeps {
  respond?: (input: { responseUrlId: string; payload: Record<string, unknown> }) => Promise<unknown>;
  /** Sends a card only the person sees, in a thread: how a shortcut answers (tests replace it). */
  deliverPrivate?: DeliverSlackPrivateCard;
  contactForSlackUser?: (userId: string, instanceId: string) => string | null;
  resolveSession?: (where: SlackCommandLocation, config: RouterConfig) => SlackCommandSessionResolution;
  threads?: (session: SessionEntry) => SlackThreadIndex;
  /**
   * One thread of the session of a chat, by name, request id or Slack `thread_ts`. With `chatId` the
   * ref is the root `ts` of a thread opened in that channel, and no other thread answers to it.
   */
  findThread?: (parentSessionKey: string, threadRef: string, chatId?: string) => ChatThreadSummary | null;
  closeThread?: (parentSessionKey: string, threadRef: string, chatId?: string) => Promise<SlackCommandCloseResult>;
}

/**
 * Resolve the chat a command was typed in to the session an agent answers in,
 * the way an inbound message there would, without creating anything: the route
 * for the chat, then a subscription that attaches the chat to another session
 * unless the route forces its own.
 */
export function resolveSlackCommandSession(
  event: SlackCommandLocation,
  config: RouterConfig,
): SlackCommandSessionResolution {
  const isDm = event.channelId.startsWith("D");
  const peerKind = isDm ? "dm" : "group";
  const aliases = resolveSlackInstanceAliases(config, event.instanceId);
  let matched = matchRoute(config, {
    phone: isDm ? event.userId : event.channelId,
    channel: "slack",
    accountId: event.routeAccountId,
    isGroup: !isDm,
    groupId: isDm ? undefined : event.channelId,
    peerKind,
  });

  const chat = dbFindChat({
    channel: "slack",
    instanceId: aliases.canonical,
    platformChatId: event.channelId,
    chatType: peerKind,
  });
  const subscription = chat ? findSessionByAttachedChat(chat.id) : null;
  if (chat && subscription) {
    const ownerSession = getSession(subscription.sessionKey);
    const ownerAgent = ownerSession ? config.agents[ownerSession.agentId] : undefined;
    if (ownerSession && ownerAgent && isChatCompatibleWithSession(chat.id, subscription.sessionKey)) {
      const precedence = resolveSubscriptionPrecedence({
        matched,
        subscription,
        ownerAgentId: ownerSession.agentId,
        ownerAgent,
        chatId: chat.id,
        threadId: undefined,
        defaultDmScope: config.defaultDmScope,
      });
      if (precedence.kind !== "route-wins") matched = precedence.matched;
    }
  }

  if (!matched) return { kind: "no_route" };
  const sessionKey = previewCommittedSessionKey(matched, { threadId: undefined });
  const session = getSession(sessionKey);
  if (!session) return { kind: "session_missing", agentId: matched.agentId, sessionKey };
  // A route can force a session by name. If that session belongs to another agent than the route's,
  // normal intake refuses the message when it commits the route (RouteSessionAgentConflictError); a
  // command that ran there would hand the other agent's session to whoever holds a right over it.
  if (session.agentId !== matched.agentId) return { kind: "route_conflict" };
  return { kind: "session", session, agentId: matched.agentId };
}

// ---------------------------------------------------------------------------
// Slack threads: what only this adapter knows

function defaultThreadIndex(session: SessionEntry): SlackThreadIndex {
  const parentSessionKey = slackThreadParentSessionKey(session.sessionKey);
  const parent = parentSessionKey === session.sessionKey ? session : getSession(parentSessionKey);
  return {
    parentSessionKey,
    parentSessionName: parent?.name ?? parentSessionKey,
    count: () => countSlackThreadLifecyclesByParent(parentSessionKey),
    newest: (limit) => listSlackThreadLifecyclesByParent(parentSessionKey, { limit }).map(summarizeSlackThread),
    touchedBefore: (cutoff) => {
      // Page by page, with no ceiling. A thread opened while this walks shifts the pages by one,
      // so a record can be seen twice: the set keeps each once, and a record missed at the edge
      // is simply found by the next run.
      const seen = new Map<string, SlackThreadLifecycleRecord>();
      for (let offset = 0; ; offset += THREAD_PAGE_SIZE) {
        const page = listSlackThreadLifecyclesByParent(parentSessionKey, { limit: THREAD_PAGE_SIZE, offset });
        for (const record of page) {
          if (record.status === "open" && record.updatedAt <= cutoff) seen.set(record.requestId, record);
        }
        if (page.length < THREAD_PAGE_SIZE) break;
      }
      return [...seen.values()].sort((a, b) => a.updatedAt - b.updatedAt).map(summarizeSlackThread);
    },
  };
}

/** The thread a ref names: by chat and root `ts` when a chat is given, by any of its names otherwise. */
function lookupThread(parentSessionKey: string, threadRef: string, chatId?: string) {
  return chatId
    ? findSlackThreadForParentInChat(parentSessionKey, chatId, threadRef)
    : findSlackThreadForParent(parentSessionKey, threadRef);
}

function defaultFindThread(parentSessionKey: string, threadRef: string, chatId?: string): ChatThreadSummary | null {
  const record = lookupThread(parentSessionKey, threadRef, chatId);
  return record ? summarizeSlackThread(record) : null;
}

/**
 * A person closes a thread (the card's Close button, `/ravi close`). A run's thread closes its run
 * too, without a return, as `sessions close-thread` with none would; the thread's own guards (a
 * decision still open) refuse first, and then the run stays open.
 */
export async function closeSlackThreadFromCommand(
  parentSessionKey: string,
  threadRef: string,
  chatId?: string,
  dependencies?: SlackThreadLifecycleDependencies,
): Promise<SlackCommandCloseResult> {
  const record = lookupThread(parentSessionKey, threadRef, chatId);
  if (!record) return { kind: "not_found" };
  const name = record.childSessionName ?? record.requestId;
  let result: Awaited<ReturnType<typeof closeSlackThreadRecord>>;
  try {
    result = await (dependencies
      ? closeSlackThreadRecord(record, undefined, dependencies)
      : closeSlackThreadRecord(record));
  } catch (error) {
    return refusedClose(name, error);
  }
  // A run's thread: the run closes with it, without a return (as `close-thread` with none).
  const run =
    isChildRunSurfaceRef(record.requestId) && record.childSessionKey
      ? findChildRunByChildSession(record.childSessionKey)
      : null;
  if (run?.status === "open") {
    await closeChildRun(run, null).catch((error) =>
      log.warn("A run's thread closed but the run did not; its turn's end or the stale rule closes it", {
        runId: run.id,
        error: errorText(error),
      }),
    );
  }
  return { kind: "closed", name, changed: result.changed };
}

/**
 * What the CLI declares for `sessions close-thread`, the command that closes a Slack thread. It
 * imports Slack's thread code, so it is read here and not by the engine: the capability asked of a
 * person cannot drift from what the CLI asks.
 */
async function defaultCloseAccess(): Promise<InheritedCommandAccess | undefined> {
  const { SessionCommands } = await import("../../cli/commands/sessions.js");
  const access = getCommandAccessMetadata(SessionCommands).get("closeThread");
  return access ? { group: "sessions", command: "close-thread", access } : undefined;
}

function refusedClose(name: string, cause: unknown): SlackCommandCloseResult {
  return { kind: "refused", name, code: errorCode(cause), message: errorText(cause) };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code) ? code : "COMMAND_FAILED";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Handler

/**
 * A Slack command and how it got here: a typed `/ravi` (the runner's event) or a click on a thread
 * card (thread-controls.ts). Both become the same engine command, answered in Slack the same way.
 */
export interface SlackCommandSource extends SlackCommandLocation {
  readonly accountId: string;
  /** The text after the command word: typed, or built from the button that was clicked. */
  readonly text: string;
  readonly receivedAt: number;
  readonly envelopeId?: string;
  readonly responseUrlId?: string;
  /** The command as typed, with its slash, for the answers that name it. */
  readonly command: string;
  /** How the person reached it, for the audit: `command`, `button` or `shortcut`. */
  readonly surface: "command" | "button" | "shortcut";
  /** The runner already answered static text inside the ack. */
  readonly ackedWithHelp?: boolean;
  /** The answer takes the place of the card that was clicked, instead of adding a message. */
  readonly replaceOriginal?: boolean;
  /**
   * The answer is a private card in the thread with this root ts, and not a reply on a
   * `response_url`: a shortcut's own response handle posts at channel level, where a person
   * looking at a thread does not see it.
   */
  readonly privateThreadTs?: string;
}

/** What the engine needs from Slack for one command: who, where, the threads, and how to answer. */
export function slackCommandChannel(source: SlackCommandSource, deps: SlackCommandDeps = {}): ChatCommandChannel {
  const scopeChat = source.surface === "command" ? undefined : source.channelId;
  return {
    origin: {
      channel: "slack",
      accountId: source.accountId,
      instanceId: source.instanceId,
      chatId: source.channelId,
      actorId: source.userId,
      surface: source.surface,
      ...(source.envelopeId ? { requestId: source.envelopeId } : {}),
    },
    text: source.text,
    receivedAt: source.receivedAt,
    contactId: () => (deps.contactForSlackUser ?? slackUserContactId)(source.userId, source.instanceId),
    resolveSession: (config) => (deps.resolveSession ?? resolveSlackCommandSession)(source, config),
    threads: (session) => (deps.threads ?? defaultThreadIndex)(session),
    // A shortcut and a button name the thread by the message they were used on: its root `ts`, in this
    // chat. A typed command names it by any of its names, among every thread of the session.
    findThread: (session, threadRef) =>
      (deps.findThread ?? defaultFindThread)(slackThreadParentSessionKey(session.sessionKey), threadRef, scopeChat),
    closeThread: (session, threadRef) =>
      (deps.closeThread ?? closeSlackThreadFromCommand)(
        slackThreadParentSessionKey(session.sessionKey),
        threadRef,
        scopeChat,
      ),
    closeAccess: defaultCloseAccess,
    reply: async (result) => {
      // The runner answers static text inside the ack when Slack takes it there; only when Slack
      // would not does the daemon say it, so nobody gets it twice.
      if (result.kind === "static" && source.ackedWithHelp) return;
      const message = renderSlackCommandResult(result, source.command);
      if (source.privateThreadTs) {
        try {
          await (deps.deliverPrivate ?? deliverSlackPrivateCard)(
            {
              accountId: source.accountId,
              chatId: source.channelId,
              userId: source.userId,
              threadTs: source.privateThreadTs,
            },
            { text: message.text, blocks: message.blocks },
          );
          return;
        } catch (error) {
          // The response handle still answers, at channel level and only to this person: better than silence.
          log.warn("Slack command private card was not delivered; using the response handle", {
            error: errorText(error),
          });
        }
      }
      if (!source.responseUrlId) {
        log.warn("Slack command has no response handle; the answer is dropped", { envelopeId: source.envelopeId });
        return;
      }
      try {
        await (deps.respond ?? respondToSlackInteraction)({
          responseUrlId: source.responseUrlId,
          payload: (source.replaceOriginal ? { ...message, replace_original: true } : message) as unknown as Record<
            string,
            unknown
          >,
        });
      } catch (error) {
        log.warn("Slack command answer was not delivered", { error: errorText(error) });
      }
    },
  };
}

/** The part of `SlackCommandDeps` the engine itself takes. */
export function slackChatCommandDeps(deps: SlackCommandDeps): ChatCommandDeps {
  return {
    now: deps.now,
    routerConfig: deps.routerConfig,
    capabilitiesFor: deps.capabilitiesFor,
    commandAccess: deps.commandAccess,
    inheritedAccess: deps.inheritedAccess,
    activity: deps.activity,
    activeTurn: deps.activeTurn,
    describeRuntime: deps.describeRuntime,
    interrupt: deps.interrupt,
    audit: deps.audit,
  };
}

/**
 * One `ravi.inbound.command` event, start to answer. Returns what happened, or
 * null for something that is not a Slack command at all.
 */
export async function handleSlackCommand(
  data: unknown,
  deps: SlackCommandDeps = {},
): Promise<SlackCommandOutcome | null> {
  const event = parseSlackCommandEvent(data);
  if (!event) return null;
  return runChatCommand(slackCommandChannel({ ...event, surface: "command" }, deps), slackChatCommandDeps(deps));
}

// ---------------------------------------------------------------------------
// Daemon consumer

let consumerStop: (() => void) | null = null;
let activeCommand: Promise<unknown> | null = null;

/** Daemon: answers `/ravi` (`ravi.inbound.command`, its own queue group). */
export async function startSlackCommandConsumer(
  natsClient: Pick<typeof runtimeNats, "subscribe"> = runtimeNats,
  deps: SlackCommandDeps = {},
): Promise<void> {
  if (consumerStop) return;
  const stream = natsClient.subscribe(SLACK_COMMAND_TOPIC, { queue: SLACK_COMMAND_QUEUE_GROUP });
  let stopped = false;
  consumerStop = () => {
    stopped = true;
    void stream.return?.(undefined);
  };
  void (async () => {
    try {
      for await (const event of stream) {
        if (stopped) return;
        try {
          activeCommand = handleSlackCommand(event.data, deps);
          await activeCommand;
        } catch (error) {
          log.warn("Failed to answer a Slack command", { error: errorText(error) });
        } finally {
          activeCommand = null;
        }
      }
    } catch (error) {
      if (!stopped) log.error("Slack command consumer stopped", { error });
    }
  })();
}

export async function stopSlackCommandConsumer(): Promise<void> {
  consumerStop?.();
  consumerStop = null;
  // The command being answered finishes first: it may still have its reply and its audit event to
  // send, and shutdown closes NATS and the database right after this returns.
  await activeCommand?.catch((error) =>
    log.debug("In-flight Slack command ended with an error", { error: errorText(error) }),
  );
}
