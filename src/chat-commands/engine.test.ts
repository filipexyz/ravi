import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CliCommandAccessInput, CliCommandAccessResult } from "../cli/command-access.js";
import type { ContextCapability } from "../router/router-db.js";
import type { RouterConfig, SessionEntry } from "../router/types.js";
import {
  RUNTIME_NO_ACTIVE_TURN,
  RUNTIME_OPERATION_UNSUPPORTED,
  RUNTIME_SESSION_NOT_ACTIVE,
} from "../runtime/runtime-control-errors.js";
import type { RuntimeControlResult } from "../runtime/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  CHAT_COMMAND_MAX_AGE_MS,
  CHAT_COMMAND_SESSION_RIGHT,
  type ChatCommandAudit,
  type ChatCommandChannel,
  type ChatCommandDeps,
  type ChatCommandResult,
  type ChatThreadCloseResult,
  type ChatThreadIndex,
  type ChatThreadSummary,
  runChatCommand,
} from "./engine.js";
import { CHAT_COMMAND_DEFAULT_IDLE_HOURS, isChatCommandStatic, parseChatCommandText } from "./parse.js";

const NOW = 1_800_000_000_000;
const CONTACT = "contact-ana";
const HOUR = 3_600_000;

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-chat-commands-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function session(name = "main", key = "agent:main:main"): SessionEntry {
  return { sessionKey: key, name, agentId: "main", agentCwd: "/tmp/main", createdAt: 1, updatedAt: 1 } as SessionEntry;
}

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId, source: "test" } as ContextCapability;
}

const READER: ContextCapability[] = [cap("access", "session", "main")];
const CONTROLLER: ContextCapability[] = [cap("access", "session", "main"), cap("modify", "session", "main")];
const NOBODY: ContextCapability[] = [];

function thread(overrides: Partial<ChatThreadSummary> = {}): ChatThreadSummary {
  return {
    requestId: "req-1",
    title: "Study",
    childSessionKey: "agent:main:main:thread:1.1",
    childSessionName: "main-t-1",
    childSessionMissing: false,
    openDecisionCount: 0,
    pendingAnswerCount: 0,
    updatedAt: NOW - 100 * HOUR,
    turnHealth: null,
    parentReturn: { pending: false },
    ...overrides,
  };
}

function indexOf(threads: ChatThreadSummary[]): ChatThreadIndex {
  return {
    parentSessionKey: "agent:main:main",
    parentSessionName: "main",
    count: () => threads.length,
    newest: (limit) => [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit),
    touchedBefore: (cutoff) =>
      threads.filter((entry) => entry.updatedAt <= cutoff).sort((a, b) => a.updatedAt - b.updatedAt),
  };
}

interface Harness {
  deps: ChatCommandDeps;
  channel: (text: string, overrides?: Partial<ChatCommandChannel>) => ChatCommandChannel;
  replies: ChatCommandResult[];
  audits: ChatCommandAudit[];
  calls: { threads: number; close: Array<[string, string]>; interrupt: number; access: CliCommandAccessInput[] };
}

