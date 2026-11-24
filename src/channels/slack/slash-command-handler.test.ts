import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CliCommandAccessInput } from "../../cli/command-access.js";
import { addContactTag, createContact, linkContactIdentity } from "../../contacts.js";
import {
  canonicalize,
  EXTERNAL_AUTHORITY_ASSERTION_SETTING,
  EXTERNAL_AUTHORITY_PUBKEY_SETTING,
  resetExternalAuthorityCacheForTests,
} from "../../permissions/external-authority-provider.js";
import { PERMISSION_PROVIDER_IDS_SETTING } from "../../permissions/provider-registry.js";
import { attachChatToSession, getOrCreateSession, matchRoute } from "../../router/index.js";
import {
  type ContextCapability,
  dbCreateAgent,
  dbGetAgent,
  dbSetSetting,
  dbUpsertChat,
} from "../../router/router-db.js";
import { createRuntimeBootEpoch, createRuntimeTurnAttempt } from "../../runtime/crash-recovery-store.js";
import type { RouterConfig, SessionEntry } from "../../router/types.js";
import { RUNTIME_NO_ACTIVE_TURN, RUNTIME_SESSION_NOT_ACTIVE } from "../../runtime/runtime-control-errors.js";
import type { RuntimeControlResult } from "../../runtime/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  formatSlackCommandAge,
  handleSlackCommand,
  resolveSlackCommandSession,
  SLACK_COMMAND_MAX_AGE_MS,
  SLACK_COMMAND_QUEUE_GROUP,
  type SlackCommandAudit,
  type SlackCommandDeps,
  slackCommandChannel,
  type SlackThreadIndex,
  startSlackCommandConsumer,
  stopSlackCommandConsumer,
} from "./slash-command-handler.js";
import { buildSlackCommandEvent, readSlackCommandPayload } from "./slash-commands.js";
import { registerInboundSlackThread } from "./thread-lifecycle-store.js";
import type { SlackThreadSummary } from "./thread-lifecycle.js";

const NOW = 1_800_000_000_000;
const ACCOUNT = "ravi-slack";
const INSTANCE = "slack-instance";
const CONTACT = "contact-ana";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-slack-command-handler-");
});

afterEach(async () => {
  stopSlackCommandConsumer();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function eventFor(text: string, overrides: { receivedAt?: number; channelId?: string; ackedWithHelp?: boolean } = {}) {
  const payload = readSlackCommandPayload({
    team_id: "T0TEAM",
    channel_id: overrides.channelId ?? "D0CHAT",
    user_id: "U0PERSON",
    command: "/ravi",
    text,
    api_app_id: "A0APP",
    response_url: "https://hooks.slack.com/commands/T0TEAM/1/secret",
  })!;
  return buildSlackCommandEvent({
    payload,
    accountId: ACCOUNT,
    routeAccountId: ACCOUNT,
    instanceId: INSTANCE,
    envelopeId: "env-1",
    responseUrlId: "handle-1",
    ackedWithHelp: overrides.ackedWithHelp ?? false,
    receivedAt: overrides.receivedAt ?? NOW,
  });
}

function session(name = "main", key = "agent:main:main"): SessionEntry {
  return { sessionKey: key, name, agentId: "main", agentCwd: "/tmp/main", createdAt: 1, updatedAt: 1 } as SessionEntry;
}

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId, source: "test" } as ContextCapability;
}

const OWNER: ContextCapability[] = [cap("admin", "system", "*")];
const READER: ContextCapability[] = [cap("access", "session", "main")];
const CONTROLLER: ContextCapability[] = [cap("access", "session", "main"), cap("modify", "session", "main")];

function thread(overrides: Partial<SlackThreadSummary> = {}): SlackThreadSummary {
  return {
    turnHealth: null,
    requestId: "req-1",
    title: "Slack study",
    status: "open",
    source: "agent",
    childSessionKey: "agent:main:main:thread:1.1",
    childSessionName: "main-t-1",
    childSessionMissing: false,
    openDecisionCount: 0,
    pendingAnswerCount: 0,
    uncertainAnswerCount: 0,
    slackThreadTs: "1.1",
    link: null,
    runtime: {} as SlackThreadSummary["runtime"],
    createdAt: NOW - 100 * 3_600_000,
    updatedAt: NOW - 100 * 3_600_000,
    closedAt: null,
    parentReturn: { requested: false, pending: false },
    ...overrides,
  } as SlackThreadSummary;
}

function threadIndex(threads: SlackThreadSummary[], parentSessionKey = "agent:main:main"): SlackThreadIndex {
  return {
    parentSessionKey,
    parentSessionName: "main",
    count: () => threads.length,
    newest: (limit) => [...threads].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit),
    touchedBefore: (cutoff) =>
      threads
        .filter((entry) => entry.status === "open" && entry.updatedAt <= cutoff)
        .sort((a, b) => a.updatedAt - b.updatedAt),
  };
}

interface Harness {
  deps: SlackCommandDeps;
  replies: Array<Record<string, unknown>>;
  audits: SlackCommandAudit[];
  calls: { list: number; close: Array<[string, string]>; interrupt: number; access: CliCommandAccessInput[] };
}

function harness(overrides: Partial<SlackCommandDeps> & { capabilities?: ContextCapability[] } = {}): Harness {
  const replies: Array<Record<string, unknown>> = [];
  const audits: SlackCommandAudit[] = [];
  const calls: Harness["calls"] = { list: 0, close: [], interrupt: 0, access: [] };
  const { capabilities = OWNER, ...rest } = overrides;
  const deps: SlackCommandDeps = {
    now: () => NOW,
    routerConfig: () => ({}) as RouterConfig,
    respond: async ({ payload }) => {
      replies.push(payload);
    },
    contactForSlackUser: () => CONTACT,
    resolveSession: () => ({ kind: "session", session: session(), agentId: "main" }),
    capabilitiesFor: () => capabilities,
    inheritedAccess: async (operation) => ({
      group: operation === "interrupt" ? "sessions.runtime" : "sessions",
      command: operation,
      access: { kind: "mutate", resource: "sessions", action: operation, risk: "medium" },
    }),
    commandAccess: (input) => {
      calls.access.push(input);
      return { allowed: true, errorMessage: "", attempted: [] };
    },
    threads: () => {
      calls.list += 1;
      return threadIndex([]);
    },
    // Without a runtime to ask: a thread is busy when its health sample says so, and last active when its lifecycle did.
    activity: (summary) => ({ busy: summary.turnHealth?.state === "running", lastActivityAt: summary.updatedAt }),
    closeThread: async (parent, ref) => {
      calls.close.push([parent, ref]);
      return { kind: "closed", name: ref, changed: true };
    },
    activeTurn: () => null,
    describeRuntime: () => "claude · opus · xhigh",
    interrupt: async () => {
      calls.interrupt += 1;
      return { ok: true, operation: "turn.interrupt" };
    },
    audit: (entry) => {
      audits.push(entry);
    },
    ...rest,
  };
  return { deps, replies, audits, calls };
}

