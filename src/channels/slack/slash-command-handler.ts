/**
 * Daemon side of `/ravi`: who typed it, in which chat, with what authority.
 *
 * The runner has already acked Slack and published `ravi.inbound.command`
 * (src/channels/slack/slash-commands.ts). Here the person is resolved to a
 * contact, the chat to the session an agent answers in, and the command runs
 * only if that contact may: reads need access to the session; `close` and
 * `stop` need to modify it AND hold the command's own capability, the two
 * checks the CLI applies to `sessions close-thread` and `sessions runtime
 * interrupt` (spec channels/slack/commands). The agent's ceiling never enters
 * the account: the person acts, not the agent. The answer is ephemeral, posted
 * through the stored `response_url`.
 *
 * A command is never replayed: it runs only while fresh, and it is never an
 * agent prompt.
 */

import {
  enforceCliCommandAccess,
  type CliCommandAccessInput,
  type CliCommandAccessResult,
} from "../../cli/command-access.js";
import { type CommandAccessOptions, getCommandAccessMetadata } from "../../cli/decorators.js";
import { slackUserContactId } from "../../cloud-agents/chat-people.js";
import { configStore } from "../../config-store.js";
import { nats as runtimeNats } from "../../nats.js";
import { authorizePermission, materializeSubjectCapabilities } from "../../permissions/provider-runtime.js";
import {
  findSessionByAttachedChat,
  getSession,
  isChatCompatibleWithSession,
  matchRoute,
  previewCommittedSessionKey,
} from "../../router/index.js";
import { type ContextCapability, dbFindChat } from "../../router/router-db.js";
import type { RouterConfig, SessionEntry } from "../../router/types.js";
import { listRuntimePromptQueue, listRuntimeTurnAttempts } from "../../runtime/crash-recovery-store.js";
import { applyProviderModelRule } from "../../runtime/model-catalog.js";
import { RUNTIME_NO_ACTIVE_TURN, RUNTIME_SESSION_NOT_ACTIVE } from "../../runtime/runtime-control-errors.js";
import { resolveEffectiveSessionRuntime } from "../../runtime/runtime-selection.js";
import type { RuntimeControlResult } from "../../runtime/types.js";
import { logger } from "../../utils/logger.js";
import { requestReply } from "../../utils/request-reply.js";
import { resolveSubscriptionPrecedence } from "../subscription-precedence.js";
import { resolveSlackInstanceAliases } from "./instance-alias.js";
import { respondToSlackInteraction } from "./interactions.js";
import {
  isSlackCommandAnsweredInAck,
  parseSlackCommandEvent,
  parseSlackCommandText,
  SLACK_COMMAND_TOPIC,
  type SlackCommandEvent,
  type SlackCommandMessage,
  type SlackCommandParse,
  slackCommandHelpMessage,
  slackCommandMessage,
} from "./slash-commands.js";
import {
  closeSlackThreadRecord,
  findSlackThreadForParent,
  type SlackThreadSummary,
  slackThreadParentSessionKey,
  summarizeSlackThread,
} from "./thread-lifecycle.js";
import {
  countSlackThreadLifecyclesByParent,
  listSlackThreadLifecyclesByParent,
  type SlackThreadLifecycleRecord,
} from "./thread-lifecycle-store.js";

const log = logger.child("channels:slack:commands");

export const SLACK_COMMAND_QUEUE_GROUP = "ravi-slack-commands";
/** A command older than this never runs: a restart must not execute a `stop` from minutes ago. */
export const SLACK_COMMAND_MAX_AGE_MS = 60_000;
export const SLACK_COMMAND_AUDIT_TOPIC = "ravi.audit.slack_command";
/** The topic `ravi sessions runtime` requests on; the runtime host (runtime/host-subscriptions.ts) answers it. */
export const SLACK_COMMAND_RUNTIME_CONTROL_TOPIC = "ravi.session.runtime.control";
const RUNTIME_CONTROL_TIMEOUT_MS = 10_000;
const MAX_LISTED_THREADS = 12;
const MAX_IDLE_CLOSES = 25;
/** Closes tried in one call, refused ones included: a thread that keeps refusing must not hide the ones behind it. */
const MAX_IDLE_ATTEMPTS = 100;
/** Page size when every open thread of a session is walked (the store caps a page at 500). */
const THREAD_PAGE_SIZE = 200;
const TITLE_MAX_LENGTH = 70;