function harness(
  options: {
    capabilities?: ContextCapability[];
    threads?: ChatThreadSummary[];
    commandAccess?: (input: CliCommandAccessInput) => CliCommandAccessResult;
    close?: (ref: string) => ChatThreadCloseResult;
    deps?: Partial<ChatCommandDeps>;
  } = {},
): Harness {
  const replies: ChatCommandResult[] = [];
  const audits: ChatCommandAudit[] = [];
  const calls: Harness["calls"] = { threads: 0, close: [], interrupt: 0, access: [] };
  const deps: ChatCommandDeps = {
    now: () => NOW,
    routerConfig: () => ({}) as RouterConfig,
    capabilitiesFor: () => options.capabilities ?? CONTROLLER,
    inheritedAccess: async (operation) => ({
      group: operation === "interrupt" ? "sessions.runtime" : "sessions",
      command: operation,
      access: { kind: "mutate", resource: "sessions", action: operation, risk: "medium" },
    }),
    commandAccess: (input) => {
      calls.access.push(input);
      return options.commandAccess?.(input) ?? { allowed: true, errorMessage: "", attempted: [] };
    },
    activity: (summary) => ({ busy: summary.turnHealth?.state === "running", lastActivityAt: summary.updatedAt }),
    activeTurn: () => null,
    describeRuntime: () => "claude · opus · xhigh",
    interrupt: async () => {
      calls.interrupt += 1;
      return { ok: true, operation: "turn.interrupt" };
    },
    audit: (entry) => {
      audits.push(entry);
    },
    ...options.deps,
  };
  const channel = (text: string, overrides: Partial<ChatCommandChannel> = {}): ChatCommandChannel => ({
    // A channel that is none of the real ones: the engine must work for any.
    origin: {
      channel: "testchat",
      accountId: "acct",
      instanceId: "inst",
      chatId: "room-1",
      actorId: "user-1",
      requestId: "req-1",
    },
    text,
    receivedAt: NOW,
    contactId: () => CONTACT,
    resolveSession: () => ({ kind: "session", session: session(), agentId: "main" }),
    threads: () => {
      calls.threads += 1;
      return indexOf(options.threads ?? []);
    },
    closeThread: async (_session, ref) => {
      calls.close.push(["agent:main:main", ref]);
      return options.close?.(ref) ?? { kind: "closed", name: ref, changed: true };
    },
    reply: async (result) => {
      replies.push(result);
    },
    ...overrides,
  });
  return { deps, channel, replies, audits, calls };
}

describe("the grammar", () => {
  it("is the same for every channel and answers static text without a session", () => {
    expect(parseChatCommandText("status")).toEqual({ kind: "status" });
    expect(parseChatCommandText("close idle")).toEqual({ kind: "close_idle", hours: CHAT_COMMAND_DEFAULT_IDLE_HOURS });
    expect(parseChatCommandText("close idle 6h")).toEqual({ kind: "close_idle", hours: 6 });
    expect(parseChatCommandText("close main-t-1")).toEqual({ kind: "close", threadRef: "main-t-1" });
    expect(isChatCommandStatic(parseChatCommandText(""))).toBe(true);
    expect(isChatCommandStatic(parseChatCommandText("stop"))).toBe(false);
  });
});