function text(reply: Record<string, unknown> | undefined): string {
  return String(reply?.text ?? "");
}

describe("who may run a command", () => {
  it("refuses a Slack user who is no contact, and runs nothing", async () => {
    const h = harness({ contactForSlackUser: () => null });

    const outcome = await handleSlackCommand(eventFor("close main-t-1"), h.deps);

    expect(outcome).toEqual({ decision: "denied", code: "unknown_user" });
    expect(text(h.replies[0])).toContain("I don't recognize you");
    expect(h.replies[0]?.response_type).toBe("ephemeral");
    expect(h.calls.close).toEqual([]);
    expect(h.calls.interrupt).toBe(0);
    expect(h.calls.list).toBe(0);
    expect(h.audits).toMatchObject([
      { decision: "denied", code: "unknown_user", contactId: null, subcommand: "close" },
    ]);
  });

  it("refuses a contact with no access to the session of this chat", async () => {
    const h = harness({ capabilities: [] });

    const outcome = await handleSlackCommand(eventFor("threads"), h.deps);

    expect(outcome).toEqual({ decision: "denied", code: "not_authorized_access" });
    expect(text(h.replies[0])).toContain("do not have access to session `main`");
    expect(h.calls.list).toBe(0);
  });

  it("does not let access to another session stand in for this one", async () => {
    const h = harness({ capabilities: [cap("access", "session", "other")] });

    expect(await handleSlackCommand(eventFor("status"), h.deps)).toEqual({
      decision: "denied",
      code: "not_authorized_access",
    });
  });

  it("lets a reader read but not change: close and stop need to modify the session", async () => {
    const h = harness({ capabilities: READER });

    expect(await handleSlackCommand(eventFor("status"), h.deps)).toMatchObject({ code: "ok" });
    expect(await handleSlackCommand(eventFor("close main-t-1"), h.deps)).toEqual({
      decision: "denied",
      code: "not_authorized_modify",
    });
    expect(await handleSlackCommand(eventFor("stop"), h.deps)).toEqual({
      decision: "denied",
      code: "not_authorized_modify",
    });
    expect(h.calls.close).toEqual([]);
    expect(h.calls.interrupt).toBe(0);
  });

  it("asks the CLI's own question too: modifying the session is not holding the command", async () => {
    const h = harness({
      capabilities: CONTROLLER,
      commandAccess: (input) => {
        h.calls.access.push(input);
        return {
          allowed: false,
          errorMessage: "denied",
          attempted: [],
          denialDetails: { stage: "command_access", capability: "mutate:sessions:close-thread" },
        };
      },
    });

    const outcome = await handleSlackCommand(eventFor("close main-t-1"), h.deps);

    expect(outcome).toEqual({ decision: "denied", code: "not_authorized_command" });
    expect(text(h.replies[0])).toContain("missing `mutate:sessions:close-thread`");
    expect(h.calls.close).toEqual([]);
    // As the contact, never as the agent or the local operator.
    expect(h.calls.access).toMatchObject([
      {
        source: "channel-command",
        subject: { type: "contact", id: CONTACT },
        group: "sessions",
        command: "close-thread",
      },
    ]);
  });

  it("refuses when the CLI's declared access cannot be read, rather than guessing", async () => {
    const h = harness({ inheritedAccess: async () => undefined });

    expect(await handleSlackCommand(eventFor("stop"), h.deps)).toEqual({
      decision: "error",
      code: "access_metadata_missing",
    });
    expect(h.calls.interrupt).toBe(0);
  });

  it("lets the owner do all of it", async () => {
    const h = harness({ capabilities: OWNER });

    for (const line of ["status", "threads", "close main-t-1", "stop"]) {
      expect((await handleSlackCommand(eventFor(line), h.deps))?.decision).toMatch(/allowed|info/);
    }
    expect(h.calls.close).toEqual([["agent:main:main", "main-t-1"]]);
    expect(h.calls.interrupt).toBe(1);
  });
});

