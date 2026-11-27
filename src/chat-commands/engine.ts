/**
 * Chat commands: a person controls Ravi from a chat, whichever channel that is.
 *
 * The channel adapter does what only it can: read its own event, say who typed
 * it (a contact), find the session an agent answers in for that chat, own the
 * threads its platform has, and say the answer in its own words and markup.
 * This engine does the rest, the same for every channel: the command is never
 * replayed, the person's authority decides (reads need access to the session;
 * `close` and `stop` need to modify it AND hold the capability the CLI asks for
 * the operation they call, so the command cannot drift from the CLI), the
 * operation runs, and every command, refused ones included, is audited.
 *
 * The engine reads no channel name and imports no channel code. The channel
 * reaches it only through `ChatCommandChannel`; its answer leaves as a
 * `ChatCommandResult` (facts), never as text for a channel.
 *
 * Spec: permissions/chat-commands.
 */

import {
  enforceCliCommandAccess,
  type CliCommandAccessInput,
  type CliCommandAccessResult,
} from "../cli/command-access.js";
import { type CommandAccessOptions, getCommandAccessMetadata } from "../cli/decorators.js";
import { configStore } from "../config-store.js";
import { nats as runtimeNats } from "../nats.js";
import { authorizePermission, materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { getSession } from "../router/index.js";
import type { ContextCapability } from "../router/router-db.js";
import type { RouterConfig, SessionEntry } from "../router/types.js";
import { listRuntimePromptQueue, listRuntimeTurnAttempts } from "../runtime/crash-recovery-store.js";
import { applyProviderModelRule } from "../runtime/model-catalog.js";
import { RUNTIME_NO_ACTIVE_TURN, RUNTIME_SESSION_NOT_ACTIVE } from "../runtime/runtime-control-errors.js";
import { resolveEffectiveSessionRuntime } from "../runtime/runtime-selection.js";
import type { RuntimeControlResult } from "../runtime/types.js";
import { logger } from "../utils/logger.js";
import { requestReply } from "../utils/request-reply.js";
import {
  type ChatCommandAction,
  type ChatCommandActionParse,
  type ChatCommandStaticParse,
  isChatCommandAction,
  parseChatCommandText,
} from "./parse.js";

const log = logger.child("chat-commands");

/** A command older than this never runs: a restart must not execute a `stop` from minutes ago. */
export const CHAT_COMMAND_MAX_AGE_MS = 60_000;
export const CHAT_COMMAND_AUDIT_TOPIC = "ravi.audit.chat_command";
/** The topic `ravi sessions runtime` requests on; the runtime host (runtime/host-subscriptions.ts) answers it. */
export const CHAT_COMMAND_RUNTIME_CONTROL_TOPIC = "ravi.session.runtime.control";
const RUNTIME_CONTROL_TIMEOUT_MS = 10_000;
export const CHAT_COMMAND_MAX_LISTED_THREADS = 12;
const MAX_IDLE_CLOSES = 25;
/** Closes tried in one call, refused ones included: a thread that keeps refusing must not hide the ones behind it. */
const MAX_IDLE_ATTEMPTS = 100;

export type ChatCommandDecision = "allowed" | "denied" | "info" | "error";

export interface ChatCommandOutcome {
  readonly decision: ChatCommandDecision;
  /** Stable result code for the audit row and for tests. */
  readonly code: string;
}

/**
 * Where a command came from, as the channel adapter states it. Values the
 * adapter supplies (`channel` is its own name): the engine only carries them
 * into the audit row and never branches on them.
 */
export interface ChatCommandOrigin {
  readonly channel: string;
  readonly accountId: string;
  readonly instanceId: string;
  readonly chatId: string;
  /** The person as the platform knows them, before they are a contact. */
  readonly actorId: string;
  /** The platform's id for this command, when it has one (an envelope, a message). */
  readonly requestId?: string;
  /** How the person reached the command on that platform (a typed command, a button): a value, for the audit. */
  readonly surface?: string;
}

/** One audit row per command, refused ones included. It carries no text typed, no URL and no token. */
export interface ChatCommandAudit {
  readonly type: "chat_command";
  readonly at: number;
  readonly channel: string;
  readonly accountId: string;
  readonly instanceId: string;
  readonly chatId: string;
  readonly actorId: string;
  readonly contactId: string | null;
  readonly sessionKey: string | null;
  readonly sessionName: string | null;
  readonly subcommand: string;
  readonly decision: ChatCommandDecision;
  readonly code: string;
  readonly requestId?: string;
  readonly surface?: string;
}

export type ChatCommandSessionResolution =
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

/** The facts of a thread the engine reads. A channel's own summary type satisfies it structurally. */
export interface ChatThreadSummary {
  readonly requestId: string;
  readonly title: string | null;
  readonly childSessionKey: string | null;
  readonly childSessionName: string | null;
  /** The thread recorded a child session that no longer exists. */
  readonly childSessionMissing: boolean;
  readonly openDecisionCount: number;
  readonly pendingAnswerCount: number;
  readonly updatedAt: number;
  readonly turnHealth: { readonly state: string; readonly lastSignalAt: number | null } | null;
  readonly parentReturn: { readonly pending: boolean };
  /** The thread's lifecycle state as the channel names it. `closed` is the only value the engine reads. */
  readonly status?: string;
}

/**
 * The threads a session owns, with no silent ceiling: `count` counts them all,
 * `newest` reads the page that is shown, and `touchedBefore` walks every open
 * thread, so cleanup sees the old ones even when many newer threads exist.
 */
export interface ChatThreadIndex {
  readonly parentSessionKey: string;
  readonly parentSessionName: string;
  count(): number;
  newest(limit: number): ChatThreadSummary[];
  /** Open threads whose lifecycle was last touched at or before `cutoff`, oldest first. */
  touchedBefore(cutoff: number): ChatThreadSummary[];
}

export interface ChatThreadActivity {
  /** A turn is running, or work is already queued for it. */
  readonly busy: boolean;
  /** The latest sign of life: lifecycle, runtime attempts, the child session, the health observation. */
  readonly lastActivityAt: number;
}

export type ChatThreadCloseResult =
  | { readonly kind: "closed"; readonly name: string; readonly changed: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly name: string; readonly code: string; readonly message: string };

/** One listed thread, as facts: the adapter decides how to word them. */
export interface ChatThreadRow {
  readonly name: string;
  readonly title: string | null;
  readonly ageMs: number;
  readonly busy: boolean;
  /** The health sample's state, when there is one. */
  readonly health: string | null;
  readonly openDecisionCount: number;
  readonly returnPending: boolean;
  readonly sessionGone: boolean;
}

/** One thread asked about by name (`status <thread>`): the row a listing shows, and what only this view needs. */
export interface ChatThreadDetail extends ChatThreadRow {
  readonly closed: boolean;
  /** Answers given to a question of the thread that have not been delivered yet. */
  readonly pendingAnswerCount: number;
}

/** What a command came to, as facts. The channel adapter words and formats them for its own platform. */
export type ChatCommandResult =
  | { readonly kind: "stale" }
  | { readonly kind: "static"; readonly parse: ChatCommandStaticParse }
  | { readonly kind: "unknown_actor" }
  | { readonly kind: "no_route" }
  | { readonly kind: "route_conflict" }
  | { readonly kind: "session_missing"; readonly agentId: string }
  | { readonly kind: "not_authorized"; readonly need: "access" | "modify"; readonly sessionName: string }
  | { readonly kind: "access_metadata_missing" }
  | {
      readonly kind: "not_authorized_command";
      readonly operation: "interrupt" | "close-thread" | "clone";
      readonly capability?: string;
    }
  | { readonly kind: "threads_unsupported" }
  | {
      readonly kind: "status";
      readonly agentId: string;
      readonly sessionName: string;
      readonly runtime: string;
      readonly workingForMs: number | null;
      /** Null when the channel has no threads. */
      readonly openThreads: number | null;
    }
  | { readonly kind: "thread_status"; readonly sessionName: string; readonly thread: ChatThreadDetail }
  | { readonly kind: "threads_none"; readonly sessionName: string }
  | {
      readonly kind: "threads";
      readonly sessionName: string;
      readonly total: number;
      readonly rows: readonly ChatThreadRow[];
      readonly more: number;
    }
  | { readonly kind: "thread_not_found"; readonly ref: string; readonly sessionName: string }
  | { readonly kind: "thread_close_refused"; readonly name: string; readonly code: string; readonly message: string }
  | { readonly kind: "thread_closed"; readonly name: string; readonly changed: boolean }
  | {
      readonly kind: "idle_none";
      readonly sessionName: string;
      readonly hours: number;
      /** Old threads left alone: recent activity or work in progress. */
      readonly active: number;
    }
  | {
      readonly kind: "idle_closed";
      readonly sessionName: string;
      readonly hours: number;
      readonly closed: number;
      readonly refused: ReadonlyArray<{ readonly code: string; readonly count: number }>;
      readonly active: number;
      /** Candidates not tried in this call. */
      readonly left: number;
    }
  | { readonly kind: "stop_timeout" }
  | { readonly kind: "stop_unreachable" }
  | { readonly kind: "stopped"; readonly sessionName: string }
  | { readonly kind: "nothing_running"; readonly sessionName: string }
  | { readonly kind: "session_not_active"; readonly sessionName: string }
  | { readonly kind: "stop_failed"; readonly code: string }
  /** `clone <name>`: the new chat and session, as facts. */
  | {
      readonly kind: "cloned";
      readonly sessionName: string;
      readonly cloneName: string;
      readonly chatId: string;
      readonly messages: number;
      readonly redacted: boolean;
      readonly inviteFailed: boolean;
    }
  | { readonly kind: "clone_refused"; readonly code: string; readonly message: string }
  | { readonly kind: "failed" };

/** What a channel adapter provides for one command. */
export interface ChatCommandChannel {
  readonly origin: ChatCommandOrigin;
  /** The text that follows the channel's own command word. */
  readonly text: string;
  /** When the channel received the command. */
  readonly receivedAt: number;
  /** The person as a contact: the adapter's identity lookup. Null when nobody is linked. */
  contactId(): string | null;
  /** The session an agent answers in for this chat, resolved the way an inbound message there would be. */
  resolveSession(config: RouterConfig): ChatCommandSessionResolution;
  /** The threads of a session. Absent when the channel has none: the thread commands then say so. */
  threads?(session: SessionEntry): ChatThreadIndex;
  closeThread?(session: SessionEntry, threadRef: string): Promise<ChatThreadCloseResult>;
  /** One thread of a session, by whatever ref the person gave (its name, its request id, the platform's own id). */
  findThread?(session: SessionEntry, threadRef: string): ChatThreadSummary | null;
  /**
   * The access metadata the CLI declares for the command that closes this channel's threads, so
   * what is asked of a person cannot drift from the CLI. Absent when the channel has no threads;
   * a command that needs it and gets none is refused.
   */
  closeAccess?(): Promise<InheritedCommandAccess | undefined>;
  /**
   * Clone the chat's session into a new chat of this channel (`sessions clone`). Absent when the
   * channel cannot create chats: `clone` then says so.
   */
  clone?(input: ChatCommandCloneInput): Promise<ChatCommandCloneOutcome>;
  /** The access metadata the CLI declares for `sessions clone`, as for `closeAccess`. */
  cloneAccess?(): Promise<InheritedCommandAccess | undefined>;
  /** Say the result in this channel. Must not throw: a delivery failure is the adapter's to log. */
  reply(result: ChatCommandResult): Promise<void>;
}

export interface ChatCommandCloneInput {
  readonly session: SessionEntry;
  readonly name: string;
  readonly contactId: string;
  /** The person on their platform: the channel decides whether it can invite them. */
  readonly actorId: string;
}

export type ChatCommandCloneOutcome =
  | {
      readonly kind: "cloned";
      readonly sessionName: string;
      readonly chatId: string;
      readonly messages: number;
      readonly redacted: boolean;
      readonly inviteFailed: boolean;
    }
  | { readonly kind: "refused"; readonly code: string; readonly message: string };

/** What tests replace. Every default reads the real stores. */
export interface ChatCommandDeps {
  now?: () => number;
  routerConfig?: () => RouterConfig;
  capabilitiesFor?: (contactId: string) => ContextCapability[];
  commandAccess?: (input: CliCommandAccessInput) => CliCommandAccessResult;
  inheritedAccess?: (operation: "close-thread" | "interrupt" | "clone") => Promise<InheritedCommandAccess | undefined>;
  /** Replaces the channel's `clone` (tests). */
  cloneSession?: (input: ChatCommandCloneInput) => Promise<ChatCommandCloneOutcome>;
  /** What a thread is doing right now, read at the moment it is needed. */
  activity?: (thread: ChatThreadSummary) => ChatThreadActivity;
  activeTurn?: (sessionKey: string) => { turnId: string; startedAt: number } | null;
  describeRuntime?: (session: SessionEntry, config: RouterConfig) => string;
  interrupt?: (session: SessionEntry) => Promise<RuntimeControlResult>;
  audit?: (entry: ChatCommandAudit) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Authority

/** What the person must hold on the session of the chat. */
export const CHAT_COMMAND_SESSION_RIGHT: Readonly<Record<ChatCommandAction, "access" | "modify">> = {
  status: "access",
  threads: "access",
  close: "modify",
  close_idle: "modify",
  stop: "modify",
  // What a clone copies is what the person can already read (the recap): access to the session,
  // plus the mutating capability of `sessions clone` itself, asked below like close and stop.
  clone: "access",
};

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
  operation: "close-thread" | "interrupt" | "clone",
  channel: ChatCommandChannel,
): Promise<InheritedCommandAccess | undefined> {
  // Cloning creates a chat on the channel's platform, so the channel runs it and declares its access.
  if (operation === "clone") return channel.cloneAccess?.();
  // The CLI classes carry the access metadata the operation declares, so the command cannot drift
  // from what the CLI asks for. The command that closes a channel's threads is the channel's own
  // (it imports that channel's thread code), so the channel says what it declares; the engine
  // reads only the runtime control class, which is the same for every channel.
  if (operation === "close-thread") return channel.closeAccess?.();
  const { SessionRuntimeCommands } = await import("../cli/commands/sessions-runtime.js");
  const access = getCommandAccessMetadata(SessionRuntimeCommands).get("interrupt");
  return access ? { group: "sessions.runtime", command: "interrupt", access } : undefined;
}

// ---------------------------------------------------------------------------
// Default dependencies

/**
 * What a thread is doing now, from the runtime's own records and not from the
 * health label, which is a sample taken every so often. The lifecycle
 * `updatedAt` does not move when a parent sends new instructions, so the last
 * activity is the latest of that, the child session's own update, its turn
 * attempts (start, heartbeat, completion) and the health sample.
 */
function defaultThreadActivity(now: () => number) {
  return (thread: ChatThreadSummary): ChatThreadActivity => {
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
    CHAT_COMMAND_RUNTIME_CONTROL_TOPIC,
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

async function defaultAudit(entry: ChatCommandAudit): Promise<void> {
  if (process.env.RAVI_SUPPRESS_AUDIT_EVENTS === "1") return;
  await runtimeNats.emit(CHAT_COMMAND_AUDIT_TOPIC, entry as unknown as Record<string, unknown>);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStale(receivedAt: number, at: number): boolean {
  const age = at - receivedAt;
  return age > CHAT_COMMAND_MAX_AGE_MS || age < -CHAT_COMMAND_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Engine

interface Verdict {
  readonly result: ChatCommandResult;
  readonly outcome: ChatCommandOutcome;
}

/**
 * One command, start to answer. Returns what happened. The channel's `reply`
 * is called once with the result, then the audit row is published.
 */
export async function runChatCommand(
  channel: ChatCommandChannel,
  deps: ChatCommandDeps = {},
): Promise<ChatCommandOutcome> {
  const now = deps.now ?? Date.now;
  const config = (deps.routerConfig ?? (() => configStore.getConfig()))();
  const parse = parseChatCommandText(channel.text);

  let contactId: string | null = null;
  let session: SessionEntry | null = null;

  const record = async (outcome: ChatCommandOutcome): Promise<ChatCommandOutcome> => {
    const entry: ChatCommandAudit = {
      type: "chat_command",
      at: now(),
      channel: channel.origin.channel,
      accountId: channel.origin.accountId,
      instanceId: channel.origin.instanceId,
      chatId: channel.origin.chatId,
      actorId: channel.origin.actorId,
      contactId,
      sessionKey: session?.sessionKey ?? null,
      sessionName: session?.name ?? null,
      subcommand: parse.kind,
      decision: outcome.decision,
      code: outcome.code,
      ...(channel.origin.requestId ? { requestId: channel.origin.requestId } : {}),
      ...(channel.origin.surface ? { surface: channel.origin.surface } : {}),
    };
    log.info("Chat command", entry);
    try {
      await (deps.audit ?? defaultAudit)(entry);
    } catch (error) {
      log.warn("Chat command audit event was not published", { error: errorText(error) });
    }
    return outcome;
  };

  const say = async (result: ChatCommandResult): Promise<void> => {
    try {
      await channel.reply(result);
    } catch (error) {
      log.warn("Chat command answer was not delivered", { error: errorText(error) });
    }
  };

  const finish = async (result: ChatCommandResult, outcome: ChatCommandOutcome): Promise<ChatCommandOutcome> => {
    await say(result);
    return record(outcome);
  };

  const refuseStale = (): Promise<ChatCommandOutcome> =>
    finish({ kind: "stale" }, { decision: "denied", code: "stale" });
  if (isStale(channel.receivedAt, now())) return refuseStale();

  // Everything from here is covered by one handler: a failure while resolving the person, the
  // session or the authority is answered and audited like any other, not left to the consumer's log.
  const execute = async (): Promise<ChatCommandOutcome> => {
    if (!isChatCommandAction(parse)) {
      // Static text: no person, session or authority involved, so no identity lookup either: a
      // lookup that fails must not take help away. The adapter decides whether it still has to
      // say it (its platform may already have answered).
      return finish({ kind: "static", parse }, { decision: "info", code: "help" });
    }

    contactId = channel.contactId();
    if (!contactId) {
      return finish({ kind: "unknown_actor" }, { decision: "denied", code: "unknown_user" });
    }

    const resolution = channel.resolveSession(config);
    if (resolution.kind === "no_route") {
      return finish({ kind: "no_route" }, { decision: "info", code: "no_route" });
    }
    if (resolution.kind === "route_conflict") {
      return finish({ kind: "route_conflict" }, { decision: "error", code: "route_conflict" });
    }
    if (resolution.kind === "session_missing") {
      return finish(
        { kind: "session_missing", agentId: resolution.agentId },
        { decision: "info", code: "session_missing" },
      );
    }
    session = resolution.session;
    const name = sessionRef(session);

    // Authority: this contact, and only this contact. Reads need access to the
    // session; changes need to modify it and hold the command's own capability.
    const capabilities = (deps.capabilitiesFor ?? ((id) => materializeSubjectCapabilities("contact", id)))(contactId);
    const need = CHAT_COMMAND_SESSION_RIGHT[parse.kind];
    if (!contactCan(contactId, capabilities, need, "session", name)) {
      return finish(
        { kind: "not_authorized", need, sessionName: name },
        { decision: "denied", code: need === "modify" ? "not_authorized_modify" : "not_authorized_access" },
      );
    }

    const operation =
      parse.kind === "stop"
        ? "interrupt"
        : parse.kind === "clone"
          ? "clone"
          : parse.kind === "status" || parse.kind === "threads"
            ? null
            : "close-thread";
    if (operation) {
      const inherited = await (deps.inheritedAccess ?? ((name) => defaultInheritedAccess(name, channel)))(operation);
      // No declared metadata means no way to ask the CLI's question: refuse. And a command that
      // changes state must be asked a mutating capability: a channel that declared a read command
      // for it (by mistake or otherwise) would let a reader close threads or stop turns.
      if (!inherited || inherited.access.kind !== "mutate") {
        return finish({ kind: "access_metadata_missing" }, { decision: "error", code: "access_metadata_missing" });
      }
      const verdict = (deps.commandAccess ?? enforceCliCommandAccess)({
        source: "channel-command",
        subject: { type: "contact", id: contactId },
        group: inherited.group,
        command: inherited.command,
        access: inherited.access,
        input: {},
      });
      if (!verdict.allowed) {
        const capability = verdict.denialDetails?.capability;
        return finish(
          { kind: "not_authorized_command", operation, ...(capability ? { capability } : {}) },
          { decision: "denied", code: "not_authorized_command" },
        );
      }
    }

    // Loading the CLI's access metadata can take a while the first time: freshness is checked again
    // right before anything changes.
    if (isStale(channel.receivedAt, now())) return refuseStale();

    const verdict = await run(parse, channel, session, config, deps, now, contactId);
    return finish(verdict.result, verdict.outcome);
  };

  try {
    return await execute();
  } catch (error) {
    log.warn("Chat command failed", { subcommand: parse.kind, error: errorText(error) });
    await say({ kind: "failed" });
    return record({ decision: "error", code: "failed" });
  }
}

async function run(
  parse: ChatCommandActionParse,
  channel: ChatCommandChannel,
  session: SessionEntry,
  config: RouterConfig,
  deps: ChatCommandDeps,
  now: () => number,
  contactId: string,
): Promise<Verdict> {
  const activityOf = deps.activity ?? defaultThreadActivity(now);
  const name = sessionRef(session);
  const unsupported: Verdict = {
    result: { kind: "threads_unsupported" },
    outcome: { decision: "info", code: "threads_unsupported" },
  };

  const rowOf = (thread: ChatThreadSummary): ChatThreadRow => {
    const activity = activityOf(thread);
    return {
      name: thread.childSessionName ?? thread.requestId,
      title: thread.title,
      ageMs: now() - activity.lastActivityAt,
      busy: activity.busy,
      health: thread.turnHealth?.state ?? null,
      openDecisionCount: thread.openDecisionCount,
      returnPending: thread.parentReturn.pending,
      sessionGone: thread.childSessionMissing,
    };
  };

  switch (parse.kind) {
    case "status": {
      // `status <thread>`: that thread's own state, found among the threads of the chat's session.
      // The rights are those of a plain `status` (access to the session), asked before the lookup.
      if (parse.threadRef !== undefined) {
        if (!channel.findThread) return unsupported;
        const thread = channel.findThread(session, parse.threadRef);
        if (!thread) {
          return {
            result: { kind: "thread_not_found", ref: parse.threadRef, sessionName: name },
            outcome: { decision: "info", code: "thread_not_found" },
          };
        }
        return {
          result: {
            kind: "thread_status",
            sessionName: name,
            thread: {
              ...rowOf(thread),
              closed: thread.status === "closed",
              pendingAnswerCount: thread.pendingAnswerCount,
            },
          },
          outcome: { decision: "allowed", code: "ok" },
        };
      }
      const index = channel.threads?.(session);
      const turn = (deps.activeTurn ?? defaultActiveTurn(now))(session.sessionKey);
      const runtime = (deps.describeRuntime ?? defaultDescribeRuntime)(session, config);
      return {
        result: {
          kind: "status",
          agentId: session.agentId,
          sessionName: name,
          runtime,
          workingForMs: turn ? now() - turn.startedAt : null,
          openThreads: index ? index.count() : null,
        },
        outcome: { decision: "allowed", code: "ok" },
      };
    }

    case "threads": {
      if (!channel.threads) return unsupported;
      const index = channel.threads(session);
      const total = index.count();
      if (total === 0) {
        return { result: { kind: "threads_none", sessionName: name }, outcome: { decision: "allowed", code: "ok" } };
      }
      const shown = index.newest(CHAT_COMMAND_MAX_LISTED_THREADS);
      const rows = shown.map(rowOf);
      return {
        result: {
          kind: "threads",
          sessionName: name,
          total,
          rows,
          more: total > shown.length ? total - shown.length : 0,
        },
        outcome: { decision: "allowed", code: "ok" },
      };
    }

    case "close": {
      if (!channel.closeThread) return unsupported;
      const result = await channel.closeThread(session, parse.threadRef);
      if (result.kind === "not_found") {
        return {
          result: { kind: "thread_not_found", ref: parse.threadRef, sessionName: name },
          outcome: { decision: "info", code: "thread_not_found" },
        };
      }
      if (result.kind === "refused") {
        return {
          result: { kind: "thread_close_refused", name: result.name, code: result.code, message: result.message },
          outcome: { decision: "error", code: result.code },
        };
      }
      return {
        result: { kind: "thread_closed", name: result.name, changed: result.changed },
        outcome: { decision: "allowed", code: result.changed ? "ok" : "already_closed" },
      };
    }

    case "close_idle": {
      if (!channel.threads || !channel.closeThread) return unsupported;
      const index = channel.threads(session);
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
        const result = await channel.closeThread(session, thread.requestId);
        if (result.kind === "closed") {
          // Another close that won the race leaves nothing for this call to count.
          if (result.changed) closed += 1;
          continue;
        }
        const reason = result.kind === "refused" ? result.code : "THREAD_NOT_FOUND";
        refused.set(reason, (refused.get(reason) ?? 0) + 1);
      }
      if (attempted === 0) {
        return {
          result: { kind: "idle_none", sessionName: name, hours: parse.hours, active },
          outcome: { decision: "allowed", code: "none_idle" },
        };
      }
      return {
        result: {
          kind: "idle_closed",
          sessionName: name,
          hours: parse.hours,
          closed,
          refused: [...refused].map(([code, count]) => ({ code, count })),
          active,
          left: examined < candidates.length ? candidates.length - examined : 0,
        },
        outcome: { decision: "allowed", code: "ok" },
      };
    }

    case "clone": {
      const clone = deps.cloneSession ?? channel.clone?.bind(channel);
      if (!clone) {
        return {
          result: {
            kind: "clone_refused",
            code: "CLONE_CHANNEL_UNSUPPORTED",
            message: "This channel cannot create chats yet.",
          },
          outcome: { decision: "info", code: "CLONE_CHANNEL_UNSUPPORTED" },
        };
      }
      const outcome = await clone({
        session,
        name: parse.name,
        contactId,
        actorId: channel.origin.actorId,
      });
      if (outcome.kind === "refused") {
        return {
          result: { kind: "clone_refused", code: outcome.code, message: outcome.message },
          outcome: { decision: outcome.code === "CLONE_PROVISION_FAILED" ? "error" : "info", code: outcome.code },
        };
      }
      return {
        result: {
          kind: "cloned",
          sessionName: name,
          cloneName: outcome.sessionName,
          chatId: outcome.chatId,
          messages: outcome.messages,
          redacted: outcome.redacted,
          inviteFailed: outcome.inviteFailed,
        },
        outcome: { decision: "allowed", code: "ok" },
      };
    }

    case "stop": {
      // `stop` interrupts the turn of the chat's session; `stop <thread>` that of the thread's own session.
      let target = session;
      let targetName = name;
      if (parse.threadRef !== undefined) {
        if (!channel.findThread) return unsupported;
        const thread = channel.findThread(session, parse.threadRef);
        if (!thread) {
          return {
            result: { kind: "thread_not_found", ref: parse.threadRef, sessionName: name },
            outcome: { decision: "info", code: "thread_not_found" },
          };
        }
        targetName = thread.childSessionName ?? thread.requestId;
        const child = thread.childSessionKey ? getSession(thread.childSessionKey) : null;
        if (!child) {
          // A thread whose session is gone has no turn to interrupt.
          return {
            result: { kind: "session_not_active", sessionName: targetName },
            outcome: { decision: "info", code: "session_not_active" },
          };
        }
        target = child;
      }
      let result: RuntimeControlResult;
      try {
        result = await (deps.interrupt ?? defaultInterrupt)(target);
      } catch (error) {
        const timedOut = error instanceof Error && error.message.startsWith("Request timeout");
        return {
          result: { kind: timedOut ? "stop_timeout" : "stop_unreachable" },
          outcome: { decision: "error", code: timedOut ? "runtime_timeout" : "runtime_unavailable" },
        };
      }
      if (result.ok) {
        return { result: { kind: "stopped", sessionName: targetName }, outcome: { decision: "allowed", code: "ok" } };
      }
      if (result.code === RUNTIME_NO_ACTIVE_TURN) {
        return {
          result: { kind: "nothing_running", sessionName: targetName },
          outcome: { decision: "info", code: "nothing_running" },
        };
      }
      if (result.code === RUNTIME_SESSION_NOT_ACTIVE) {
        return {
          result: { kind: "session_not_active", sessionName: targetName },
          outcome: { decision: "info", code: "session_not_active" },
        };
      }
      const code = result.code ?? "RUNTIME_CONTROL_FAILED";
      return { result: { kind: "stop_failed", code }, outcome: { decision: "error", code } };
    }
  }
}