describe("who may run a command", () => {
  it("holds the right each subcommand needs on the session of the chat", () => {
    expect(CHAT_COMMAND_SESSION_RIGHT).toEqual({
      status: "access",
      threads: "access",
      close: "modify",
      close_idle: "modify",
      stop: "modify",
    });
  });

  it("lets a reader read, and refuses every change, close idle included, before anything runs", async () => {
    for (const text of ["status", "threads"]) {
      const h = harness({ capabilities: READER });
      expect(await runChatCommand(h.channel(text), h.deps)).toMatchObject({ decision: "allowed" });
    }
    for (const text of ["close main-t-1", "close idle", "close idle 2h", "stop"]) {
      const h = harness({ capabilities: READER, threads: [thread()] });

      const outcome = await runChatCommand(h.channel(text), h.deps);

      expect(outcome).toEqual({ decision: "denied", code: "not_authorized_modify" });
      expect(h.replies).toEqual([{ kind: "not_authorized", need: "modify", sessionName: "main" }]);
      expect(h.calls.close).toEqual([]);
      expect(h.calls.interrupt).toBe(0);
      expect(h.calls.threads).toBe(0);
    }
  });

  it("refuses a contact with no access to the session, even to read", async () => {
    const h = harness({ capabilities: NOBODY });

    expect(await runChatCommand(h.channel("status"), h.deps)).toEqual({
      decision: "denied",
      code: "not_authorized_access",
    });
    expect(h.replies).toEqual([{ kind: "not_authorized", need: "access", sessionName: "main" }]);
  });

  it("asks the command's own capability as the contact, from the source that names no channel", async () => {
    const h = harness({
      capabilities: CONTROLLER,
      commandAccess: () => ({
        allowed: false,
        errorMessage: "denied",
        attempted: [],
        denialDetails: { stage: "command_access", capability: "mutate:sessions:close-thread" },
      }),
    });

    const outcome = await runChatCommand(h.channel("close idle"), h.deps);

    expect(outcome).toEqual({ decision: "denied", code: "not_authorized_command" });
    expect(h.replies).toEqual([
      { kind: "not_authorized_command", operation: "close-thread", capability: "mutate:sessions:close-thread" },
    ]);
    expect(h.calls.access).toMatchObject([
      {
        source: "channel-command",
        subject: { type: "contact", id: CONTACT },
        group: "sessions",
        command: "close-thread",
      },
    ]);
    expect(h.calls.threads).toBe(0);
  });

  it("refuses when the CLI's declared access cannot be read, rather than guessing", async () => {
    const h = harness({ deps: { inheritedAccess: async () => undefined } });

    expect(await runChatCommand(h.channel("stop"), h.deps)).toEqual({
      decision: "error",
      code: "access_metadata_missing",
    });
    expect(h.calls.interrupt).toBe(0);
  });

  it("asks the channel for the access of the command that closes its threads, and refuses without it", async () => {
    // No injected access: the engine reads the runtime control class itself and asks the channel for the close.
    const declared = harness({ threads: [thread()], deps: { inheritedAccess: undefined } });
    const outcome = await runChatCommand(
      declared.channel("close idle", {
        closeAccess: async () => ({
          group: "sessions",
          command: "close-thread",
          access: { kind: "mutate", resource: "sessions", action: "close-thread", risk: "medium" },
        }),
      }),
      declared.deps,
    );

    expect(outcome).toEqual({ decision: "allowed", code: "ok" });
    expect(declared.calls.access).toMatchObject([
      { source: "channel-command", group: "sessions", command: "close-thread" },
    ]);

    const silent = harness({ threads: [thread()], deps: { inheritedAccess: undefined } });
    expect(await runChatCommand(silent.channel("close idle"), silent.deps)).toEqual({
      decision: "error",
      code: "access_metadata_missing",
    });
    expect(silent.calls.close).toEqual([]);
  });

  it("answers help with no identity lookup at all, so a lookup that fails cannot take it away", async () => {
    const h = harness();

    const outcome = await runChatCommand(
      h.channel("help", {
        contactId: () => {
          throw new Error("directory down");
        },
      }),
      h.deps,
    );

    expect(outcome).toEqual({ decision: "info", code: "help" });
    expect(h.replies).toEqual([{ kind: "static", parse: { kind: "help" } }]);
    expect(h.audits).toMatchObject([{ contactId: null, subcommand: "help", decision: "info" }]);
  });

  it("runs nothing for a person nobody linked to a contact", async () => {
    const h = harness();

    const outcome = await runChatCommand(h.channel("stop", { contactId: () => null }), h.deps);

    expect(outcome).toEqual({ decision: "denied", code: "unknown_user" });
    expect(h.replies).toEqual([{ kind: "unknown_actor" }]);
    expect(h.calls.interrupt).toBe(0);
  });

  it("says why when no session answers in the chat", async () => {
    const none = harness();
    expect(
      await runChatCommand(none.channel("status", { resolveSession: () => ({ kind: "no_route" }) }), none.deps),
    ).toEqual({
      decision: "info",
      code: "no_route",
    });
    const conflict = harness();
    expect(
      await runChatCommand(
        conflict.channel("status", { resolveSession: () => ({ kind: "route_conflict" }) }),
        conflict.deps,
      ),
    ).toEqual({ decision: "error", code: "route_conflict" });
    const missing = harness();
    const outcome = await runChatCommand(
      missing.channel("status", {
        resolveSession: () => ({ kind: "session_missing", agentId: "main", sessionKey: "agent:main:main" }),
      }),
      missing.deps,
    );
    expect(outcome).toEqual({ decision: "info", code: "session_missing" });
    expect(missing.replies).toEqual([{ kind: "session_missing", agentId: "main" }]);
  });
});