describe("a command is never replayed or kept", () => {
  it("does not run one that went stale, and says so", async () => {
    const h = harness();

    const outcome = await handleSlackCommand(
      eventFor("stop", { receivedAt: NOW - SLACK_COMMAND_MAX_AGE_MS - 1 }),
      h.deps,
    );

    expect(outcome).toEqual({ decision: "denied", code: "stale" });
    expect(text(h.replies[0])).toContain("*not run*");
    expect(h.calls.interrupt).toBe(0);
  });

  it("does not trust a timestamp from the future either", async () => {
    const h = harness();

    const outcome = await handleSlackCommand(
      eventFor("stop", { receivedAt: NOW + SLACK_COMMAND_MAX_AGE_MS + 1 }),
      h.deps,
    );

    expect(outcome).toEqual({ decision: "denied", code: "stale" });
    expect(h.calls.interrupt).toBe(0);
  });

  it("ignores what is not a Slack command", async () => {
    const h = harness();

    expect(await handleSlackCommand({ provider: "discord" }, h.deps)).toBeNull();
    expect(await handleSlackCommand(null, h.deps)).toBeNull();
    expect(h.replies).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("never opens an agent turn: nothing in the handler or the engine publishes a prompt", () => {
    for (const file of ["slash-command-handler.ts", "../../chat-commands/engine.ts"]) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");

      expect(source).not.toMatch(/publishSessionPrompt|publishChannelSessionPrompt|session-stream|PromptPublisher/);
    }
  });

  it("keeps the audit free of the text typed, the URL and the token", async () => {
    const h = harness();

    await handleSlackCommand(eventFor("close main-t-1"), h.deps);

    const wire = JSON.stringify(h.audits);
    expect(wire).not.toContain("hooks.slack.com");
    expect(wire).not.toContain("secret");
    expect(wire).not.toContain("main-t-1");
    // The audit row is the engine's, channel-neutral: the channel is a value the Slack adapter supplies.
    expect(h.audits[0]).toMatchObject({
      type: "chat_command",
      channel: "slack",
      chatId: "D0CHAT",
      actorId: "U0PERSON",
      contactId: CONTACT,
      sessionName: "main",
      subcommand: "close",
      decision: "allowed",
      code: "ok",
      requestId: "env-1",
    });
  });

  it("survives a Slack that will not take the answer", async () => {
    const h = harness({
      respond: async () => {
        throw new Error("Slack interaction response handle exhausted");
      },
    });

    expect(await handleSlackCommand(eventFor("status"), h.deps)).toMatchObject({ code: "ok" });
  });
});

describe("static answers", () => {
  it("says nothing more when the runner already put the help in the ack", async () => {
    const h = harness();

    const outcome = await handleSlackCommand(eventFor("", { ackedWithHelp: true }), h.deps);

    expect(outcome).toEqual({ decision: "info", code: "help" });
    expect(h.replies).toEqual([]);
    expect(h.audits[0]).toMatchObject({ subcommand: "help", code: "help" });
  });

  it("says it itself when Slack would take nothing in the ack", async () => {
    const h = harness();

    await handleSlackCommand(eventFor("xyz", { ackedWithHelp: false }), h.deps);

    expect(text(h.replies[0])).toContain("I don't know `xyz`");
  });

  it("needs no authority to read the help", async () => {
    const h = harness({ contactForSlackUser: () => null });

    expect(await handleSlackCommand(eventFor("help"), h.deps)).toEqual({ decision: "info", code: "help" });
  });
});

describe("what each command does", () => {
  it("status: who answers, with what model, working or not, and the open threads", async () => {
    const h = harness({
      threads: () => threadIndex([thread(), thread({ requestId: "req-2" })]),
      activeTurn: () => ({ turnId: "turn-1", startedAt: NOW - 3 * 60_000 }),
    });

    await handleSlackCommand(eventFor("status"), h.deps);

    const reply = text(h.replies[0]);
    expect(reply).toContain("agent `main`");
    expect(reply).toContain("session `main`");
    expect(reply).toContain("claude · opus · xhigh");
    expect(reply).toContain("working for 3 min");
    expect(reply).toContain("*Open threads*: 2");
  });

  it("status: idle when no turn is running", async () => {
    const h = harness();

    await handleSlackCommand(eventFor("status"), h.deps);

    expect(text(h.replies[0])).toContain("*Now*: idle");
  });

  it("status <thread>: that thread's own state, its age, and what waits on someone", async () => {
    const h = harness({
      findThread: (parent, ref) => {
        expect([parent, ref]).toEqual(["agent:main:main", "1795189835.360089"]);
        return thread({
          title: "A <b>study</b>",
          openDecisionCount: 2,
          pendingAnswerCount: 1,
          updatedAt: NOW - 25 * 60_000,
        });
      },
    });

    const outcome = await handleSlackCommand(eventFor("status 1795189835.360089"), h.deps);

    expect(outcome).toEqual({ decision: "allowed", code: "ok" });
    const reply = text(h.replies[0]);
    expect(reply).toContain("*Thread* `main-t-1` A &lt;b&gt;study&lt;/b&gt;");
    expect(reply).toContain("*State*: idle, 2 open questions");
    expect(reply).toContain("*Last activity*: 25 min ago");
    expect(reply).toContain("*Answers not delivered yet*: 1");
  });

  it("status <thread>: says a closed thread is closed, and a missing one is missing", async () => {
    const closed = harness({ findThread: () => thread({ status: "closed" }) });
    await handleSlackCommand(eventFor("status main-t-1"), closed.deps);
    expect(text(closed.replies[0])).toContain("*State*: closed");

    const missing = harness({ findThread: () => null });
    expect(await handleSlackCommand(eventFor("status nope"), missing.deps)).toEqual({
      decision: "info",
      code: "thread_not_found",
    });
    expect(text(missing.replies[0])).toContain("I could not find thread `nope`");
  });

  it("threads: lists them newest first, with age and state, and cuts a long list", async () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      thread({
        requestId: `req-${index}`,
        childSessionName: `main-t-${index}`,
        title: index === 0 ? "A <b>bold</b> & title" : `Thread ${index}`,
        updatedAt: NOW - (index + 1) * 3_600_000,
        turnHealth: index === 0 ? ({ state: "running" } as SlackThreadSummary["turnHealth"]) : null,
        openDecisionCount: index === 1 ? 2 : 0,
      }),
    );
    const h = harness({
      threads: () => threadIndex(many),
    });

    await handleSlackCommand(eventFor("threads"), h.deps);

    const reply = text(h.replies[0]);
    expect(reply).toContain("(15)");
    expect(reply.indexOf("main-t-0")).toBeLessThan(reply.indexOf("main-t-1"));
    expect(reply).toContain("1 h; working");
    expect(reply).toContain("2 open questions");
    expect(reply).toContain("A &lt;b&gt;bold&lt;/b&gt; &amp; title");
    expect(reply).toContain("… and 3 more");
    expect(reply).not.toContain("main-t-14");
  });

  it("threads: says so when there is none", async () => {
    const h = harness();

    await handleSlackCommand(eventFor("threads"), h.deps);

    expect(text(h.replies[0])).toContain("No open threads");
  });

  it("close: closes the named thread under this chat's session", async () => {
    const h = harness();

    const outcome = await handleSlackCommand(eventFor("close main-t-9"), h.deps);

    expect(outcome).toEqual({ decision: "allowed", code: "ok" });
    expect(h.calls.close).toEqual([["agent:main:main", "main-t-9"]]);
    expect(text(h.replies[0])).toContain("Closed thread `main-t-9`");
  });

  it("close: says when it was already closed, and when there is no such thread", async () => {
    const h = harness({
      closeThread: async (_parent, ref) =>
        ref === "gone" ? { kind: "not_found" } : { kind: "closed", name: ref, changed: false },
    });

    expect(await handleSlackCommand(eventFor("close done"), h.deps)).toEqual({
      decision: "allowed",
      code: "already_closed",
    });
    expect(text(h.replies[0])).toContain("was already closed");
    expect(await handleSlackCommand(eventFor("close gone"), h.deps)).toEqual({
      decision: "info",
      code: "thread_not_found",
    });
    expect(text(h.replies[1])).toContain("could not find thread `gone`");
    expect(text(h.replies[1])).toContain("/ravi threads");
  });

  it("close: shows the triggers that hold the thread open, and the way out", async () => {
    const h = harness({
      closeThread: async () => ({
        kind: "refused",
        name: "main-t-9",
        code: "THREAD_TRIGGERS_PENDING",
        message: "Thread still receives active triggers: trg_1, trg_2.",
      }),
    });

    const outcome = await handleSlackCommand(eventFor("close main-t-9"), h.deps);

    expect(outcome).toEqual({ decision: "error", code: "THREAD_TRIGGERS_PENDING" });
    const reply = text(h.replies[0]);
    expect(reply).toContain("still receives active triggers (`trg_1`, `trg_2`)");
    expect(reply).toContain("ravi triggers set <id> replySession");
  });

  it("close: explains the other refusals instead of a bare code", async () => {
    const refused = (code: string) =>
      harness({ closeThread: async () => ({ kind: "refused", name: "t", code, message: code }) });

    const decisions = refused("THREAD_DECISIONS_PENDING");
    await handleSlackCommand(eventFor("close t"), decisions.deps);
    expect(text(decisions.replies[0])).toContain("open question");

    const returning = refused("THREAD_PARENT_RETURN_PENDING");
    await handleSlackCommand(eventFor("close t"), returning.deps);
    expect(text(returning.replies[0])).toContain("previous return");

    const other = refused("THREAD_NOT_STARTED");
    await handleSlackCommand(eventFor("close t"), other.deps);
    expect(text(other.replies[0])).toContain("`THREAD_NOT_STARTED`");
  });

  it("close idle: closes only what has been quiet that long, with nothing waiting on anyone", async () => {
    const threads = [
      thread({ requestId: "old", childSessionName: "main-t-old", updatedAt: NOW - 30 * 3_600_000 }),
      thread({ requestId: "fresh", childSessionName: "main-t-fresh", updatedAt: NOW - 1 * 3_600_000 }),
      thread({
        requestId: "busy",
        updatedAt: NOW - 30 * 3_600_000,
        turnHealth: { state: "running" } as SlackThreadSummary["turnHealth"],
      }),
      thread({ requestId: "asking", updatedAt: NOW - 30 * 3_600_000, openDecisionCount: 1 }),
      thread({ requestId: "answering", updatedAt: NOW - 30 * 3_600_000, pendingAnswerCount: 1 }),
      thread({
        requestId: "returning",
        updatedAt: NOW - 30 * 3_600_000,
        parentReturn: { requested: true, pending: true },
      }),
      thread({ requestId: "closed", updatedAt: NOW - 30 * 3_600_000, status: "closed" }),
    ];
    const h = harness({
      threads: () => threadIndex(threads),
    });

    const outcome = await handleSlackCommand(eventFor("close idle 12h"), h.deps);

    expect(outcome).toEqual({ decision: "allowed", code: "ok" });
    expect(h.calls.close).toEqual([["agent:main:main", "old"]]);
    expect(text(h.replies[0])).toContain("Closed 1 thread idle for more than 12 h");
  });

  it("close idle: reports what refused, and closes at most 25 per call", async () => {
    const threads = Array.from({ length: 30 }, (_, index) =>
      thread({ requestId: `req-${index}`, updatedAt: NOW - (100 + index) * 3_600_000 }),
    );
    const h = harness({
      threads: () => threadIndex(threads),
      closeThread: async (_parent, ref) => {
        h.calls.close.push(["agent:main:main", ref]);
        return Number(ref.replace("req-", "")) % 10 === 0
          ? { kind: "refused", name: ref, code: "THREAD_TRIGGERS_PENDING", message: "x" }
          : { kind: "closed", name: ref, changed: true };
      },
    });

    await handleSlackCommand(eventFor("close idle"), h.deps);

    expect(h.calls.close).toHaveLength(27);
    const reply = text(h.replies[0]);
    expect(reply).toContain("Closed 25 threads");
    expect(reply).toContain("2 refused: `THREAD_TRIGGERS_PENDING`");
    expect(reply).toContain("3 more for the next round");
  });

  it("close idle: says when nothing is idle", async () => {
    const h = harness();

    expect(await handleSlackCommand(eventFor("close idle"), h.deps)).toEqual({
      decision: "allowed",
      code: "none_idle",
    });
    expect(text(h.replies[0])).toContain("No thread in `main` has been idle");
  });

  it("stop: interrupts the turn running in this chat's session", async () => {
    const h = harness();

    const outcome = await handleSlackCommand(eventFor("stop"), h.deps);

    expect(outcome).toEqual({ decision: "allowed", code: "ok" });
    expect(h.calls.interrupt).toBe(1);
    expect(text(h.replies[0])).toContain("Interrupted the turn");
    expect(text(h.replies[0])).toContain("The queue goes on");
  });

  it("stop: says nothing is running when nothing is", async () => {
    const result: RuntimeControlResult = { ok: false, operation: "turn.interrupt", code: RUNTIME_NO_ACTIVE_TURN };
    const h = harness({ interrupt: async () => result });

    expect(await handleSlackCommand(eventFor("stop"), h.deps)).toEqual({ decision: "info", code: "nothing_running" });
    expect(text(h.replies[0])).toContain("Nothing running in `main`");
  });

  it("stop: says when the session has no runtime here", async () => {
    const result: RuntimeControlResult = { ok: false, operation: "turn.interrupt", code: RUNTIME_SESSION_NOT_ACTIVE };
    const h = harness({ interrupt: async () => result });

    expect(await handleSlackCommand(eventFor("stop"), h.deps)).toEqual({
      decision: "info",
      code: "session_not_active",
    });
  });

  it("stop: does not claim to have stopped what it could not reach", async () => {
    const timedOut = harness({
      interrupt: async () => {
        throw new Error("Request timeout (10000ms) on ravi.session.runtime.control");
      },
    });
    expect(await handleSlackCommand(eventFor("stop"), timedOut.deps)).toEqual({
      decision: "error",
      code: "runtime_timeout",
    });
    expect(text(timedOut.replies[0])).toContain("do not know whether the turn stopped");

    const down = harness({
      interrupt: async () => {
        throw new Error("NATS is down");
      },
    });
    expect(await handleSlackCommand(eventFor("stop"), down.deps)).toEqual({
      decision: "error",
      code: "runtime_unavailable",
    });
    expect(text(down.replies[0])).toContain("Nothing was interrupted");
  });

  it("answers an unexpected failure with a retry, never with the error", async () => {
    const h = harness({
      threads: () => {
        throw new Error("SQLITE_BUSY: /secret/path");
      },
    });

    expect(await handleSlackCommand(eventFor("threads"), h.deps)).toEqual({ decision: "error", code: "failed" });
    expect(text(h.replies[0])).not.toContain("SQLITE");
    expect(text(h.replies[0])).not.toContain("/secret");
  });
});