export type SlackCommandDecision = "allowed" | "denied" | "info" | "error";

export interface SlackCommandOutcome {
  readonly decision: SlackCommandDecision;
  /** Stable result code for the audit row and for tests. */
  readonly code: string;
}

export interface SlackCommandAudit {
  readonly type: "slack_command";
  readonly at: number;
  readonly accountId: string;
  readonly instanceId: string;
  readonly channelId: string;
  readonly slackUserId: string;
  readonly contactId: string | null;
  readonly sessionKey: string | null;
  readonly sessionName: string | null;
  readonly subcommand: string;
  readonly decision: SlackCommandDecision;
  readonly code: string;
  readonly envelopeId?: string;
}

export type SlackCommandSessionResolution =
  | { readonly kind: "session"; readonly session: SessionEntry; readonly agentId: string }
  | { readonly kind: "session_missing"; readonly agentId: string; readonly sessionKey: string }
  /** The route forces a session that belongs to another agent: normal intake refuses it too. */
  | { readonly kind: "route_conflict" }
  | { readonly kind: "no_route" };

/** What an operation needs from the command metadata the CLI declares for it. */
export interface InheritedCommandAccess {
  readonly group: string;
  readonly command: string;
  readonly access: CommandAccessOptions;
}

/**
 * The threads a session owns, with no silent ceiling: `count` counts them all,
 * `newest` reads the page that is shown, and `touchedBefore` walks every open
 * thread, so cleanup sees the old ones even when many newer threads exist.
 */
export interface SlackThreadIndex {
  readonly parentSessionKey: string;
  readonly parentSessionName: string;
  count(): number;
  newest(limit: number): SlackThreadSummary[];
  /** Open threads whose lifecycle was last touched at or before `cutoff`, oldest first. */
  touchedBefore(cutoff: number): SlackThreadSummary[];
}

export interface SlackThreadActivity {
  /** A turn is running, or work is already queued for it. */
  readonly busy: boolean;
  /** The latest sign of life: lifecycle, runtime attempts, the child session, the health observation. */
  readonly lastActivityAt: number;
}

export type SlackCommandCloseResult =
  | { readonly kind: "closed"; readonly name: string; readonly changed: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly name: string; readonly code: string; readonly message: string };

export interface SlackCommandDeps {
  now?: () => number;
  routerConfig?: () => RouterConfig;
  respond?: (input: { responseUrlId: string; payload: Record<string, unknown> }) => Promise<unknown>;
  contactForSlackUser?: (userId: string, instanceId: string) => string | null;
  resolveSession?: (event: SlackCommandEvent, config: RouterConfig) => SlackCommandSessionResolution;
  capabilitiesFor?: (contactId: string) => ContextCapability[];
  commandAccess?: (input: CliCommandAccessInput) => CliCommandAccessResult;
  inheritedAccess?: (operation: "close-thread" | "interrupt") => Promise<InheritedCommandAccess | undefined>;
  threads?: (session: SessionEntry) => SlackThreadIndex;
  /** What a thread is doing right now, read at the moment it is needed. */
  activity?: (thread: SlackThreadSummary) => SlackThreadActivity;
  closeThread?: (parentSessionKey: string, threadRef: string) => Promise<SlackCommandCloseResult>;
  activeTurn?: (sessionKey: string) => { turnId: string; startedAt: number } | null;
  describeRuntime?: (session: SessionEntry, config: RouterConfig) => string;
  interrupt?: (session: SessionEntry) => Promise<RuntimeControlResult>;
  audit?: (entry: SlackCommandAudit) => void | Promise<void>;
}

/**
 * Resolve the chat a command was typed in to the session an agent answers in,
 * the way an inbound message there would, without creating anything: the route
 * for the chat, then a subscription that attaches the chat to another session
 * unless the route forces its own.
 */