describe("freshness", () => {
  it("never runs a command that arrived minutes ago, or from the future", async () => {
    for (const receivedAt of [NOW - CHAT_COMMAND_MAX_AGE_MS - 1, NOW + CHAT_COMMAND_MAX_AGE_MS + 1]) {
      const h = harness();

      const outcome = await runChatCommand(h.channel("stop", { receivedAt }), h.deps);

      expect(outcome).toEqual({ decision: "denied", code: "stale" });
      expect(h.replies).toEqual([{ kind: "stale" }]);
      expect(h.calls.interrupt).toBe(0);
    }
  });

  it("checks again after the access metadata loads, right before anything changes", async () => {
    let clock = NOW;
    const h = harness({
      deps: {
        now: () => clock,
        inheritedAccess: async () => {
          clock += CHAT_COMMAND_MAX_AGE_MS + 1;
          return {
            group: "sessions.runtime",
            command: "interrupt",
            access: { kind: "mutate", resource: "sessions", action: "interrupt", risk: "medium" },
          };
        },
      },
    });

    expect(await runChatCommand(h.channel("stop"), h.deps)).toEqual({ decision: "denied", code: "stale" });
    expect(h.calls.interrupt).toBe(0);
  });
});

describe("operations", () => {
  it("status says who answers, with what, since when, and how many threads", async () => {
    const h = harness({
      threads: [thread(), thread({ requestId: "req-2" })],
      deps: { activeTurn: () => ({ turnId: "t", startedAt: NOW - 5 * 60_000 }) },
    });

    expect(await runChatCommand(h.channel("status"), h.deps)).toEqual({ decision: "allowed", code: "ok" });
    expect(h.replies).toEqual([
      {
        kind: "status",
        agentId: "main",
        sessionName: "main",
        runtime: "claude · opus · xhigh",
        workingForMs: 5 * 60_000,
        openThreads: 2,
      },
    ]);
  });

  it("lists the newest threads as facts and counts the rest", async () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      thread({ requestId: `req-${index}`, childSessionName: `t-${index}`, updatedAt: NOW - (100 + index) * HOUR }),
    );
    const h = harness({ threads: many });

    await runChatCommand(h.channel("threads"), h.deps);

    const [reply] = h.replies;
    expect(reply).toMatchObject({ kind: "threads", sessionName: "main", total: 15, more: 3 });
    expect(reply?.kind === "threads" && reply.rows).toHaveLength(12);
    expect(reply?.kind === "threads" && reply.rows[0]).toEqual({
      name: "t-0",
      title: "Study",
      ageMs: 100 * HOUR,
      busy: false,
      health: null,
      openDecisionCount: 0,
      returnPending: false,
      sessionGone: false,
    });
  });

  it("closes one thread and tells a refusal, a missing thread and a repeat apart", async () => {
    const closed = harness();
    expect(await runChatCommand(closed.channel("close main-t-1"), closed.deps)).toEqual({
      decision: "allowed",
      code: "ok",
    });
    expect(closed.replies).toEqual([{ kind: "thread_closed", name: "main-t-1", changed: true }]);

    const again = harness({ close: (ref) => ({ kind: "closed", name: ref, changed: false }) });
    expect(await runChatCommand(again.channel("close main-t-1"), again.deps)).toEqual({
      decision: "allowed",
      code: "already_closed",
    });

    const missing = harness({ close: () => ({ kind: "not_found" }) });
    expect(await runChatCommand(missing.channel("close nope"), missing.deps)).toEqual({
      decision: "info",
      code: "thread_not_found",
    });
    expect(missing.replies).toEqual([{ kind: "thread_not_found", ref: "nope", sessionName: "main" }]);

    const refused = harness({
      close: (ref) => ({ kind: "refused", name: ref, code: "THREAD_TRIGGERS_PENDING", message: "x" }),
    });
    expect(await runChatCommand(refused.channel("close main-t-1"), refused.deps)).toEqual({
      decision: "error",
      code: "THREAD_TRIGGERS_PENDING",
    });
  });

  it("closes idle threads only: not the busy one, not the recently active one, not one waiting on someone", async () => {
    const h = harness({
      threads: [
        thread({ requestId: "old", updatedAt: NOW - 100 * HOUR }),
        thread({ requestId: "busy", updatedAt: NOW - 90 * HOUR, turnHealth: { state: "running", lastSignalAt: null } }),
        thread({ requestId: "asking", updatedAt: NOW - 80 * HOUR, openDecisionCount: 1 }),
        thread({ requestId: "fresh", updatedAt: NOW - 1 * HOUR }),
      ],
    });

    expect(await runChatCommand(h.channel("close idle"), h.deps)).toEqual({ decision: "allowed", code: "ok" });

    expect(h.calls.close).toEqual([["agent:main:main", "old"]]);
    expect(h.replies).toEqual([
      { kind: "idle_closed", sessionName: "main", hours: 12, closed: 1, refused: [], active: 1, left: 0 },
    ]);
  });

  it("does not let refusals hide the threads behind them, and says when nothing closed", async () => {
    const refusing = Array.from({ length: 30 }, (_, index) =>
      thread({ requestId: `r-${index}`, updatedAt: NOW - (200 + index) * HOUR }),
    );
    const h = harness({
      threads: [...refusing, thread({ requestId: "ok", updatedAt: NOW - 20 * HOUR })],
      close: (ref) =>
        ref === "ok"
          ? { kind: "closed", name: ref, changed: true }
          : { kind: "refused", name: ref, code: "THREAD_DECISIONS_PENDING", message: "x" },
    });

    await runChatCommand(h.channel("close idle"), h.deps);

    expect(h.replies).toEqual([
      {
        kind: "idle_closed",
        sessionName: "main",
        hours: 12,
        closed: 1,
        refused: [{ code: "THREAD_DECISIONS_PENDING", count: 30 }],
        active: 0,
        left: 0,
      },
    ]);
  });

  it("says nothing was idle when no thread is old enough", async () => {
    const h = harness({ threads: [thread({ updatedAt: NOW - 1 * HOUR })] });

    expect(await runChatCommand(h.channel("close idle"), h.deps)).toEqual({ decision: "allowed", code: "none_idle" });
    expect(h.replies).toEqual([{ kind: "idle_none", sessionName: "main", hours: 12, active: 0 }]);
  });

  it("stops a turn and tells every way that can end apart", async () => {
    const cases: Array<[RuntimeControlResult | Error, ChatCommandResult, { decision: string; code: string }]> = [
      [
        { ok: true, operation: "turn.interrupt" },
        { kind: "stopped", sessionName: "main" },
        { decision: "allowed", code: "ok" },
      ],
      [
        { ok: false, operation: "turn.interrupt", code: RUNTIME_NO_ACTIVE_TURN } as RuntimeControlResult,
        { kind: "nothing_running", sessionName: "main" },
        { decision: "info", code: "nothing_running" },
      ],
      [
        { ok: false, operation: "turn.interrupt", code: RUNTIME_SESSION_NOT_ACTIVE } as RuntimeControlResult,
        { kind: "session_not_active", sessionName: "main" },
        { decision: "info", code: "session_not_active" },
      ],
      [
        { ok: false, operation: "turn.interrupt", code: RUNTIME_OPERATION_UNSUPPORTED } as RuntimeControlResult,
        { kind: "stop_failed", code: RUNTIME_OPERATION_UNSUPPORTED },
        { decision: "error", code: RUNTIME_OPERATION_UNSUPPORTED },
      ],
      [
        new Error("Request timeout after 10000ms"),
        { kind: "stop_timeout" },
        { decision: "error", code: "runtime_timeout" },
      ],
      [
        new Error("connection refused"),
        { kind: "stop_unreachable" },
        { decision: "error", code: "runtime_unavailable" },
      ],
    ];
    for (const [answer, expectedReply, expectedOutcome] of cases) {
      const h = harness({
        deps: {
          interrupt: async () => {
            if (answer instanceof Error) throw answer;
            return answer;
          },
        },
      });

      expect(await runChatCommand(h.channel("stop"), h.deps)).toEqual(expectedOutcome as never);
      expect(h.replies).toEqual([expectedReply]);
    }
  });
});