describe("the chat a command was typed in", () => {
  const config = (): RouterConfig =>
    ({
      agents: {
        main: { id: "main", cwd: "/tmp/main" },
        "ravi-voice": { id: "ravi-voice", cwd: "/tmp/voice" },
      },
      routes: [
        { pattern: "U0PERSON", accountId: ACCOUNT, agent: "main", channel: "slack" },
        { pattern: "group:C0VOICE", accountId: ACCOUNT, agent: "ravi-voice", channel: "slack" },
      ],
      defaultAgent: "main",
      defaultDmScope: "main",
      accountAgents: {},
      instanceToAccount: {},
      instances: {},
    }) as unknown as RouterConfig;

  function seedSession(channelId: string, userId: string, agentId: string): SessionEntry {
    if (!dbGetAgent(agentId)) dbCreateAgent({ id: agentId, cwd: `/tmp/${agentId}` });
    const isDm = channelId.startsWith("D");
    const matched = matchRoute(config(), {
      phone: isDm ? userId : channelId,
      channel: "slack",
      accountId: ACCOUNT,
      isGroup: !isDm,
      groupId: isDm ? undefined : channelId,
      peerKind: isDm ? "dm" : "group",
    })!;
    return getOrCreateSession(matched.sessionKey, agentId, `/tmp/${agentId}`, { name: matched.sessionKey });
  }

  it("a DM resolves to the session of the agent its route names", () => {
    const seeded = seedSession("D0CHAT", "U0PERSON", "main");

    const resolved = resolveSlackCommandSession(eventFor("status", { channelId: "D0CHAT" }), config());

    expect(resolved).toMatchObject({ kind: "session", agentId: "main" });
    expect(resolved.kind === "session" && resolved.session.sessionKey).toBe(seeded.sessionKey);
  });

  it("a routed channel resolves to the agent of its route", () => {
    const seeded = seedSession("C0VOICE", "U0PERSON", "ravi-voice");

    const resolved = resolveSlackCommandSession(eventFor("status", { channelId: "C0VOICE" }), config());

    expect(resolved).toMatchObject({ kind: "session", agentId: "ravi-voice" });
    expect(resolved.kind === "session" && resolved.session.sessionKey).toBe(seeded.sessionKey);
  });

  it("a chat attached to another session answers from that session, not from the route", () => {
    seedSession("D0CHAT", "U0PERSON", "main");
    if (!dbGetAgent("ravi-voice")) dbCreateAgent({ id: "ravi-voice", cwd: "/tmp/voice" });
    const attached = getOrCreateSession("agent:ravi-voice:main", "ravi-voice", "/tmp/voice", { name: "voice-main" });
    const chat = dbUpsertChat({ channel: "slack", instanceId: INSTANCE, platformChatId: "D0CHAT", chatType: "dm" });
    attachChatToSession({ sessionKey: attached.sessionKey, chatId: chat.id, role: "primary", attachedByType: "user" });

    const resolved = resolveSlackCommandSession(eventFor("status", { channelId: "D0CHAT" }), config());

    expect(resolved).toMatchObject({ kind: "session", agentId: "ravi-voice" });
    expect(resolved.kind === "session" && resolved.session.sessionKey).toBe(attached.sessionKey);
  });

  it("a channel no route names answers nothing", () => {
    expect(resolveSlackCommandSession(eventFor("status", { channelId: "C0NOBODY" }), config())).toEqual({
      kind: "no_route",
    });
  });

  it("a routed chat nobody has spoken in has no session yet, and says which agent would answer", () => {
    if (!dbGetAgent("ravi-voice")) dbCreateAgent({ id: "ravi-voice", cwd: "/tmp/voice" });

    const resolved = resolveSlackCommandSession(eventFor("status", { channelId: "C0VOICE" }), config());

    expect(resolved).toMatchObject({ kind: "session_missing", agentId: "ravi-voice" });
  });

  it("tells the person when no agent answers, and when nobody has spoken yet", async () => {
    const none = harness({ resolveSession: () => ({ kind: "no_route" }) });
    expect(await handleSlackCommand(eventFor("status"), none.deps)).toEqual({ decision: "info", code: "no_route" });
    expect(text(none.replies[0])).toBe("No agent answers in this chat.");

    const missing = harness({
      resolveSession: () => ({ kind: "session_missing", agentId: "ravi-voice", sessionKey: "agent:ravi-voice:x" }),
    });
    expect(await handleSlackCommand(eventFor("status"), missing.deps)).toEqual({
      decision: "info",
      code: "session_missing",
    });
    expect(text(missing.replies[0])).toContain("`ravi-voice`");
  });
});