export function resolveSlackCommandSession(
  event: SlackCommandEvent,
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
// Text

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function oneLine(value: string | null | undefined, max = TITLE_MAX_LENGTH): string {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  return escapeMrkdwn(clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** `now`, `12 min`, `3 h`, `2 d`. */
export function formatSlackCommandAge(ms: number): string {
  if (ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function threadStateLabel(thread: SlackThreadSummary, busy: boolean): string {
  const state = thread.turnHealth?.state;
  const parts: string[] = [];
  if (busy) parts.push("working");
  else if (state === "attention") parts.push("needs attention");
  else if (state === "interrupted") parts.push("interrupted");
  else parts.push("idle");
  if (thread.openDecisionCount > 0) {
    parts.push(`${thread.openDecisionCount} open ${plural(thread.openDecisionCount, "question", "questions")}`);
  }
  if (thread.parentReturn.pending) parts.push("return pending");
  if (thread.childSessionMissing) parts.push("session gone");
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Authority

type SlackCommandAction = "status" | "threads" | "close" | "close_idle" | "stop";

/** What the person must hold on the session of the chat. */
const SESSION_ACCESS_BY_ACTION: Record<SlackCommandAction, "access" | "modify"> = {
  status: "access",
  threads: "access",
  close: "modify",
  close_idle: "modify",
  stop: "modify",
};

function isAction(parse: SlackCommandParse): parse is Extract<SlackCommandParse, { kind: SlackCommandAction }> {
  return !isSlackCommandAnsweredInAck(parse);
}

/**
 * Whether the contact holds a right, asked the way the command-level check asks
 * it: the capabilities AND the contact as subject, so a configured external
 * authority sees who acts and can refuse what the local grants would allow.
 */
function contactCan(
  contactId: string,
  capabilities: ContextCapability[],
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  return authorizePermission({
    subject: { type: "contact", id: contactId },
    capabilities,
    permission,
    objectType,
    objectId,
  }).allowed;
}

function sessionRef(session: SessionEntry): string {
  return session.name ?? session.sessionKey;
}

async function defaultInheritedAccess(
  operation: "close-thread" | "interrupt",
): Promise<InheritedCommandAccess | undefined> {
  // Loaded when first needed: the CLI classes carry the access metadata the
  // operation declares, so the command cannot drift from what the CLI asks for.
  if (operation === "close-thread") {
    const { SessionCommands } = await import("../../cli/commands/sessions.js");
    const access = getCommandAccessMetadata(SessionCommands).get("closeThread");
    return access ? { group: "sessions", command: "close-thread", access } : undefined;
  }
  const { SessionRuntimeCommands } = await import("../../cli/commands/sessions-runtime.js");
  const access = getCommandAccessMetadata(SessionRuntimeCommands).get("interrupt");
  return access ? { group: "sessions.runtime", command: "interrupt", access } : undefined;
}

// ---------------------------------------------------------------------------
// Default dependencies

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

/**
 * What a thread is doing now, from the runtime's own records and not from the
 * health label, which is a sample taken every so often. The lifecycle
 * `updatedAt` does not move when a parent sends new instructions, so the last
 * activity is the latest of that, the child session's own update, its turn
 * attempts (start, heartbeat, completion) and the health sample.
 */
function defaultThreadActivity(now: () => number) {
  return (thread: SlackThreadSummary): SlackThreadActivity => {
    const stamps = [thread.updatedAt, thread.turnHealth?.lastSignalAt ?? 0];
    let busy = thread.turnHealth?.state === "running";
    const childKey = thread.childSessionKey;
    if (childKey) {
      const child = getSession(childKey);
      if (child) stamps.push(child.updatedAt);
      for (const attempt of listRuntimeTurnAttempts({ sessionKey: childKey, limit: 3 })) {
        stamps.push(attempt.startedAt, attempt.lastHeartbeatAt, attempt.completedAt ?? 0);
        if (attempt.status === "running" && attempt.completedAt === null && attempt.leaseExpiresAt > now()) busy = true;
      }
      const queued = listRuntimePromptQueue({
        sessionKey: childKey,
        statuses: ["queued", "leased", "starting"],
        limit: 1,
      });
      if (queued.length > 0) busy = true;
    }
    return { busy, lastActivityAt: Math.max(...stamps) };
  };
}

async function defaultCloseThread(parentSessionKey: string, threadRef: string): Promise<SlackCommandCloseResult> {
  const record = findSlackThreadForParent(parentSessionKey, threadRef);
  if (!record) return { kind: "not_found" };
  const name = record.childSessionName ?? record.requestId;
  try {
    const result = await closeSlackThreadRecord(record);
    return { kind: "closed", name, changed: result.changed };
  } catch (error) {
    return refusedClose(name, error);
  }
}

function refusedClose(name: string, cause: unknown): SlackCommandCloseResult {
  return { kind: "refused", name, code: errorCode(cause), message: errorText(cause) };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code) ? code : "COMMAND_FAILED";
}

function defaultActiveTurn(now: () => number) {
  return (sessionKey: string): { turnId: string; startedAt: number } | null => {
    const attempt = listRuntimeTurnAttempts({ sessionKey, status: "running", limit: 5 }).find(
      (candidate) => candidate.completedAt === null && candidate.leaseExpiresAt > now(),
    );
    return attempt ? { turnId: attempt.turnId, startedAt: attempt.startedAt } : null;
  };
}

function defaultDescribeRuntime(session: SessionEntry, config: RouterConfig): string {
  try {
    const agent = config.agents[session.agentId] ?? null;
    const resolved = resolveEffectiveSessionRuntime({ session, agent });
    const model = applyProviderModelRule(resolved.provider.value, resolved.model.value) ?? resolved.model.value;
    return [resolved.provider.value, model, resolved.effort.value].filter(Boolean).join(" · ");
  } catch (error) {
    log.debug("Could not describe the runtime of a session", { error: errorText(error) });
    return "unavailable";
  }
}

async function defaultInterrupt(session: SessionEntry): Promise<RuntimeControlResult> {
  const reply = await requestReply<{ result?: RuntimeControlResult }>(
    SLACK_COMMAND_RUNTIME_CONTROL_TOPIC,
    {
      sessionName: session.name,
      sessionKey: session.sessionKey,
      request: { operation: "turn.interrupt" },
    },
    RUNTIME_CONTROL_TIMEOUT_MS,
  );
  if (!reply.result) throw new Error("Runtime control reply did not include a result.");
  return reply.result;
}

async function defaultAudit(entry: SlackCommandAudit): Promise<void> {
  if (process.env.RAVI_SUPPRESS_AUDIT_EVENTS === "1") return;
  await runtimeNats.emit(SLACK_COMMAND_AUDIT_TOPIC, entry as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Handler

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
  const now = deps.now ?? Date.now;
  const config = (deps.routerConfig ?? (() => configStore.getConfig()))();
  const parse = parseSlackCommandText(event.text);

  let contactId: string | null = null;
  let session: SessionEntry | null = null;

  const record = async (outcome: SlackCommandOutcome): Promise<SlackCommandOutcome> => {
    const entry: SlackCommandAudit = {
      type: "slack_command",
      at: now(),
      accountId: event.accountId,
      instanceId: event.instanceId,
      channelId: event.channelId,
      slackUserId: event.userId,
      contactId,
      sessionKey: session?.sessionKey ?? null,
      sessionName: session?.name ?? null,
      subcommand: parse.kind,
      decision: outcome.decision,
      code: outcome.code,
      ...(event.envelopeId ? { envelopeId: event.envelopeId } : {}),
    };
    log.info("Slack command", entry);
    try {
      await (deps.audit ?? defaultAudit)(entry);
    } catch (error) {
      log.warn("Slack command audit event was not published", { error: errorText(error) });
    }
    return outcome;
  };

  const reply = async (message: SlackCommandMessage): Promise<void> => {
    if (!event.responseUrlId) {
      log.warn("Slack command has no response handle; the answer is dropped", { envelopeId: event.envelopeId });
      return;
    }
    try {
      await (deps.respond ?? respondToSlackInteraction)({
        responseUrlId: event.responseUrlId,
        payload: message as unknown as Record<string, unknown>,
      });
    } catch (error) {
      log.warn("Slack command answer was not delivered", { error: errorText(error) });
    }
  };

  const refuseStale = async (): Promise<SlackCommandOutcome> => {
    await reply(slackCommandMessage("That command arrived late and was *not run*. Run it again."));
    return record({ decision: "denied", code: "stale" });
  };
  if (isStale(event, now())) return refuseStale();

  // Everything from here is covered by one handler: a failure while resolving the person, the
  // session or the authority is answered and audited like any other, not left to the consumer's log.
  const execute = async (): Promise<SlackCommandOutcome> => {
    contactId = (deps.contactForSlackUser ?? slackUserContactId)(event.userId, event.instanceId);

    if (!isAction(parse)) {
      // Static text. The runner put it in the ack; only when Slack would not take
      // it there does the daemon say it, so nobody gets it twice.
      if (!event.ackedWithHelp) await reply(helpFor(event, parse));
      return record({ decision: "info", code: "help" });
    }

    if (!contactId) {
      await reply(
        slackCommandMessage(
          "I don't recognize you in this workspace, so nothing ran. Ask whoever administers Ravi to link your Slack user to a contact.",
        ),
      );
      return record({ decision: "denied", code: "unknown_user" });
    }

    const resolution = (deps.resolveSession ?? resolveSlackCommandSession)(event, config);
    if (resolution.kind === "no_route") {
      await reply(slackCommandMessage("No agent answers in this chat."));
      return record({ decision: "info", code: "no_route" });
    }
    if (resolution.kind === "route_conflict") {
      await reply(
        slackCommandMessage(
          "The route for this chat forces a session that belongs to another agent, so nothing ran. An operator has to fix the route.",
        ),
      );
      return record({ decision: "error", code: "route_conflict" });
    }
    if (resolution.kind === "session_missing") {
      await reply(
        slackCommandMessage(
          `Agent \`${resolution.agentId}\` answers here, but there is no session yet: nobody has spoken in this chat.`,
        ),
      );
      return record({ decision: "info", code: "session_missing" });
    }
    session = resolution.session;

    // Authority: this contact, and only this contact. Reads need access to the
    // session; changes need to modify it and hold the command's own capability.
    const capabilities = (deps.capabilitiesFor ?? ((id) => materializeSubjectCapabilities("contact", id)))(contactId);
    const need = SESSION_ACCESS_BY_ACTION[parse.kind];
    if (!contactCan(contactId, capabilities, need, "session", sessionRef(session))) {
      await reply(
        slackCommandMessage(
          need === "modify"
            ? `You are not allowed to change session \`${sessionRef(session)}\`.`
            : `You do not have access to session \`${sessionRef(session)}\`.`,
        ),
      );
      return record({
        decision: "denied",
        code: need === "modify" ? "not_authorized_modify" : "not_authorized_access",
      });
    }

    const operation =
      parse.kind === "stop" ? "interrupt" : parse.kind === "status" || parse.kind === "threads" ? null : "close-thread";
    if (operation) {
      const inherited = await (deps.inheritedAccess ?? defaultInheritedAccess)(operation);
      if (!inherited) {
        // No declared metadata means no way to ask the CLI's question: refuse.
        await reply(slackCommandMessage("I could not check your permission for this command, so nothing ran."));
        return record({ decision: "error", code: "access_metadata_missing" });
      }
      const verdict = (deps.commandAccess ?? enforceCliCommandAccess)({
        source: "slack-command",
        subject: { type: "contact", id: contactId },
        group: inherited.group,
        command: inherited.command,
        access: inherited.access,
        input: {},
      });
      if (!verdict.allowed) {
        const capability = verdict.denialDetails?.capability;
        await reply(
          slackCommandMessage(
            `You are not allowed to ${operation === "interrupt" ? "stop turns" : "close threads"}${capability ? ` (missing \`${capability}\`)` : ""}.`,
          ),
        );
        return record({ decision: "denied", code: "not_authorized_command" });
      }
    }

    // Loading the CLI's access metadata can take a while the first time: freshness is checked again
    // right before anything changes.
    if (isStale(event, now())) return refuseStale();

    return await record(await run(parse, event, session, config, deps, now, reply));
  };

  try {
    return await execute();
  } catch (error) {
    log.warn("Slack command failed", { subcommand: parse.kind, error: errorText(error) });
    await reply(slackCommandMessage("I could not run that right now. Try again in a moment."));
    return record({ decision: "error", code: "failed" });
  }
}

function isStale(event: SlackCommandEvent, at: number): boolean {
  const age = at - event.receivedAt;
  return age > SLACK_COMMAND_MAX_AGE_MS || age < -SLACK_COMMAND_MAX_AGE_MS;
}

function helpFor(event: SlackCommandEvent, parse: SlackCommandParse): SlackCommandMessage {
  return slackCommandHelpMessage(event.command, {
    ...(parse.kind === "unknown" ? { unknown: parse.word } : {}),
    ...(parse.kind === "usage" ? { usage: parse.command } : {}),
  });
}

async function run(
  parse: Extract<SlackCommandParse, { kind: SlackCommandAction }>,
  event: SlackCommandEvent,
  session: SessionEntry,
  config: RouterConfig,
  deps: SlackCommandDeps,
  now: () => number,
  reply: (message: SlackCommandMessage) => Promise<void>,
): Promise<SlackCommandOutcome> {
  const threadIndex = deps.threads ?? defaultThreadIndex;
  const activityOf = deps.activity ?? defaultThreadActivity(now);
  const name = sessionRef(session);
  const label = escapeMrkdwn(name);

  switch (parse.kind) {
    case "status": {
      const index = threadIndex(session);
      const turn = (deps.activeTurn ?? defaultActiveTurn(now))(session.sessionKey);
      const runtime = (deps.describeRuntime ?? defaultDescribeRuntime)(session, config);
      const lines = [
        `*Who answers here*: agent \`${session.agentId}\` · session \`${label}\``,
        `*Model*: ${escapeMrkdwn(runtime)}`,
        `*Now*: ${turn ? `working for ${formatSlackCommandAge(now() - turn.startedAt)}` : "idle"}`,
        `*Open threads*: ${index.count()}`,
      ];
      await reply(slackCommandMessage(lines.join("\n")));
      return { decision: "allowed", code: "ok" };
    }

    case "threads": {
      const index = threadIndex(session);
      const total = index.count();
      if (total === 0) {
        await reply(slackCommandMessage(`No open threads in \`${label}\`.`));
        return { decision: "allowed", code: "ok" };
      }
      const shown = index.newest(MAX_LISTED_THREADS);
      const lines = shown.map((thread) => {
        const threadName = thread.childSessionName ?? thread.requestId;
        const title = thread.title ? ` ${oneLine(thread.title)}` : "";
        const activity = activityOf(thread);
        return `• \`${escapeMrkdwn(threadName)}\`${title} (${formatSlackCommandAge(now() - activity.lastActivityAt)}; ${threadStateLabel(thread, activity.busy)})`;
      });
      if (total > shown.length) lines.push(`… and ${total - shown.length} more`);
      await reply(slackCommandMessage([`*Open threads in \`${label}\`* (${total})`, ...lines].join("\n")));
      return { decision: "allowed", code: "ok" };
    }

    case "close": {
      const closeThread = deps.closeThread ?? defaultCloseThread;
      const result = await closeThread(slackThreadParentSessionKey(session.sessionKey), parse.threadRef);
      if (result.kind === "not_found") {
        await reply(
          slackCommandMessage(
            `I could not find thread \`${escapeMrkdwn(parse.threadRef.slice(0, 80))}\` in \`${label}\`. See the names with \`${event.command} threads\`.`,
          ),
        );
        return { decision: "info", code: "thread_not_found" };
      }
      if (result.kind === "refused") {
        await reply(slackCommandMessage(refusalText(result.name, result.code, result.message)));
        return { decision: "error", code: result.code };
      }
      await reply(
        slackCommandMessage(
          result.changed
            ? `Closed thread \`${escapeMrkdwn(result.name)}\`.`
            : `Thread \`${escapeMrkdwn(result.name)}\` was already closed.`,
        ),
      );
      return { decision: "allowed", code: result.changed ? "ok" : "already_closed" };
    }

    case "close_idle": {
      const closeThread = deps.closeThread ?? defaultCloseThread;
      const index = threadIndex(session);
      const cutoff = now() - parse.hours * 3_600_000;
      // Old by lifecycle, nothing waiting on anyone. Whether it is idle is decided below,
      // thread by thread, right before each close.
      const candidates = index
        .touchedBefore(cutoff)
        .filter(
          (thread) => thread.openDecisionCount === 0 && thread.pendingAnswerCount === 0 && !thread.parentReturn.pending,
        );
      let attempted = 0;
      let closed = 0;
      let active = 0;
      let examined = 0;
      const refused = new Map<string, number>();
      for (const thread of candidates) {
        if (closed >= MAX_IDLE_CLOSES || attempted >= MAX_IDLE_ATTEMPTS) break;
        examined += 1;
        // The health label is a sample; the runtime's records are the truth. Read them now: a
        // thread that got new instructions, or finished work, since the list was read is not idle.
        const activity = activityOf(thread);
        if (activity.busy || activity.lastActivityAt > cutoff) {
          active += 1;
          continue;
        }
        attempted += 1;
        const result = await closeThread(index.parentSessionKey, thread.requestId);
        if (result.kind === "closed") {
          // Another close that won the race leaves nothing for this call to count.
          if (result.changed) closed += 1;
          continue;
        }
        const reason = result.kind === "refused" ? result.code : "THREAD_NOT_FOUND";
        refused.set(reason, (refused.get(reason) ?? 0) + 1);
      }
      if (attempted === 0) {
        await reply(
          slackCommandMessage(
            active > 0
              ? `No thread in \`${label}\` has been idle for more than ${parse.hours} h: ${active} old ${plural(active, "thread has", "threads have")} recent activity or work in progress.`
              : `No thread in \`${label}\` has been idle for more than ${parse.hours} h.`,
          ),
        );
        return { decision: "allowed", code: "none_idle" };
      }
      const lines = [
        `Closed ${closed} ${plural(closed, "thread", "threads")} idle for more than ${parse.hours} h in \`${label}\`.`,
      ];
      for (const [code, count] of refused) {
        lines.push(
          `• ${count} refused: \`${code}\`${code === "THREAD_TRIGGERS_PENDING" ? " (still receives active triggers)" : ""}`,
        );
      }
      if (active > 0) lines.push(`• ${active} skipped: recent activity or work in progress.`);
      if (examined < candidates.length) {
        const left = candidates.length - examined;
        lines.push(
          closed > 0
            ? `${left} more for the next round: run the command again.`
            : `${left} more not tried: nothing closed, so running it again will not get further until the refusals above are resolved.`,
        );
      }
      await reply(slackCommandMessage(lines.join("\n")));
      return { decision: "allowed", code: "ok" };
    }

    case "stop": {
      let result: RuntimeControlResult;
      try {
        result = await (deps.interrupt ?? defaultInterrupt)(session);
      } catch (error) {
        const timedOut = error instanceof Error && error.message.startsWith("Request timeout");
        await reply(
          slackCommandMessage(
            timedOut
              ? "The runtime did not answer in time, so I do not know whether the turn stopped. Check with `status`."
              : "I could not reach the runtime right now. Nothing was interrupted.",
          ),
        );
        return { decision: "error", code: timedOut ? "runtime_timeout" : "runtime_unavailable" };
      }
      if (result.ok) {
        await reply(slackCommandMessage(`Interrupted the turn running in \`${label}\`. The queue goes on.`));
        return { decision: "allowed", code: "ok" };
      }
      if (result.code === RUNTIME_NO_ACTIVE_TURN) {
        await reply(slackCommandMessage(`Nothing running in \`${label}\`.`));
        return { decision: "info", code: "nothing_running" };
      }
      if (result.code === RUNTIME_SESSION_NOT_ACTIVE) {
        await reply(
          slackCommandMessage(`Session \`${label}\` has no active runtime on this host: nothing to interrupt.`),
        );
        return { decision: "info", code: "session_not_active" };
      }
      await reply(slackCommandMessage(`I could not interrupt (\`${result.code ?? "RUNTIME_CONTROL_FAILED"}\`).`));
      return { decision: "error", code: result.code ?? "RUNTIME_CONTROL_FAILED" };
    }
  }
}

/** Why a thread did not close, in words, with the way out when there is one. */
function refusalText(name: string, code: string, message: string): string {
  const label = `\`${escapeMrkdwn(name)}\``;
  if (code === "THREAD_TRIGGERS_PENDING") {
    const ids =
      /active triggers: ([^.]+)\./
        .exec(message)?.[1]
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean) ?? [];
    const list = ids.length > 0 ? ` (${ids.map((id) => `\`${escapeMrkdwn(id)}\``).join(", ")})` : "";
    return [
      `Did not close ${label}: it still receives active triggers${list}.`,
      "Point each one at the channel session with `ravi triggers set <id> replySession <channel-session>` and run it again.",
    ].join("\n");
  }
  if (code === "THREAD_DECISIONS_PENDING") {
    return `Did not close ${label}: there is an open question or an answer not yet delivered. Answer it and confirm delivery before closing.`;
  }
  if (code === "THREAD_PARENT_RETURN_PENDING") {
    return `Did not close ${label}: the previous return to the channel session is still pending. Try again in a moment.`;
  }
  return `I could not close ${label} (\`${code}\`).`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