describe("a channel with no threads", () => {
  it("says so instead of pretending there are none", async () => {
    for (const text of ["threads", "close main-t-1", "close idle"]) {
      const h = harness();

      const outcome = await runChatCommand(h.channel(text, { threads: undefined, closeThread: undefined }), h.deps);

      expect(outcome).toEqual({ decision: "info", code: "threads_unsupported" });
      expect(h.replies).toEqual([{ kind: "threads_unsupported" }]);
    }
  });

  it("still tells status, without a thread count", async () => {
    const h = harness();

    await runChatCommand(h.channel("status", { threads: undefined, closeThread: undefined }), h.deps);

    expect(h.replies[0]).toMatchObject({ kind: "status", openThreads: null });
  });
});

describe("the audit", () => {
  it("records every command, refused ones included, with the channel as a value and never the text typed", async () => {
    const refused = harness({ capabilities: NOBODY });
    await runChatCommand(refused.channel("close main-secret-thread"), refused.deps);
    const done = harness();
    await runChatCommand(done.channel("status"), done.deps);

    expect(refused.audits).toEqual([
      {
        type: "chat_command",
        at: NOW,
        channel: "testchat",
        accountId: "acct",
        instanceId: "inst",
        chatId: "room-1",
        actorId: "user-1",
        contactId: CONTACT,
        sessionKey: "agent:main:main",
        sessionName: "main",
        subcommand: "close",
        decision: "denied",
        code: "not_authorized_modify",
        requestId: "req-1",
      },
    ]);
    expect(JSON.stringify(refused.audits)).not.toContain("secret-thread");
    expect(done.audits).toMatchObject([{ subcommand: "status", decision: "allowed", code: "ok" }]);
  });

  it("answers and audits a failure anywhere in the flow, not only while running", async () => {
    const h = harness();

    const outcome = await runChatCommand(
      h.channel("status", {
        resolveSession: () => {
          throw new Error("router down");
        },
      }),
      h.deps,
    );

    expect(outcome).toEqual({ decision: "error", code: "failed" });
    expect(h.replies).toEqual([{ kind: "failed" }]);
    expect(h.audits).toMatchObject([{ decision: "error", code: "failed", subcommand: "status" }]);
  });

  it("is still audited when the channel cannot say the answer", async () => {
    const h = harness();

    const outcome = await runChatCommand(
      h.channel("status", {
        reply: async () => {
          throw new Error("handle exhausted");
        },
      }),
      h.deps,
    );

    expect(outcome).toEqual({ decision: "allowed", code: "ok" });
    expect(h.audits).toHaveLength(1);
  });
});

describe("architecture", () => {
  const specifiersOf = (source: string): string[] =>
    [...source.matchAll(/from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(
      (match) => match[1] ?? match[2] ?? "",
    );

  it("keeps every channel out of the engine: no channel name, no channel import", () => {
    // The matcher works: the engine imports plenty, multi-line imports included.
    expect(specifiersOf(readFileSync(join(import.meta.dir, "engine.ts"), "utf8")).length).toBeGreaterThan(10);

    for (const file of ["engine.ts", "parse.ts"]) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");

      expect(specifiersOf(source).filter((specifier) => /(^|\/)channels\//.test(specifier))).toEqual([]);
      expect(source).not.toMatch(/slack|whatsapp|telegram|discord|matrix/i);
    }
  });

  it("does not load a channel's own CLI command either: the transitive import is as much a tie as a direct one", () => {
    // `sessions` holds `close-thread`, the command that closes Slack threads, and imports Slack's thread code:
    // the channel declares that command's access (`closeAccess`), the engine never loads the class.
    const specifiers = specifiersOf(readFileSync(join(import.meta.dir, "engine.ts"), "utf8"));

    expect(specifiers).not.toContain("../cli/commands/sessions.js");
  });
});