describe("the daemon consumer", () => {
  it("listens on its own queue group, so only one daemon answers each command", async () => {
    const subscribe = mock((..._args: unknown[]) => ({
      async *[Symbol.asyncIterator]() {},
      return: async () => undefined,
    }));

    await startSlackCommandConsumer({ subscribe } as never);

    expect(subscribe).toHaveBeenCalledWith("ravi.inbound.command", { queue: SLACK_COMMAND_QUEUE_GROUP });
    expect(SLACK_COMMAND_QUEUE_GROUP).toBe("ravi-slack-commands");
  });

  it("asks the runtime on the topic `sessions runtime` uses", () => {
    // The CLI and the runtime host spell this topic out; a drift would make `stop` ask nobody.
    const host = readFileSync(join(import.meta.dir, "../../runtime/host-subscriptions.ts"), "utf8");
    const cli = readFileSync(join(import.meta.dir, "../../cli/commands/sessions-runtime.ts"), "utf8");
    // The engine asks it, for every channel (src/chat-commands/engine.ts), not the Slack adapter.
    const engine = readFileSync(join(import.meta.dir, "../../chat-commands/engine.ts"), "utf8");

    expect(host).toContain('"ravi.session.runtime.control"');
    expect(cli).toContain('"ravi.session.runtime.control"');
    expect(engine).toContain('"ravi.session.runtime.control"');
  });
});

describe("formatSlackCommandAge", () => {
  it("reads like a person would say it", () => {
    expect(formatSlackCommandAge(5_000)).toBe("now");
    expect(formatSlackCommandAge(12 * 60_000)).toBe("12 min");
    expect(formatSlackCommandAge(3 * 3_600_000)).toBe("3 h");
    expect(formatSlackCommandAge(47 * 3_600_000)).toBe("47 h");
    expect(formatSlackCommandAge(72 * 3_600_000)).toBe("3 d");
  });
});

