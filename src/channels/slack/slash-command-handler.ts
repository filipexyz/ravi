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
import { canWithCapabilities, materializeSubjectCapabilities } from "../../permissions/provider-runtime.js";
import {
  findSessionByAttachedChat,
  getSession,
  isChatCompatibleWithSession,
  matchRoute,
  previewCommittedSessionKey,
} from "../../router/index.js";
import { type ContextCapability, dbFindChat } from "../../router/router-db.js";
import type { RouterConfig, SessionEntry } from "../../router/types.js";
import { listRuntimeTurnAttempts } from "../../runtime/crash-recovery-store.js";
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
  listSlackThreadsForSession,
  type SlackThreadSummary,
  slackThreadParentSessionKey,
} from "./thread-lifecycle.js";

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
  | { readonly kind: "no_route" };

/** What an operation needs from the command metadata the CLI declares for it. */
export interface InheritedCommandAccess {
  readonly group: string;
  readonly command: string;
  readonly access: CommandAccessOptions;
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
  listThreads?: (session: SessionEntry) => {
    parentSessionKey: string;
    parentSessionName: string;
    threads: SlackThreadSummary[];
  };
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
  return session
    ? { kind: "session", session, agentId: matched.agentId }
    : { kind: "session_missing", agentId: matched.agentId, sessionKey };
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

function threadStateLabel(thread: SlackThreadSummary): string {
  const state = thread.turnHealth?.state;
  const parts: string[] = [];
  if (state === "running") parts.push("working");
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

  const age = now() - event.receivedAt;
  if (age > SLACK_COMMAND_MAX_AGE_MS || age < -SLACK_COMMAND_MAX_AGE_MS) {
    await reply(slackCommandMessage("That command arrived late and was *not run*. Run it again."));
    return record({ decision: "denied", code: "stale" });
  }

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
  if (!canWithCapabilities(capabilities, need, "session", sessionRef(session))) {
    await reply(
      slackCommandMessage(
        need === "modify"
          ? `You are not allowed to change session \`${sessionRef(session)}\`.`
          : `You do not have access to session \`${sessionRef(session)}\`.`,
      ),
    );
    return record({ decision: "denied", code: need === "modify" ? "not_authorized_modify" : "not_authorized_access" });
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

  try {
    return await record(await run(parse, event, session, config, deps, now, reply));
  } catch (error) {
    log.warn("Slack command failed", { subcommand: parse.kind, error: errorText(error) });
    await reply(slackCommandMessage("I could not run that right now. Try again in a moment."));
    return record({ decision: "error", code: "failed" });
  }
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
  const listThreads = deps.listThreads ?? ((target: SessionEntry) => listSlackThreadsForSession(target));
  const name = sessionRef(session);
  const label = escapeMrkdwn(name);

  switch (parse.kind) {
    case "status": {
      const listed = listThreads(session);
      const turn = (deps.activeTurn ?? defaultActiveTurn(now))(session.sessionKey);
      const runtime = (deps.describeRuntime ?? defaultDescribeRuntime)(session, config);
      const lines = [
        `*Who answers here*: agent \`${session.agentId}\` · session \`${label}\``,
        `*Model*: ${escapeMrkdwn(runtime)}`,
        `*Now*: ${turn ? `working for ${formatSlackCommandAge(now() - turn.startedAt)}` : "idle"}`,
        `*Open threads*: ${listed.threads.length}`,
      ];
      await reply(slackCommandMessage(lines.join("\n")));
      return { decision: "allowed", code: "ok" };
    }

    case "threads": {
      const listed = listThreads(session);
      if (listed.threads.length === 0) {
        await reply(slackCommandMessage(`No open threads in \`${label}\`.`));
        return { decision: "allowed", code: "ok" };
      }
      const ordered = [...listed.threads].sort((a, b) => b.updatedAt - a.updatedAt);
      const shown = ordered.slice(0, MAX_LISTED_THREADS);
      const lines = shown.map((thread) => {
        const threadName = thread.childSessionName ?? thread.requestId;
        const title = thread.title ? ` ${oneLine(thread.title)}` : "";
        return `• \`${escapeMrkdwn(threadName)}\`${title} (${formatSlackCommandAge(now() - thread.updatedAt)}; ${threadStateLabel(thread)})`;
      });
      if (ordered.length > shown.length) lines.push(`… and ${ordered.length - shown.length} more`);
      await reply(
        slackCommandMessage([`*Open threads in \`${label}\`* (${listed.threads.length})`, ...lines].join("\n")),
      );
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
      const listed = listThreads(session);
      const cutoff = now() - parse.hours * 3_600_000;
      const idle = listed.threads
        .filter(
          (thread) =>
            thread.status === "open" &&
            thread.updatedAt <= cutoff &&
            thread.turnHealth?.state !== "running" &&
            thread.openDecisionCount === 0 &&
            thread.pendingAnswerCount === 0 &&
            !thread.parentReturn.pending,
        )
        .sort((a, b) => a.updatedAt - b.updatedAt);
      const batch = idle.slice(0, MAX_IDLE_CLOSES);
      let closed = 0;
      const refused = new Map<string, number>();
      for (const thread of batch) {
        const result = await closeThread(listed.parentSessionKey, thread.requestId);
        if (result.kind === "closed") {
          closed += 1;
          continue;
        }
        const reason = result.kind === "refused" ? result.code : "THREAD_NOT_FOUND";
        refused.set(reason, (refused.get(reason) ?? 0) + 1);
      }
      if (idle.length === 0) {
        await reply(slackCommandMessage(`No thread in \`${label}\` has been idle for more than ${parse.hours} h.`));
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
      if (idle.length > batch.length) {
        lines.push(`${idle.length - batch.length} more for the next round: run the command again.`);
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
          await handleSlackCommand(event.data, deps);
        } catch (error) {
          log.warn("Failed to answer a Slack command", { error: errorText(error) });
        }
      }
    } catch (error) {
      if (!stopped) log.error("Slack command consumer stopped", { error });
    }
  })();
}

export function stopSlackCommandConsumer(): void {
  consumerStop?.();
  consumerStop = null;
}