describe("with the real contacts, permissions and CLI access metadata", () => {
  function seedPerson(options: { owner: boolean }) {
    const contact = createContact({ phone: "5511900000001", name: "Ana", status: "allowed" });
    if (options.owner) addContactTag(contact.phone, "permission-owner");
    linkContactIdentity(contact.id, { channel: "slack", platformUserId: "U0PERSON", instanceId: INSTANCE });
    return contact;
  }

  // Only the effects are faked; who the person is and what they may do come from the real stores.
  function real(): Harness {
    return harness({
      contactForSlackUser: undefined,
      capabilitiesFor: undefined,
      commandAccess: undefined,
      inheritedAccess: undefined,
    });
  }

  it("lets the owner contact close a thread and stop a turn", async () => {
    seedPerson({ owner: true });
    const h = real();

    expect(await handleSlackCommand(eventFor("close main-t-1"), h.deps)).toEqual({ decision: "allowed", code: "ok" });
    expect(await handleSlackCommand(eventFor("stop"), h.deps)).toEqual({ decision: "allowed", code: "ok" });
    expect(h.calls.close).toEqual([["agent:main:main", "main-t-1"]]);
    expect(h.calls.interrupt).toBe(1);
    expect(h.audits.map((entry) => entry.contactId)).toEqual([expect.any(String), expect.any(String)]);
  });

  it("reads the command access the CLI declares for the operations it calls", async () => {
    const { getCommandAccessMetadata } = await import("../../cli/decorators.js");
    const { SessionCommands } = await import("../../cli/commands/sessions.js");
    const { SessionRuntimeCommands } = await import("../../cli/commands/sessions-runtime.js");

    expect(getCommandAccessMetadata(SessionCommands).get("closeThread")).toMatchObject({
      kind: "mutate",
      resource: "sessions",
      action: "close-thread",
    });
    expect(getCommandAccessMetadata(SessionRuntimeCommands).get("interrupt")).toMatchObject({
      kind: "mutate",
      resource: "sessions.runtime",
      action: "interrupt",
    });
  });

  it("refuses a contact who may modify the session but lacks the capability the CLI asks for the operation", async () => {
    seedPerson({ owner: false });
    // Modify on the session is granted; the CLI's own capability for each operation is not. Who the person
    // is, the command-level check and the access the CLI class declares are all the real ones, so asking a
    // weaker capability (a read `sessions list`) for `close` would let this contact through.
    const h = harness({
      capabilities: CONTROLLER,
      contactForSlackUser: undefined,
      commandAccess: undefined,
      inheritedAccess: undefined,
    });

    expect(await handleSlackCommand(eventFor("close main-t-1"), h.deps)).toEqual({
      decision: "denied",
      code: "not_authorized_command",
    });
    expect(text(h.replies[0])).toContain("missing `mutate:sessions:close-thread`");
    expect(await handleSlackCommand(eventFor("stop"), h.deps)).toEqual({
      decision: "denied",
      code: "not_authorized_command",
    });
    expect(text(h.replies[1])).toContain("missing `mutate:sessions.runtime:interrupt`");
    expect(h.calls.close).toEqual([]);
    expect(h.calls.interrupt).toBe(0);
  });

  it("declares to the engine the mutating access the CLI declares for closing a thread", async () => {
    const channel = slackCommandChannel({
      accountId: ACCOUNT,
      instanceId: INSTANCE,
      routeAccountId: ACCOUNT,
      channelId: "D0CHAT",
      userId: "U0PERSON",
      text: "close main-t-1",
      receivedAt: NOW,
      command: "/ravi",
      surface: "command",
    });

    expect(await channel.closeAccess?.()).toMatchObject({
      group: "sessions",
      command: "close-thread",
      access: { kind: "mutate", resource: "sessions", action: "close-thread" },
    });
  });

  it("declares exactly what the CLI declares for closing a thread, not a look-alike (review N1 of #937)", async () => {
    const { getCommandAccessMetadata } = await import("../../cli/decorators.js");
    const { SessionCommands } = await import("../../cli/commands/sessions.js");
    const channel = slackCommandChannel({
      accountId: ACCOUNT,
      instanceId: INSTANCE,
      routeAccountId: ACCOUNT,
      channelId: "D0CHAT",
      userId: "U0PERSON",
      text: "close main-t-1",
      receivedAt: NOW,
      command: "/ravi",
      surface: "command",
    });

    const declared = await channel.closeAccess?.();

    // Field for field, so a weaker or different capability under the same kind cannot stand in for it.
    expect(declared?.access).toEqual(getCommandAccessMetadata(SessionCommands).get("closeThread"));
  });

  it("refuses a contact who holds nothing: not even the read", async () => {
    seedPerson({ owner: false });
    const h = real();

    expect(await handleSlackCommand(eventFor("status"), h.deps)).toEqual({
      decision: "denied",
      code: "not_authorized_access",
    });
    expect(await handleSlackCommand(eventFor("stop"), h.deps)).toEqual({
      decision: "denied",
      code: "not_authorized_modify",
    });
    expect(h.calls.interrupt).toBe(0);
    expect(h.calls.close).toEqual([]);
  });

  it("refuses a Slack user nobody linked to a contact", async () => {
    const h = real();

    expect(await handleSlackCommand(eventFor("stop"), h.deps)).toEqual({ decision: "denied", code: "unknown_user" });
    expect(h.calls.interrupt).toBe(0);
  });
});

describe("close idle decides from what the runtime says now, thread by thread", () => {
  function oldThread(requestId: string) {
    return thread({ requestId, childSessionName: requestId, updatedAt: NOW - 100 * 3_600_000 });
  }

  it("skips a thread restarted after it was listed: its health sample is stale", async () => {
    const h = harness({
      threads: () => threadIndex([oldThread("restarted")]),
      // The lifecycle is old and the sample says idle, but the runtime has a turn running right now.
      activity: () => ({ busy: true, lastActivityAt: NOW - 100 * 3_600_000 }),
    });

    const outcome = await handleSlackCommand(eventFor("close idle 12h"), h.deps);

    expect(outcome).toEqual({ decision: "allowed", code: "none_idle" });
    expect(h.calls.close).toEqual([]);
    expect(text(h.replies[0])).toContain("recent activity or work in progress");
  });

  it("skips a thread that finished new work minutes ago, whatever its lifecycle date says", async () => {
    const h = harness({
      threads: () => threadIndex([oldThread("just-finished")]),
      activity: () => ({ busy: false, lastActivityAt: NOW - 5 * 60_000 }),
    });

    expect(await handleSlackCommand(eventFor("close idle 12h"), h.deps)).toEqual({
      decision: "allowed",
      code: "none_idle",
    });
    expect(h.calls.close).toEqual([]);
  });

  it("closes the idle ones and says how many it left alone", async () => {
    const h = harness({
      threads: () => threadIndex([oldThread("idle"), oldThread("busy")]),
      activity: (summary) =>
        summary.requestId === "busy"
          ? { busy: true, lastActivityAt: NOW }
          : { busy: false, lastActivityAt: NOW - 100 * 3_600_000 },
    });

    await handleSlackCommand(eventFor("close idle 12h"), h.deps);

    expect(h.calls.close).toEqual([["agent:main:main", "idle"]]);
    expect(text(h.replies[0])).toContain("Closed 1 thread");
    expect(text(h.replies[0])).toContain("1 skipped: recent activity or work in progress");
  });

  it("shows how long a thread has been quiet by its activity, not by its lifecycle date", async () => {
    const h = harness({
      threads: () => threadIndex([oldThread("worked-recently")]),
      activity: () => ({ busy: false, lastActivityAt: NOW - 7 * 60_000 }),
    });

    await handleSlackCommand(eventFor("threads"), h.deps);

    expect(text(h.replies[0])).toContain("(7 min; idle)");
  });
});

describe("every thread of a session, from the real store", () => {
  const HOUR = 3_600_000;
  const PARENT_KEY = "agent:main:main";

  function register(index: number, seenAt: number, childKey = `agent:main:thread-${index}`) {
    return registerInboundSlackThread({
      requestId: `req-${index}`,
      parentSessionKey: PARENT_KEY,
      parentSessionName: "main",
      childSessionKey: childKey,
      childSessionName: `main-t-${index}`,
      accountId: ACCOUNT,
      instanceId: INSTANCE,
      platformChatId: "C0CHAN",
      threadCanonicalChatId: `chat-${index}`,
      providerThreadId: `${index}.1`,
      seenAt,
    });
  }

  // The real index and the real activity; only the effects are faked.
  function realThreads(real: number): Harness {
    return harness({ now: () => real, threads: undefined, activity: undefined });
  }

  it("counts them all and finds the old ones behind more newer threads than one page holds", async () => {
    const real = Date.now();
    for (let index = 0; index < 10; index += 1) register(index, real - 100 * HOUR);
    for (let index = 10; index < 260; index += 1) register(index, real - 1 * HOUR);
    const h = realThreads(real);

    await handleSlackCommand(eventFor("status", { receivedAt: real }), h.deps);
    await handleSlackCommand(eventFor("close idle 12h", { receivedAt: real }), h.deps);

    expect(text(h.replies[0])).toContain("*Open threads*: 260");
    expect(h.calls.close.map(([, ref]) => ref).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `req-${index}`).sort(),
    );
  });

  it("shows the newest page and says how many more there are", async () => {
    const real = Date.now();
    for (let index = 0; index < 20; index += 1) register(index, real - (100 - index) * HOUR);
    const h = realThreads(real);

    await handleSlackCommand(eventFor("threads", { receivedAt: real }), h.deps);

    const reply = text(h.replies[0]);
    expect(reply).toContain("(20)");
    expect(reply).toContain("main-t-19");
    expect(reply).not.toContain("main-t-0`");
    expect(reply).toContain("… and 8 more");
  });

  it("does not close a thread whose child session moved recently, though its lifecycle is old", async () => {
    const real = Date.now();
    register(1, real - 100 * HOUR, "agent:main:child-1");
    getOrCreateSession("agent:main:child-1", "main", "/tmp/main", { name: "child-1" });
    const h = realThreads(real);

    const outcome = await handleSlackCommand(eventFor("close idle 12h", { receivedAt: real }), h.deps);

    expect(outcome).toEqual({ decision: "allowed", code: "none_idle" });
    expect(h.calls.close).toEqual([]);
    expect(text(h.replies[0])).toContain("recent activity or work in progress");
  });

  it("does not close a thread with a turn running in the runtime, whatever its sample says", async () => {
    const real = Date.now();
    register(1, real - 100 * HOUR, "agent:main:child-2");
    const boot = createRuntimeBootEpoch({
      instanceId: "handler-test",
      pid: process.pid,
      startedAt: real - 100 * HOUR,
      lastHeartbeatAt: real - 100 * HOUR,
      leaseExpiresAt: real + 60_000,
    });
    createRuntimeTurnAttempt({
      turnId: "turn-child-2",
      runId: "run-child-2",
      sessionKey: "agent:main:child-2",
      sessionName: "child-2",
      agentId: "main",
      provider: "codex",
      model: "test",
      bootEpoch: boot.bootEpoch,
      startedAt: real - 100 * HOUR,
      lastHeartbeatAt: real - 100 * HOUR,
      leaseExpiresAt: real + 60_000,
      checkpoint: {},
      originKind: "human",
      deliveryBarrier: "after_tool",
    });
    const h = realThreads(real);

    await handleSlackCommand(eventFor("close idle 12h", { receivedAt: real }), h.deps);

    expect(h.calls.close).toEqual([]);
  });

  it("closes a thread with no sign of life since the cutoff", async () => {
    const real = Date.now();
    register(1, real - 100 * HOUR, "agent:main:child-3");
    const h = realThreads(real);

    await handleSlackCommand(eventFor("close idle 12h", { receivedAt: real }), h.deps);

    expect(h.calls.close).toEqual([[PARENT_KEY, "req-1"]]);
  });
});

describe("a configured external authority", () => {
  afterEach(() => resetExternalAuthorityCacheForTests());

  function configureExternalAuthority(subject: string, scope: Array<Record<string, unknown>>): void {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const payload = { iss: "issuer", sub: subject, exp: Math.floor(Date.now() / 1000) + 60, scope };
    const sig = signPayload(null, Buffer.from(canonicalize(payload)), privateKey).toString("base64");
    const assertionPath = join(stateDir!, "assertion.json");
    writeFileSync(assertionPath, JSON.stringify({ ...payload, sig }));
    dbSetSetting(PERMISSION_PROVIDER_IDS_SETTING, "context-capabilities,external-authority");
    dbSetSetting(EXTERNAL_AUTHORITY_ASSERTION_SETTING, assertionPath);
    dbSetSetting(EXTERNAL_AUTHORITY_PUBKEY_SETTING, publicKey.export({ type: "spki", format: "pem" }).toString());
    resetExternalAuthorityCacheForTests();
  }

  function seedOwner() {
    const contact = createContact({ phone: "5511900000001", name: "Ana", status: "allowed" });
    addContactTag(contact.phone, "permission-owner");
    linkContactIdentity(contact.id, { channel: "slack", platformUserId: "U0PERSON", instanceId: INSTANCE });
    return contact;
  }

  function real(): Harness {
    return harness({
      contactForSlackUser: undefined,
      capabilitiesFor: undefined,
      commandAccess: undefined,
      inheritedAccess: undefined,
    });
  }

  it("can refuse a read the contact's local grants would allow", async () => {
    const owner = seedOwner();
    // The authority speaks for this contact and covers only another session.
    configureExternalAuthority(`contact:${owner.id}`, [
      { permission: "access", objectType: "session", objectId: "other" },
    ]);
    const h = real();

    expect(await handleSlackCommand(eventFor("status"), h.deps)).toEqual({
      decision: "denied",
      code: "not_authorized_access",
    });
    expect(await handleSlackCommand(eventFor("threads"), h.deps)).toEqual({
      decision: "denied",
      code: "not_authorized_access",
    });
    expect(h.calls.list).toBe(0);
  });

  it("lets the read through when its scope covers the session", async () => {
    const owner = seedOwner();
    configureExternalAuthority(`contact:${owner.id}`, [
      { permission: "access", objectType: "session", objectId: "main" },
    ]);
    const h = real();

    expect(await handleSlackCommand(eventFor("status"), h.deps)).toEqual({ decision: "allowed", code: "ok" });
  });
});

describe("review round: conflicts, freshness, failures, batches and shutdown", () => {
  const HOUR = 3_600_000;

  it("refuses a chat whose route forces a session that belongs to another agent", () => {
    if (!dbGetAgent("main")) dbCreateAgent({ id: "main", cwd: "/tmp/main" });
    if (!dbGetAgent("ravi-voice")) dbCreateAgent({ id: "ravi-voice", cwd: "/tmp/voice" });
    getOrCreateSession("agent:ravi-voice:main", "ravi-voice", "/tmp/voice", { name: "voice-main" });
    const config = {
      agents: { main: { id: "main", cwd: "/tmp/main" }, "ravi-voice": { id: "ravi-voice", cwd: "/tmp/voice" } },
      // The route sends this DM to `main` but forces the session named voice-main, which is ravi-voice's.
      routes: [{ pattern: "U0PERSON", accountId: ACCOUNT, agent: "main", channel: "slack", session: "voice-main" }],
      defaultAgent: "main",
      defaultDmScope: "main",
      accountAgents: {},
      instanceToAccount: {},
      instances: {},
    } as unknown as RouterConfig;

    expect(resolveSlackCommandSession(eventFor("status", { channelId: "D0CHAT" }), config)).toEqual({
      kind: "route_conflict",
    });
  });

  it("tells the person about a conflicting route and runs nothing", async () => {
    const h = harness({ resolveSession: () => ({ kind: "route_conflict" }) });

    expect(await handleSlackCommand(eventFor("stop"), h.deps)).toEqual({ decision: "error", code: "route_conflict" });
    expect(text(h.replies[0])).toContain("forces a session that belongs to another agent");
    expect(h.calls.interrupt).toBe(0);
  });

  it("does not stop a turn whose command went stale while the access metadata loaded", async () => {
    let clock = NOW;
    const h = harness({
      now: () => clock,
      inheritedAccess: async (operation) => {
        // The first import of the CLI's access metadata took longer than the freshness window.
        clock += SLACK_COMMAND_MAX_AGE_MS + 1;
        return {
          group: "sessions.runtime",
          command: operation,
          access: { kind: "mutate", resource: "sessions", action: operation, risk: "medium" },
        };
      },
    });

    expect(await handleSlackCommand(eventFor("stop"), h.deps)).toEqual({ decision: "denied", code: "stale" });
    expect(h.calls.interrupt).toBe(0);
    expect(text(h.replies[0])).toContain("*not run*");
  });

  it("answers and audits a failure while resolving the session, not only while running", async () => {
    const h = harness({
      resolveSession: () => {
        throw new Error("database is locked: /Users/someone/.ravi/ravi.db");
      },
    });

    expect(await handleSlackCommand(eventFor("status"), h.deps)).toEqual({ decision: "error", code: "failed" });
    expect(text(h.replies[0])).toContain("I could not run that right now");
    expect(text(h.replies[0])).not.toContain("locked");
    expect(h.audits).toMatchObject([{ decision: "error", code: "failed", subcommand: "status" }]);
  });

  it("close idle: refusals do not use up the batch, so the threads behind them are reached", async () => {
    const threads = Array.from({ length: 30 }, (_, index) =>
      thread({ requestId: `req-${index}`, updatedAt: NOW - (200 - index) * HOUR }),
    );
    const h = harness({
      threads: () => threadIndex(threads),
      closeThread: async (_parent, ref) => {
        h.calls.close.push(["agent:main:main", ref]);
        return Number(ref.replace("req-", "")) < 28
          ? { kind: "refused", name: ref, code: "THREAD_TRIGGERS_PENDING", message: "x" }
          : { kind: "closed", name: ref, changed: true };
      },
    });

    await handleSlackCommand(eventFor("close idle"), h.deps);

    expect(h.calls.close).toHaveLength(30);
    expect(text(h.replies[0])).toContain("Closed 2 threads");
    expect(text(h.replies[0])).toContain("28 refused: `THREAD_TRIGGERS_PENDING`");
  });

  it("close idle: says that running it again will not help when every try was refused", async () => {
    const threads = Array.from({ length: 120 }, (_, index) =>
      thread({ requestId: `req-${index}`, updatedAt: NOW - (300 - index) * HOUR }),
    );
    const h = harness({
      threads: () => threadIndex(threads),
      closeThread: async (_parent, ref) => {
        h.calls.close.push(["agent:main:main", ref]);
        return { kind: "refused", name: ref, code: "THREAD_TRIGGERS_PENDING", message: "x" };
      },
    });

    await handleSlackCommand(eventFor("close idle"), h.deps);

    // Bounded: it does not walk all of them just to be refused by each.
    expect(h.calls.close).toHaveLength(100);
    const reply = text(h.replies[0]);
    expect(reply).toContain("Closed 0 threads");
    expect(reply).toContain("20 more not tried: nothing closed");
    expect(reply).not.toContain("run the command again");
  });

  it("close idle: does not count a thread another close had already closed", async () => {
    const h = harness({
      threads: () => threadIndex([thread({ requestId: "raced", updatedAt: NOW - 100 * HOUR })]),
      closeThread: async (_parent, ref) => ({ kind: "closed", name: ref, changed: false }),
    });

    await handleSlackCommand(eventFor("close idle"), h.deps);

    expect(text(h.replies[0])).toContain("Closed 0 threads");
  });

  it("waits for the command it is answering before it reports stopped", async () => {
    let release!: () => void;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let startedAnswering!: () => void;
    const answering = new Promise<void>((resolve) => {
      startedAnswering = resolve;
    });
    const h = harness({
      respond: async () => {
        startedAnswering();
        await answered;
      },
    });
    const stream = (async function* () {
      yield { topic: "ravi.inbound.command", data: eventFor("status") };
      await new Promise<never>(() => {});
    })();
    await startSlackCommandConsumer({ subscribe: () => stream } as never, h.deps);
    await answering;

    let stopped = false;
    const stopping = stopSlackCommandConsumer().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
    // The audit event of the command that was in flight was published before shutdown could close NATS.
    expect(h.audits).toHaveLength(1);
  });
});
