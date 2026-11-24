import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getOrCreateSession, resolveSession } from "../router/sessions.js";
import { createContact, deleteContact, setContactStatus } from "../contacts.js";
import { pickRuntimeTurnAuthorityEnvelope } from "../runtime/delivery-queue.js";
import { CRON_RUN_AUTHORITY_ENV } from "./authority.js";
import { accessActorFromTurn } from "../access/actor.js";
import { buildRuntimeRequestContext } from "../runtime/runtime-request-context.js";
import type { RuntimeLaunchPrompt } from "../runtime/message-types.js";
import type { OwnerDirectTarget } from "../knowledge/owner.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

afterAll(() => mock.restore());

const emittedEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
const subscribedTopics: string[] = [];
let publishError: Error | null = null;
let beforePublishAck: ((sessionName: string) => Promise<void>) | null = null;
let onPublish: (() => void) | null = null;

mock.module("../nats.js", () => ({
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: mock(() => false),
  publish: mock(async (topic: string, data: Record<string, unknown>) => {
    emittedEvents.push({ topic, data });
  }),
  subscribe: mock(async function* () {}),
  nats: {
    emit: mock(async (topic: string, data: Record<string, unknown>) => {
      emittedEvents.push({ topic, data });
    }),
    subscribe: mock((topic: string) => {
      subscribedTopics.push(topic);
      return (async function* () {})();
    }),
    close: mock(async () => {}),
  },
}));

mock.module("../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    if (publishError) throw publishError;
    publishCalls.push({ sessionName, payload });
    await beforePublishAck?.(sessionName);
    onPublish?.();
  }),
}));

// Who a direct message can reach, and what was sent: a notice goes out by direct message, with no model in the path.
const OPERATOR_CHAT: OwnerDirectTarget = {
  channel: "slack",
  accountId: "ops",
  to: "U_OPERATOR",
  chatId: "U_OPERATOR",
  contactId: "c_operator",
};
const BOB_CHAT: OwnerDirectTarget = {
  channel: "whatsapp",
  accountId: "main",
  to: "bob",
  chatId: "bob",
  contactId: "c_bob",
};
let operatorChat: OwnerDirectTarget | null = null;
const contactChats = new Map<string, OwnerDirectTarget>();
let directDeliveryFails = false;
let directDeliveryGate: Promise<void> | null = null;
const directMessages: Array<{ target: OwnerDirectTarget; text: string }> = [];
// Every chat a direct message was tried on, including the ones that failed.
const directAttempts: OwnerDirectTarget[] = [];

const actualOwnerModule = await import("../knowledge/owner.js");
const actualChatTargetModule = await import("../cloud-agents/chat-target.js");

// Only what a test armed is faked: with nothing armed these call through to the real ones, so the mocks
// are harmless to other files that share this process.
const actualResolveOwnerDirectTarget = actualOwnerModule.resolveOwnerDirectTarget;
const actualResolveOwnerDirectTargets = actualOwnerModule.resolveOwnerDirectTargets;
const actualDeliverToChat = actualChatTargetModule.deliverToChat;
const directChatsArmed = () => operatorChat !== null || contactChats.size > 0;

mock.module("../knowledge/owner.js", () => ({
  ...actualOwnerModule,
  // With a contact list: that contact's own chat. Without: the operator's.
  resolveOwnerDirectTarget: (deps?: Parameters<typeof actualResolveOwnerDirectTarget>[0]) => {
    if (!directChatsArmed()) return actualResolveOwnerDirectTarget(deps);
    const ids = deps?.listOwnerContactIds?.();
    return ids ? (contactChats.get(ids[0] ?? "") ?? null) : operatorChat;
  },
  resolveOwnerDirectTargets: (deps?: Parameters<typeof actualResolveOwnerDirectTarget>[0]) => {
    if (!directChatsArmed()) return actualResolveOwnerDirectTargets(deps);
    const ids = deps?.listOwnerContactIds?.();
    const chat = ids ? (contactChats.get(ids[0] ?? "") ?? null) : operatorChat;
    return chat ? [chat] : [];
  },
}));

mock.module("../cloud-agents/chat-target.js", () => ({
  ...actualChatTargetModule,
  deliverToChat: mock(async (target: OwnerDirectTarget, message: { text: string }, timeoutMs?: number) => {
    if (!directChatsArmed()) return actualDeliverToChat(target, message, timeoutMs);
    directAttempts.push(target);
    if (directDeliveryGate) await directDeliveryGate;
    if (directDeliveryFails) throw new Error("gateway offline");
    directMessages.push({ target, text: message.text });
    return { messageId: "m1", deliveries: [] };
  }),
}));

const { CronRunner } = await import("./runner.js");
const { resolveConnectorTurn } = await import("../link/connector-turn.js");
const { dbCreateCronJob, dbGetCronJob, dbMarkJobDispatched, dbUpdateJobState, dbUpdateCronJob } = await import(
  "./cron-db.js"
);
const { CRON_RUNTIME_EVENTS_TOPIC } = await import("./turn-outcome.js");
const { issueShellCronContext, CRON_SHELL_ALLOWED_COMMANDS, revokeOrphanedShellCronContexts } = await import(
  "./shell-context.js"
);
const { getRegistry } = await import("../cli/registry-snapshot.js");
const { createRuntimeContext } = await import("../runtime/context-registry.js");
const { dbListContexts } = await import("../router/router-db.js");

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-cron-runner-test-");
  emittedEvents.length = 0;
  publishCalls.length = 0;
  subscribedTopics.length = 0;
  publishError = null;
  beforePublishAck = null;
  onPublish = null;
  operatorChat = null;
  contactChats.clear();
  directDeliveryFails = false;
  directDeliveryGate = null;
  directMessages.length = 0;
  directAttempts.length = 0;
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  operatorChat = null;
  contactChats.clear();
  directDeliveryFails = false;
  stateDir = null;
});

async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createAgentJob(overrides: Partial<Parameters<typeof dbCreateCronJob>[0]> = {}) {
  return dbCreateCronJob({
    name: `attention-${Math.random().toString(36).slice(2, 8)}`,
    schedule: { type: "every", every: 60_000 },
    message: "check attention queue",
    agentId: "test-agent",
    sessionTarget: "isolated",
    ...overrides,
  });
}

/** A run that failed and has not been reported yet; returns its id. */
async function failedRun(overrides: Partial<Parameters<typeof dbCreateCronJob>[0]> = {}): Promise<string> {
  const { settleCronRun } = await import("./run-db.js");
  const job = createAgentJob(overrides);
  await new CronRunner().triggerJob(job.id);
  const dispatched = publishCalls.at(-1)!;
  const runId = String(dispatched.payload._cronRunId);
  settleCronRun(runId, dispatched.sessionName, { lastStatus: "error", lastError: "failed before report" });
  return runId;
}

/** The database refuses to mark reports as reported (one run, or all), as a busy or read-only one would. */
async function refuseMarks(runId?: string): Promise<void> {
  const { getDb } = await import("../router/router-db.js");
  const only = runId ? `WHEN NEW.id = '${runId}' ` : "";
  getDb().run(
    `CREATE TRIGGER refuse_marks BEFORE UPDATE OF reported ON cron_runs ${only}BEGIN SELECT RAISE(ABORT, 'database is busy'); END`,
  );
}

function cronProvenance(jobId: string, index?: number) {
  const payload =
    index === undefined
      ? [...publishCalls].reverse().find((call) => call.payload._jobId === jobId)?.payload
      : publishCalls[index]?.payload;
  return {
    origin: "cron",
    background: true,
    automationOriginated: true,
    automationId: `cron:${jobId}`,
    cronRunId: payload?._cronRunId,
    reason: "prompt._cron",
  };
}

function runtimeEvent(sessionName: string, data: Record<string, unknown>) {
  return { topic: `ravi.session.${sessionName}.runtime`, data };
}

describe("CronRunner admission authority", () => {
  function admit(index = 0, continuation = false) {
    const dispatched = publishCalls[index]!;
    const prompt = dispatched.payload as unknown as RuntimeLaunchPrompt;
    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: resolveSession(dispatched.sessionName)!.sessionKey,
      sessionName: dispatched.sessionName,
      sessionCwd: stateDir!,
      agent: { id: "main", cwd: stateDir! },
      prompt: continuation ? { prompt: "continue", ...pickRuntimeTurnAuthorityEnvelope(prompt) } : prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution: {
        options: {},
        sources: { model: null, effort: null, thinking: null },
        hasTaskRuntimeContext: false,
      },
    });
    return () =>
      accessActorFromTurn(
        resolveConnectorTurn({
          env: { RAVI_CONTEXT_KEY: runtimeContext.contextKey },
          activeUserId: "operator-user",
          activeOrgId: "test-org",
        }),
      );
  }

  for (const sessionTarget of ["main", "isolated"] as const) {
    it(`does not elevate an admitted contact prompt when the operator takes ownership (${sessionTarget})`, async () => {
      const contact = createContact({ name: "Cron author", phone: "5511900000101" });
      const job = createAgentJob({ agentId: "main", sessionTarget, ownerPrincipal: `contact:${contact.id}` });
      const runner = new CronRunner();
      await runner.triggerJob(job.id);
      const classify = admit();
      expect(classify()).toMatchObject({ kind: "contact", contactId: contact.id });
      dbUpdateCronJob(job.id, { ownerPrincipal: "operator", message: "new operator instructions" });
      expect(classify()).toMatchObject({ kind: "contact", contactId: contact.id });
      // A host continuation and delayed queue consumption keep the same owner.
      expect(admit(0, true)()).toMatchObject({ kind: "contact", contactId: contact.id });
      expect(admit()()).toMatchObject({ kind: "contact", contactId: contact.id });
      await runner.triggerJob(job.id);
      expect(admit(1)()).toMatchObject({ kind: "operator" });
    });
  }

  it("keeps the operator on an admitted run after transfer to another contact", async () => {
    const contact = createContact({ name: "New owner", phone: "5511900000102" });
    const job = createAgentJob({ agentId: "main", ownerPrincipal: "operator" });
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    const classify = admit();
    dbUpdateCronJob(job.id, { ownerPrincipal: `contact:${contact.id}`, message: "contact instructions" });
    expect(classify()).toMatchObject({ kind: "operator" });
    await runner.triggerJob(job.id);
    expect(admit(1)()).toMatchObject({ kind: "contact", contactId: contact.id });
  });

  for (const action of ["blocked", "removed"] as const) {
    it(`refuses protected calls when the admitted owner is ${action}, even after transfer`, async () => {
      const contact = createContact({ name: "Revoked owner", phone: "5511900000103" });
      const job = createAgentJob({ agentId: "main", ownerPrincipal: `contact:${contact.id}` });
      await new CronRunner().triggerJob(job.id);
      const classify = admit();
      expect(classify()).toMatchObject({ kind: "contact", contactId: contact.id });
      dbUpdateCronJob(job.id, { ownerPrincipal: "operator" });
      if (action === "blocked") setContactStatus(contact.id, "blocked");
      else deleteContact(contact.id);
      expect(classify()).toMatchObject({ kind: "refused" });
    });
  }

  it("lets admitted work finish when disabled while preventing scheduled redispatch", async () => {
    const job = createAgentJob({ agentId: "main", ownerPrincipal: "operator" });
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    const classify = admit();
    dbUpdateJobState(job.id, { lastRunAt: 123, lastStatus: "ok", nextRunAt: Date.now() - 1 });
    dbUpdateCronJob(job.id, { enabled: false });
    expect(classify()).toMatchObject({ kind: "operator" });
    await runner.start();
    try {
      expect(publishCalls).toHaveLength(1);
    } finally {
      await runner.stop();
    }
  });

  it("rechecks disable at admission after waiting for another due job", async () => {
    const first = createAgentJob();
    const second = createAgentJob();
    dbUpdateJobState(first.id, { lastRunAt: 123, lastStatus: "ok", nextRunAt: Date.now() - 2000 });
    dbUpdateJobState(second.id, { lastRunAt: 123, lastStatus: "ok", nextRunAt: Date.now() - 1000 });
    onPublish = () => dbUpdateCronJob(second.id, { enabled: false });
    const runner = new CronRunner();
    await runner.start();
    try {
      await runner["runDueJobs"]();
      expect(publishCalls.map((call) => call.payload._jobId)).toEqual([first.id]);
      expect(dbGetCronJob(second.id)?.lastRunAt).toBe(123);
    } finally {
      await runner.stop();
    }
  });

  it("keeps a one-shot's admitted authority after automatic job deletion", async () => {
    const job = createAgentJob({ agentId: "main", ownerPrincipal: "operator", deleteAfterRun: true });
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    expect(dbGetCronJob(job.id)).not.toBeNull();
    await runner.handleRuntimeEvent(
      runtimeEvent(publishCalls[0]!.sessionName, {
        type: "turn.complete",
        _turnProvenance: cronProvenance(job.id),
      }),
    );
    expect(dbGetCronJob(job.id)).toBeNull();
    expect(admit()()).toMatchObject({ kind: "operator" });
  });

  for (const snapshot of [
    undefined,
    null,
    {},
    { jobId: "different-job", ownerPrincipal: "operator", ownerIsOperator: true },
    { ownerPrincipal: "operator", ownerIsOperator: "true" },
  ]) {
    it(`refuses invalid queued admission authority: ${JSON.stringify(snapshot)}`, async () => {
      const job = createAgentJob({ agentId: "main", ownerPrincipal: "operator" });
      await new CronRunner().triggerJob(job.id);
      publishCalls[0]!.payload._cronAuthority = snapshot;
      expect(admit()()).toMatchObject({ kind: "refused" });
    });
  }
});

describe("CronRunner agent job outcome tracking", () => {
  it("caps distant timers and re-arms without dispatching a job before its due time", async () => {
    const dueAt = Date.now() + 60 * 24 * 60 * 60 * 1000;
    const job = createAgentJob({ schedule: { type: "at", at: dueAt } });
    const runner = new CronRunner();
    const timer = spyOn(globalThis, "setTimeout");
    try {
      await runner.start();
      expect(timer.mock.calls[0]?.[1]).toBe(2_147_483_647);
      const wakeup = timer.mock.calls[0]?.[0] as () => void;
      wakeup();
      expect(timer.mock.calls[1]?.[1]).toBe(2_147_483_647);
      expect(publishCalls).toHaveLength(0);
      expect(dbGetCronJob(job.id)?.nextRunAt).toBe(dueAt);
      expect(dbGetCronJob(job.id)?.lastRunAt).toBeUndefined();
    } finally {
      await runner.stop();
      timer.mockRestore();
    }
  });

  it("does not report ok on dispatch and records the error when the turn fails", async () => {
    const job = createAgentJob();
    const runner = new CronRunner();

    expect(await runner.triggerJob(job.id)).toBe(true);

    expect(publishCalls).toHaveLength(1);
    const { sessionName, payload } = publishCalls[0]!;
    expect(payload).toMatchObject({ _cron: true, _jobId: job.id });

    const dispatched = dbGetCronJob(job.id)!;
    expect(dispatched.lastRunAt).toBeDefined();
    expect(dispatched.nextRunAt).toBeGreaterThan(dispatched.lastRunAt!);
    expect(dispatched.lastStatus).toBeUndefined();
    expect(dispatched.lastError).toBeUndefined();
    expect(dispatched.lastDurationMs).toBeUndefined();

    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, {
        type: "turn.failed",
        provider: "codex",
        error: "400 The requested model 'gpt-5.3-codex-spark' is not supported.",
        recoverable: true,
        _turnProvenance: cronProvenance(job.id),
      }),
    );

    const failed = dbGetCronJob(job.id)!;
    expect(failed.lastStatus).toBe("error");
    expect(failed.lastError).toContain("gpt-5.3-codex-spark");
    expect(failed.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(failed.lastRunAt).toBe(dispatched.lastRunAt);
    expect(failed.nextRunAt).toBe(dispatched.nextRunAt);
  });

  it("retains a launch failure emitted before the prompt publish ack", async () => {
    const job = createAgentJob({ schedule: { type: "at", at: Date.now() + 60000 } });
    const runner = new CronRunner();
    beforePublishAck = async (sessionName) => {
      await runner.handleRuntimeEvent(
        runtimeEvent(sessionName, {
          type: "turn.failed",
          error: "No managed runtime credential could be resolved",
          _turnProvenance: cronProvenance(job.id),
        }),
      );
    };
    await runner.triggerJob(job.id);
    expect(dbGetCronJob(job.id)).toMatchObject({
      lastStatus: "error",
      lastError: "No managed runtime credential could be resolved",
    });
    const { listLocalInboxItems } = await import("../inbox/local-db.js");
    expect(listLocalInboxItems({ sourceDomain: "cron" })).toHaveLength(1);
  });

  it("never runs a main-target job in a trigger's own session, its reply session included", async () => {
    // A trigger's own session goes by its key: one string is its name and its key.
    const ownKey = "agent:test-agent:trigger:ab12cd34:own";
    getOrCreateSession(ownKey, "test-agent", stateDir!, undefined, { triggerRunner: true });
    const runner = new CronRunner();

    // The reply session a job gets when it is created during one of that
    // trigger's turns: the job runs in the main session.
    const job = createAgentJob({ sessionTarget: "main", replySession: ownKey });
    await runner.triggerJob(job.id);
    const published = publishCalls.at(-1)!;
    expect(published.payload._jobId).toBe(job.id);
    expect(published.sessionName).not.toBe(ownKey);
    expect(resolveSession(published.sessionName)?.sessionKey).toBe("agent:test-agent:main");

    // Any other reply session is still where the job runs.
    getOrCreateSession("agent:test-agent:whatsapp:dm:5511888888888", "test-agent", stateDir!, { name: "ana-chat" });
    const elsewhere = createAgentJob({ sessionTarget: "main", replySession: "ana-chat" });
    await runner.triggerJob(elsewhere.id);
    expect(publishCalls.at(-1)?.sessionName).toBe("ana-chat");
  });

  it("records ok only after the turn completes", async () => {
    const job = createAgentJob({ sessionTarget: "main" });
    const runner = new CronRunner();

    await runner.triggerJob(job.id);
    const { sessionName } = publishCalls[0]!;
    expect(dbGetCronJob(job.id)?.lastStatus).toBeUndefined();

    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.complete", provider: "claude", _turnProvenance: cronProvenance(job.id) }),
    );

    const completed = dbGetCronJob(job.id)!;
    expect(completed.lastStatus).toBe("ok");
    expect(completed.lastError).toBeUndefined();
    expect(completed.lastDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("clears a previous failure on re-dispatch until the new turn reports", async () => {
    const job = createAgentJob();
    const runner = new CronRunner();

    await runner.triggerJob(job.id);
    const { sessionName } = publishCalls[0]!;
    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.failed", error: "boom", _turnProvenance: cronProvenance(job.id) }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("error");

    await runner.triggerJob(job.id);
    const redispatched = dbGetCronJob(job.id)!;
    expect(redispatched.lastStatus).toBeUndefined();
    expect(redispatched.lastError).toBeUndefined();

    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.complete", _turnProvenance: cronProvenance(job.id) }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("ok");
  });

  it("keeps failed one-shots and deletes them only after a successful turn", async () => {
    const job = createAgentJob({ schedule: { type: "at", at: Date.now() }, deleteAfterRun: true });
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    expect(dbGetCronJob(job.id)).not.toBeNull();
    const sessionName = publishCalls[0]!.sessionName;
    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.interrupted", _turnProvenance: cronProvenance(job.id) }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("error");
    const { listLocalInboxItems } = await import("../inbox/local-db.js");
    expect(listLocalInboxItems({ sourceDomain: "cron" })).toHaveLength(1);
    await runner.triggerJob(job.id);
    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.complete", _turnProvenance: cronProvenance(job.id) }),
    );
    expect(dbGetCronJob(job.id)).toBeNull();
  });

  it("records interrupted turns as errors", async () => {
    const job = createAgentJob();
    const runner = new CronRunner();

    await runner.triggerJob(job.id);
    const { sessionName } = publishCalls[0]!;
    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, {
        type: "turn.interrupted",
        reason: "provider_transport_failure",
        _turnProvenance: cronProvenance(job.id),
      }),
    );

    const interrupted = dbGetCronJob(job.id)!;
    expect(interrupted.lastStatus).toBe("error");
    expect(interrupted.lastError).toBe("Agent turn interrupted (provider_transport_failure)");
  });

  it("ignores terminal events from other turns in the shared session", async () => {
    const job = createAgentJob({ sessionTarget: "main" });
    const runner = new CronRunner();

    await runner.triggerJob(job.id);
    const { sessionName } = publishCalls[0]!;

    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, {
        type: "turn.failed",
        error: "human turn failed",
        _turnProvenance: { origin: "human", background: false, automationOriginated: false, reason: "contact" },
      }),
    );
    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, {
        type: "turn.complete",
        _turnProvenance: { origin: "trigger", automationId: "trigger:t1", background: true, reason: "x" },
      }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBeUndefined();

    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.complete", _turnProvenance: cronProvenance(job.id) }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("ok");
  });

  it("attributes pre-turn failures by durable run provenance", async () => {
    const job = createAgentJob();
    const other = createAgentJob();
    const runner = new CronRunner();

    await runner.triggerJob(job.id);
    await runner.triggerJob(other.id);
    const jobSession = publishCalls[0]!.sessionName;
    const otherSession = publishCalls[1]!.sessionName;
    expect(jobSession).not.toBe(otherSession);

    await runner.handleRuntimeEvent(
      runtimeEvent(jobSession, {
        type: "turn.failed",
        error: "Runtime failed to start: spawn ENOENT",
        recoverable: false,
        _turnProvenance: cronProvenance(job.id),
      }),
    );

    expect(dbGetCronJob(job.id)).toMatchObject({
      lastStatus: "error",
      lastError: "Runtime failed to start: spawn ENOENT",
    });
    expect(dbGetCronJob(other.id)?.lastStatus).toBeUndefined();

    // A pending dispatch is consumed once; a later unrelated launch failure on
    // the same session is not re-attributed to the finished run.
    await runner.handleRuntimeEvent(runtimeEvent(jobSession, { type: "turn.complete" }));
    await runner.handleRuntimeEvent(runtimeEvent(jobSession, { type: "turn.failed", error: "later failure" }));
    expect(dbGetCronJob(job.id)?.lastError).toBe("Runtime failed to start: spawn ENOENT");
  });

  it("records provenance-correlated outcomes even without an in-memory pending dispatch", async () => {
    const job = createAgentJob();
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    await new CronRunner().handleRuntimeEvent(
      runtimeEvent(publishCalls[0]!.sessionName, {
        type: "turn.failed",
        error: "400 model not supported",
        _turnProvenance: cronProvenance(job.id),
      }),
    );
    const failed = dbGetCronJob(job.id)!;
    expect(failed.lastStatus).toBe("error");
    expect(failed.lastError).toBe("400 model not supported");
    expect(failed.lastDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not let shell on-error notification turns overwrite the shell result", async () => {
    const shellJob = dbCreateCronJob({
      name: `etl-${Math.random().toString(36).slice(2, 8)}`,
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: "exit 1",
      onError: "notify-session:ops",
    });
    dbUpdateJobState(shellJob.id, {
      lastRunAt: Date.now(),
      lastStatus: "error",
      lastError: "Shell command failed with exit code 1",
      lastDurationMs: 5,
      lastExitCode: 1,
    });
    const runner = new CronRunner();

    await runner.handleRuntimeEvent(
      runtimeEvent("ops", { type: "turn.complete", _turnProvenance: cronProvenance(shellJob.id) }),
    );

    expect(dbGetCronJob(shellJob.id)).toMatchObject({
      lastStatus: "error",
      lastError: "Shell command failed with exit code 1",
      lastExitCode: 1,
    });
  });

  it("ignores outcomes for unknown jobs and non-terminal events", async () => {
    const job = createAgentJob();
    const runner = new CronRunner();
    dbMarkJobDispatched(job.id, { lastRunAt: Date.now() });

    await runner.handleRuntimeEvent(
      runtimeEvent("test-agent", { type: "turn.failed", error: "x", _turnProvenance: cronProvenance("missing") }),
    );
    await runner.handleRuntimeEvent(
      runtimeEvent("test-agent", { type: "assistant.message", text: "hi", _turnProvenance: cronProvenance(job.id) }),
    );
    await runner.handleRuntimeEvent({
      topic: "ravi.session.test-agent.response",
      data: { type: "turn.failed", error: "x" },
    });

    expect(dbGetCronJob(job.id)?.lastStatus).toBeUndefined();
  });

  it("records dispatch failures immediately", async () => {
    const job = createAgentJob();
    const runner = new CronRunner();
    publishError = new Error("SESSION_PROMPTS stream not found");

    await runner.triggerJob(job.id);

    const failed = dbGetCronJob(job.id)!;
    expect(failed.lastStatus).toBe("error");
    expect(failed.lastError).toBe("SESSION_PROMPTS stream not found");
    expect(failed.nextRunAt).toBeGreaterThan(failed.lastRunAt!);
  });

  it("subscribes to runtime terminal events while running", async () => {
    const runner = new CronRunner();
    await runner.start();
    try {
      expect(subscribedTopics).toContain(CRON_RUNTIME_EVENTS_TOPIC);
    } finally {
      await runner.stop();
    }
  });
});

describe("CronRunner shell jobs and personal connectors", () => {
  function parseEnvDump(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return env;
  }

  async function runShellJobEnv(ownerPrincipal: string): Promise<{ jobId: string; env: Record<string, string> }> {
    const out = join(stateDir!, `env-${Math.random().toString(36).slice(2, 8)}.txt`);
    const envFile = join(stateDir!, "job.env");
    // The env file cannot rename the automation the command acts for. Explicit
    // mode: the loader refuses a file its group can write (umask 002).
    writeFileSync(
      envFile,
      `RAVI_AUTOMATION_PRINCIPAL=automation:cron:someone-else\n${CRON_RUN_AUTHORITY_ENV}=invalid\n`,
      { mode: 0o600 },
    );
    const job = dbCreateCronJob({
      name: `shell-env-${Math.random().toString(36).slice(2, 8)}`,
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: `env > '${out}'`,
      shellEnvFile: envFile,
      ownerPrincipal,
    });
    await new CronRunner().triggerJob(job.id);
    return { jobId: job.id, env: parseEnvDump(readFileSync(out, "utf8")) };
  }

  const owner = { activeUserId: "user_luis", activeOrgId: "org_1", ownerName: "Luis" };

  it("runs an operator's command as the job's routine, never as the operator's terminal", async () => {
    const operatorJob = await runShellJobEnv("operator");
    expect(operatorJob.env.RAVI_AUTOMATION_PRINCIPAL).toBe(`automation:cron:${operatorJob.jobId}`);
    // The spawned process retains admission authority after a live transfer.
    // (The run's context key is revoked once the command ends; the env marker
    // alone is what a process without a key falls back to.)
    dbUpdateCronJob(operatorJob.jobId, { ownerPrincipal: "unknown" });
    const { RAVI_CONTEXT_KEY: _revokedKey, ...markerOnly } = operatorJob.env;
    const allowed = resolveConnectorTurn({ ...owner, env: markerOnly });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.turn).toMatchObject({
        speaker: { kind: "automation" },
        routine: { kind: "cron", id: operatorJob.jobId },
      });
    }
  });

  it("gives an operator's shell run a root cron-shell context, revoked when the command ends", async () => {
    const operatorJob = await runShellJobEnv("operator");
    const key = operatorJob.env.RAVI_CONTEXT_KEY;
    expect(key).toBeTruthy();
    const context = dbListContexts({ includeInactive: true, kind: "cron-shell" }).find((c) => c.contextKey === key);
    expect(context?.metadata).toMatchObject({
      actorPrincipal: `automation:cron:${operatorJob.jobId}`,
      cronRunAuthority: { jobId: operatorJob.jobId, ownerPrincipal: "operator", ownerIsOperator: true },
    });
    expect(context?.metadata?.parentContextId).toBeUndefined();
    expect(context?.revokedAt).toBeDefined();
    expect(context?.metadata?.revocationReason).toBe("cron_shell_completed");
    // Expired at the end: the key no longer classifies as the job's routine.
    expect(resolveConnectorTurn({ ...owner, env: { RAVI_CONTEXT_KEY: key! } }).ok).toBe(false);
  });

  it("acts for the operator in Bases while the shell run's context is live", () => {
    const job = dbCreateCronJob({
      name: "shell-live",
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: "true",
      ownerPrincipal: "operator",
    });
    const authority = { jobId: job.id, ownerPrincipal: "operator", ownerIsOperator: true };
    const issued = issueShellCronContext(job, authority, 1_000)!;
    try {
      const turn = resolveConnectorTurn({ ...owner, env: { RAVI_CONTEXT_KEY: issued.context.contextKey } });
      expect(turn).toMatchObject({ ok: true, turn: { routine: { kind: "cron", id: job.id } } });
      expect(accessActorFromTurn(turn)).toMatchObject({ kind: "operator" });
    } finally {
      issued.release();
    }
    expect(
      accessActorFromTurn(resolveConnectorTurn({ ...owner, env: { RAVI_CONTEXT_KEY: issued.context.contextKey } }))
        .kind,
    ).toBe("refused");
  });

  it("never stores or notifies the run's context key, even when the command prints it", async () => {
    const job = dbCreateCronJob({
      name: "shell-leak",
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: 'echo "out:$RAVI_CONTEXT_KEY"; echo "err:$RAVI_CONTEXT_KEY" >&2; exit 3',
      ownerPrincipal: "operator",
      onError: "notify-session:shell-leak-session",
    });
    await new CronRunner().triggerJob(job.id);
    const key = dbListContexts({ includeInactive: true, kind: "cron-shell" }).at(-1)?.contextKey;
    expect(key).toBeTruthy();
    const after = dbGetCronJob(job.id)!;
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toContain("[REDACTED:context-key]");
    expect(after.lastError).not.toContain(key!);
    for (const call of publishCalls) expect(JSON.stringify(call.payload)).not.toContain(key!);
  });

  // Owned by the test, not read from production: what the spec allows (13c).
  const SPEC_SHELL_TUPLES = [
    "mutate:bases.rows:add",
    "mutate:bases.rows:archive",
    "mutate:bases.rows:restore",
    "mutate:bases.rows:update",
    "mutate:pages:ship",
    "read:bases.rows:export",
    "read:bases.rows:get",
    "read:bases.rows:history",
    "read:bases.rows:query",
    "read:bases.views:list",
    "read:bases.views:query",
    "read:bases.views:show",
    "read:bases:list",
    "read:bases:show",
    "read:pages:list",
    "read:pages:read",
    "read:self:whoami",
  ];
  const tuples = (caps: Array<{ permission: string; objectType: string; objectId: string }>) =>
    caps.map((c) => `${c.permission}:${c.objectType}:${c.objectId}`).sort();

  it("scopes the shell run's context to Bases, Pages and self whoami, within the agent's own capabilities", () => {
    const job = { id: "job-scope", agentId: "main" };
    const authority = { jobId: "job-scope", ownerPrincipal: "operator", ownerIsOperator: true };
    const issue = (capabilities: Array<{ permission: string; objectType: string; objectId: string }>) =>
      issueShellCronContext(job, authority, 1_000, { agentExists: () => true, capabilitiesFor: () => capabilities })!;

    // An agent with broad authority: the key gets exactly the spec's tuples.
    const broad = issue([
      { permission: "admin", objectType: "system", objectId: "*" },
      { permission: "use", objectType: "tool", objectId: "*" },
    ]);
    try {
      expect(tuples(broad.context.capabilities)).toEqual(SPEC_SHELL_TUPLES);
    } finally {
      broad.release();
    }

    // An agent with less: never more than the agent may run.
    const narrow = issue([
      { permission: "read", objectType: "bases", objectId: "list" },
      { permission: "use", objectType: "tool", objectId: "*" },
      { permission: "execute", objectType: "group", objectId: "sessions" },
      { permission: "mutate", objectType: "task", objectId: "*" },
    ]);
    try {
      expect(tuples(narrow.context.capabilities)).toEqual(["read:bases:list"]);
    } finally {
      narrow.release();
    }
  });

  it("keeps a command the agent runs through a legacy or alternate grant, carrying only the narrow tuple", () => {
    const job = { id: "job-legacy", agentId: "main" };
    const authority = { jobId: "job-legacy", ownerPrincipal: "operator", ownerIsOperator: true };
    const issued = issueShellCronContext(job, authority, 1_000, {
      agentExists: () => true,
      capabilitiesFor: () => [
        { permission: "execute", objectType: "group", objectId: "pages_read" },
        { permission: "read", objectType: "pages.list", objectId: "*" },
        { permission: "execute", objectType: "group", objectId: "bases.rows" },
      ],
    })!;
    try {
      const got = tuples(issued.context.capabilities);
      expect(got).toContain("read:pages:read");
      expect(got).toContain("read:pages:list");
      expect(got).toContain("mutate:bases.rows:add");
      for (const tuple of got) expect(SPEC_SHELL_TUPLES).toContain(tuple);
      expect(got.some((tuple) => tuple.startsWith("execute:group") || tuple.includes("pages.list"))).toBe(false);
    } finally {
      issued.release();
    }
  });

  it("names every allowlisted command with the access the CLI registry declares for it", () => {
    const registry = getRegistry().commands;
    for (const entry of CRON_SHELL_ALLOWED_COMMANDS) {
      const command = registry.find((c) => c.groupPath === entry.group && c.command === entry.command);
      expect(command?.access).toMatchObject({ kind: entry.kind, resource: entry.resource, action: entry.action });
      expect(command?.access?.requireConcreteResource).toBeFalsy();
      expect(command?.access?.retiredLegacyGroups ?? []).toEqual([]);
    }
  });

  it("revokes at boot only the shell cron contexts whose run is over", () => {
    const make = (issuer?: { pid: number; host: string }) =>
      createRuntimeContext({
        kind: "cron-shell",
        agentId: "main",
        metadata: { actorPrincipal: "automation:cron:old", ...(issuer ? { cronShellIssuer: issuer } : {}) },
      });
    const noIssuer = make();
    const deadHere = make({ pid: 4242, host: "this-host" });
    const ownPidHere = make({ pid: 1000, host: "this-host" });
    const liveHere = make({ pid: 5151, host: "this-host" });
    const otherHost = make({ pid: 4242, host: "other-host" });
    const unrelated = createRuntimeContext({ kind: "cli-runtime", agentId: "main", metadata: {} });

    const revoked = revokeOrphanedShellCronContexts({
      host: "this-host",
      selfPid: 1000,
      isAlive: (pid) => pid === 5151,
    });

    expect(revoked).toBe(3);
    const reason = (id: string) =>
      dbListContexts({ includeInactive: true }).find((c) => c.contextId === id)?.metadata?.revocationReason;
    expect(reason(noIssuer.contextId)).toBe("cron_shell_daemon_restart");
    expect(reason(deadHere.contextId)).toBe("cron_shell_daemon_restart");
    expect(reason(ownPidHere.contextId)).toBe("cron_shell_daemon_restart");
    for (const kept of [liveHere, otherHost, unrelated]) {
      const row = dbListContexts({ includeInactive: true }).find((c) => c.contextId === kept.contextId);
      expect(row).toBeDefined();
      expect(row?.revokedAt).toBeUndefined();
    }
  });

  it("keeps revoking the other orphaned contexts when one revocation fails", () => {
    const make = () =>
      createRuntimeContext({
        kind: "cron-shell",
        agentId: "main",
        metadata: { actorPrincipal: "automation:cron:old" },
      });
    const first = make();
    const second = make();
    const third = make();
    const attempted: string[] = [];

    const revoked = revokeOrphanedShellCronContexts({
      host: "this-host",
      selfPid: 1000,
      isAlive: () => false,
      revoke: (contextId) => {
        attempted.push(contextId);
        if (contextId === second.contextId) throw new Error("revocation failed");
      },
    });

    expect(new Set(attempted)).toEqual(new Set([first.contextId, second.contextId, third.contextId]));
    expect(revoked).toBe(2);
  });

  it("records the issuing daemon process on a shell run's context", () => {
    const issued = issueShellCronContext(
      { id: "job-issuer", agentId: "main" },
      { jobId: "job-issuer", ownerPrincipal: "operator", ownerIsOperator: true },
      1_000,
    )!;
    try {
      expect(issued.context.metadata?.cronShellIssuer).toMatchObject({ pid: process.pid });
    } finally {
      issued.release();
    }
  });

  it("issues no context when the job's agent does not exist, and the command still runs", () => {
    const authority = { jobId: "job-y", ownerPrincipal: "operator", ownerIsOperator: true };
    expect(issueShellCronContext({ id: "job-y", agentId: "missing-agent" }, authority, 1_000)).toBeNull();
  });

  it("issues no context for a run whose owner does not act as the operator", () => {
    const job = { id: "job-x", agentId: undefined };
    expect(
      issueShellCronContext(job, { jobId: "job-x", ownerPrincipal: "contact:c1", ownerIsOperator: false }, 1_000),
    ).toBeNull();
    expect(
      issueShellCronContext(job, { jobId: "job-x", ownerPrincipal: "operator", ownerIsOperator: true }, 1_000, {
        ownerActsAsOperator: () => false,
      }),
    ).toBeNull();
    expect(
      issueShellCronContext(job, { jobId: "other", ownerPrincipal: "operator", ownerIsOperator: true }, 1_000),
    ).toBeNull();
  });

  it("does not honor a cron snapshot on a cron-shell context that has a parent", () => {
    const forged = createRuntimeContext({
      kind: "cron-shell",
      agentId: "main",
      metadata: {
        parentContextId: "ctx_parent",
        actorPrincipal: "automation:cron:job-forged",
        cronRunAuthority: { jobId: "job-forged", ownerPrincipal: "operator", ownerIsOperator: true },
      },
    });
    expect(resolveConnectorTurn({ ...owner, env: { RAVI_CONTEXT_KEY: forged.contextKey } }).ok).toBe(false);
  });

  it("does not run a shell job someone other than the operator owns", async () => {
    const out = join(stateDir!, "contact-shell.txt");
    const job = dbCreateCronJob({
      name: "shell-contact",
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: `echo ran > '${out}'`,
      ownerPrincipal: "contact:c_bob",
    });
    await new CronRunner().triggerJob(job.id);
    expect(existsSync(out)).toBe(false);
    const after = dbGetCronJob(job.id);
    expect(after?.enabled).toBe(false);
    expect(after?.nextRunAt).toBeUndefined();
    expect(after?.lastRunAt).toBeUndefined();
    expect(after?.lastStatus).toBeUndefined();
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]!.payload.prompt).toContain("CRON_SHELL_NOT_OPERATOR");
  });

  it("tells the operator alone by direct message, not the contact that owns it nor the main session, when it turns a shell job off", async () => {
    operatorChat = OPERATOR_CHAT;
    contactChats.set("c_bob", BOB_CHAT);
    const out = join(stateDir!, "contact-shell-dm.txt");
    const job = dbCreateCronJob({
      name: "Backup do Bob",
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: `echo ran > '${out}'`,
      ownerPrincipal: "contact:c_bob",
    });
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    await runner.triggerJob(job.id);
    await waitUntil(() => directMessages.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(existsSync(out)).toBe(false);
    expect(dbGetCronJob(job.id)?.enabled).toBe(false);
    // The contact cannot act on it (only the operator can recreate a shell), and a message to
    // them would travel over whatever instance Ravi last saw them on: nothing is sent.
    expect(directAttempts.map((target) => target.contactId)).toEqual(["c_operator"]);
    expect(directMessages.map(({ target }) => target.contactId)).toEqual(["c_operator"]);
    const { text } = directMessages[0]!;
    expect(text).toContain(
      `O agendamento de shell “Backup do Bob” (${job.id}) foi desligado: CRON_SHELL_NOT_OPERATOR.`,
    );
    expect(text).toContain("Nenhum comando foi executado");
    expect(text).toContain(`ravi cron show ${job.id}`);
    expect(text).not.toContain(out);
    expect(text).not.toContain("contact:");
    // The direct message was enough, and a second run finds the job off: nothing more is sent.
    expect(publishCalls).toHaveLength(0);
    expect(directMessages).toHaveLength(1);
  });

  it("falls back to the main session when the operator's chat does not resolve, though the owner has one", async () => {
    // No contact is tagged as the operator (or more than one is): the operator would hear nothing.
    contactChats.set("c_bob", BOB_CHAT);
    const job = dbCreateCronJob({
      name: "Backup do Bob, sem chat do operador",
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: "true",
      ownerPrincipal: "contact:c_bob",
    });
    await new CronRunner().triggerJob(job.id);
    await waitUntil(() => publishCalls.length === 1);

    expect(dbGetCronJob(job.id)?.enabled).toBe(false);
    expect(directAttempts).toHaveLength(0);
    expect(publishCalls[0]!.payload.prompt).toContain("Shell cron disabled (CRON_SHELL_NOT_OPERATOR)");
    expect(publishCalls[0]!.payload._jobId).toBe(job.id);
  });

  it("falls back to the main session when the message to the operator fails, though the owner has a chat", async () => {
    operatorChat = OPERATOR_CHAT;
    contactChats.set("c_bob", BOB_CHAT);
    directDeliveryFails = true;
    const job = dbCreateCronJob({
      name: "Backup do Bob, entrega falha",
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: "true",
      ownerPrincipal: "contact:c_bob",
    });
    await new CronRunner().triggerJob(job.id);
    await waitUntil(() => publishCalls.length === 1);

    expect(dbGetCronJob(job.id)?.enabled).toBe(false);
    expect(directMessages).toHaveLength(0);
    // Only the operator was tried; the contact was never messaged.
    expect(directAttempts.map((target) => target.contactId)).toEqual(["c_operator"]);
    expect(publishCalls[0]!.payload.prompt).toContain("Shell cron disabled (CRON_SHELL_NOT_OPERATOR)");
  });

  it("tells the operator when nobody owns the shell job, and falls back to the main session if that fails", async () => {
    operatorChat = OPERATOR_CHAT;
    const unowned = dbCreateCronJob({
      name: "sem dono",
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: "true",
      ownerPrincipal: "unknown",
    });
    await new CronRunner().triggerJob(unowned.id);
    await waitUntil(() => directMessages.length === 1);
    expect(directMessages[0]!.target.contactId).toBe("c_operator");
    expect(publishCalls).toHaveLength(0);

    directDeliveryFails = true;
    const second = dbCreateCronJob({
      name: "sem dono, entrega falha",
      schedule: { type: "every", every: 60_000 },
      message: "",
      executionType: "shell",
      shellCommand: "true",
      ownerPrincipal: "agent:helper",
    });
    await new CronRunner().triggerJob(second.id);
    await waitUntil(() => publishCalls.length === 1);
    // Never silent: the prompt the runner always sent still goes out, with the cron authority it carried.
    expect(publishCalls[0]!.payload.prompt).toContain("Shell cron disabled (CRON_SHELL_NOT_OPERATOR)");
    expect(publishCalls[0]!.payload._jobId).toBe(second.id);
    expect(directMessages).toHaveLength(1);
  });

  it("reconciles legacy shell jobs at load once, including distant and unscheduled jobs", async () => {
    const out = join(stateDir!, "must-not-run.txt");
    const jobs = [
      createAgentJob({ executionType: "shell", ownerPrincipal: "agent:test-agent", shellCommand: `touch '${out}'` }),
      createAgentJob({
        executionType: "shell",
        ownerPrincipal: "unknown",
        schedule: { type: "at", at: Date.now() + 86400000 },
      }),
    ];
    dbMarkJobDispatched(jobs[0]!.id, { lastRunAt: 123 }); // no next run
    const runner = new CronRunner();
    await runner.start();
    try {
      expect(publishCalls).toHaveLength(2);
      for (const job of jobs) {
        const after = dbGetCronJob(job.id)!;
        expect(after.enabled).toBe(false);
        expect(after.nextRunAt).toBeUndefined();
        expect(after.lastStatus).toBeUndefined();
      }
      const snapshots = jobs.map((job) => dbGetCronJob(job.id));
      runner.refreshTimers();
      await runner.triggerJob(jobs[0]!.id);
      await runner.stop();
      await runner.start();
      expect(jobs.map((job) => dbGetCronJob(job.id))).toEqual(snapshots);
      expect(publishCalls).toHaveLength(2);
      expect(publishCalls[0]!.payload.prompt).not.toContain(out);
      expect(existsSync(out)).toBe(false);
    } finally {
      await runner.stop();
    }
  });

  it("rechecks ownership at the due cycle and preserves historical outcomes", async () => {
    const job = createAgentJob({ executionType: "shell", ownerPrincipal: "operator", shellCommand: "exit 0" });
    const runner = new CronRunner();
    const timer = spyOn(globalThis, "setTimeout");
    try {
      await runner.start();
      dbUpdateCronJob(job.id, { ownerPrincipal: "agent:test-agent" });
      dbUpdateJobState(job.id, { lastRunAt: 123, lastStatus: "error", lastError: "old failure", nextRunAt: 1 });
      const wakeup = timer.mock.calls[0]![0] as () => Promise<void>;
      wakeup();
      await Promise.resolve();
      const after = dbGetCronJob(job.id)!;
      expect(after).toMatchObject({ enabled: false, lastRunAt: 123, lastStatus: "error", lastError: "old failure" });
      expect(after.nextRunAt).toBeUndefined();
      expect(publishCalls).toHaveLength(1);
      runner.refreshTimers();
      expect(dbGetCronJob(job.id)).toEqual(after);
      expect(publishCalls).toHaveLength(1);
    } finally {
      await runner.stop();
      timer.mockRestore();
    }
  });

  it("claims one notice across runners and refuses an explicit invalid re-enable", async () => {
    const out = join(stateDir!, "must-not-run-again.txt");
    const job = createAgentJob({
      executionType: "shell",
      ownerPrincipal: "agent:test-agent",
      shellCommand: `touch '${out}'`,
    });
    const first = new CronRunner();
    const second = new CronRunner();
    try {
      await Promise.all([first.start(), second.start()]);
      expect(publishCalls).toHaveLength(1);
      await Promise.all([first.triggerJob(job.id), second.triggerJob(job.id)]);
      expect(publishCalls).toHaveLength(1);
      dbUpdateCronJob(job.id, { enabled: true });
      await Promise.all([first.triggerJob(job.id), second.triggerJob(job.id)]);
      expect(publishCalls).toHaveLength(2);
      expect(dbGetCronJob(job.id)).toMatchObject({ enabled: false });
      expect(dbGetCronJob(job.id)?.nextRunAt).toBeUndefined();
      expect(dbGetCronJob(job.id)?.lastRunAt).toBeUndefined();
      expect(existsSync(out)).toBe(false);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it("keeps operator shell and agent-owned agent jobs enabled and executable", async () => {
    const shell = createAgentJob({ executionType: "shell", ownerPrincipal: "operator", shellCommand: "exit 0" });
    const agent = createAgentJob({ ownerPrincipal: "agent:test-agent" });
    const runner = new CronRunner();
    await runner.start();
    try {
      expect(publishCalls).toHaveLength(0);
      await runner.triggerJob(shell.id);
      await runner.triggerJob(agent.id);
      expect(dbGetCronJob(shell.id)).toMatchObject({ enabled: true, lastStatus: "ok" });
      expect(dbGetCronJob(agent.id)?.enabled).toBe(true);
      expect(publishCalls).toHaveLength(1);
      expect(publishCalls[0]!.payload._jobId).toBe(agent.id);
    } finally {
      await runner.stop();
    }
  });

  it("keeps a refused job disabled when notice delivery fails, without retrying it", async () => {
    const job = createAgentJob({ executionType: "shell", ownerPrincipal: "agent:test-agent", shellCommand: "exit 0" });
    publishError = new Error("notice unavailable");
    const runner = new CronRunner();
    await runner.start();
    try {
      expect(dbGetCronJob(job.id)?.enabled).toBe(false);
      publishError = null;
      onPublish = null;
      runner.refreshTimers();
      expect(publishCalls).toHaveLength(0);
      expect(dbGetCronJob(job.id)?.lastRunAt).toBeUndefined();
    } finally {
      await runner.stop();
    }
  });
});

describe("durable cron run correlation", () => {
  it.each([false, true])(
    "starts while failure delivery is pending, then drains and retries (offline=%s)",
    async (offline) => {
      operatorChat = OPERATOR_CHAT;
      directDeliveryFails = offline;
      let release!: () => void;
      directDeliveryGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const job = createAgentJob({ ownerPrincipal: "operator" });
      const { settleCronRun, pendingCronFailureReports } = await import("./run-db.js");
      for (let i = 0; i < 2; i++) {
        await new CronRunner().triggerJob(job.id);
        const dispatched = publishCalls.at(-1)!;
        settleCronRun(String(dispatched.payload._cronRunId), dispatched.sessionName, {
          lastStatus: "error",
          lastError: "failed before report",
        });
      }
      const runner = new CronRunner();
      let started = false;
      const starting = runner.start().then(() => {
        started = true;
      });
      let stopping: Promise<void> | undefined;
      try {
        await waitUntil(() => directAttempts.length === 1);
        await waitUntil(() => started, 500);
        expect(pendingCronFailureReports()).toHaveLength(2);
        await runner.start();
        expect(directAttempts).toHaveLength(1);
        let stopped = false;
        stopping = runner.stop().then(() => {
          stopped = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(stopped).toBe(false);
        release();
        await stopping;
        expect(directAttempts).toHaveLength(1);
        // The backlog goes out as one digest: both runs settle together, or stay pending together.
        expect(pendingCronFailureReports()).toHaveLength(offline ? 2 : 0);
      } finally {
        release();
        await starting;
        await (stopping ?? runner.stop());
        directDeliveryGate = null;
      }

      directDeliveryFails = false;
      const recovered = new CronRunner();
      try {
        await recovered.start();
        await waitUntil(() => pendingCronFailureReports().length === 0);
        // Both failed runs of the job settle with one message that carries the count.
        expect(directMessages).toHaveLength(1);
        expect(directMessages[0]!.text).toContain("falhou 2 vezes");
        expect(directAttempts).toHaveLength(offline ? 2 : 1);
      } finally {
        await recovered.stop();
      }
    },
  );

  it("stops after about a second while a failure delivery is still stalled, leaving the report for the next start", async () => {
    operatorChat = OPERATOR_CHAT;
    let release!: () => void;
    directDeliveryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = createAgentJob({ ownerPrincipal: "operator" });
    const { settleCronRun, pendingCronFailureReports } = await import("./run-db.js");
    await new CronRunner().triggerJob(job.id);
    const dispatched = publishCalls.at(-1)!;
    settleCronRun(String(dispatched.payload._cronRunId), dispatched.sessionName, {
      lastStatus: "error",
      lastError: "failed before report",
    });
    const runner = new CronRunner();
    try {
      await runner.start();
      await waitUntil(() => directAttempts.length === 1);
      const stoppedAt = Date.now();
      // The delivery is still held: stop returns on the default grace (about a second, because the
      // daemon stops its components in series inside one 15 s guard), not on the delivery.
      await runner.stop();
      const waited = Date.now() - stoppedAt;
      expect(waited).toBeGreaterThanOrEqual(900);
      expect(waited).toBeLessThan(4_000);
      expect(pendingCronFailureReports()).toHaveLength(1);
      expect(directMessages).toHaveLength(0);

      // The next start finds the unconfirmed report still pending and tries it again.
      const recovered = new CronRunner({ failureReportStopGraceMs: 50 });
      try {
        await recovered.start();
        await waitUntil(() => directAttempts.length === 2);
      } finally {
        await recovered.stop();
      }
    } finally {
      release();
      directDeliveryGate = null;
    }
    // Let the abandoned sends settle so they cannot leak into the next test.
    await waitUntil(() => pendingCronFailureReports().length === 0);
  });

  it("settles reports whose stored notice cannot be read instead of keeping them pending", async () => {
    const { pendingCronFailureReports } = await import("./run-db.js");
    const { getDb } = await import("../router/router-db.js");
    const { listLocalInboxEvents, listLocalInboxItems } = await import("../inbox/local-db.js");
    // The operator's chat is armed and the runs are operator-owned, so a message sent for an unreadable
    // report (a fallback to the operator, say) would be recorded below.
    operatorChat = OPERATOR_CHAT;
    const unreadable = 12;
    for (let i = 0; i < unreadable; i++) {
      const runId = await failedRun({ ownerPrincipal: "operator" });
      getDb().query("UPDATE cron_runs SET notification_json = ? WHERE id = ?").run("{not json", runId);
    }
    await failedRun({ ownerPrincipal: "operator" }); // one readable report behind them
    expect(pendingCronFailureReports()).toHaveLength(unreadable + 1);

    const runner = new CronRunner();
    await runner.start();
    // None of them stays: the readable report is delivered, the unreadable ones are settled.
    await waitUntil(() => pendingCronFailureReports().length === 0);
    // Bad data is not a fault to raise at shutdown.
    await runner.stop();

    const records = listLocalInboxItems({ sourceDomain: "cron" }).filter(
      (item) => item.sourceType === "run_unreadable",
    );
    expect(records).toHaveLength(unreadable);
    for (const item of records)
      expect(listLocalInboxEvents(item.id).map((event) => event.eventType)).toContain("cron.failure.unreadable");
    // No recipient can be known from a notice that does not parse: the only message is the readable report's.
    expect(directMessages).toHaveLength(1);
    expect(directAttempts).toHaveLength(1);

    // A later start finds nothing to replay.
    const later = new CronRunner();
    await later.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await later.stop();
    expect(pendingCronFailureReports()).toHaveLength(0);
  });

  it("keeps at most ten failures for stop to raise when the database refuses every mark", async () => {
    const { pendingCronFailureReports } = await import("./run-db.js");
    const { listLocalInboxItems } = await import("../inbox/local-db.js");
    const refused = 12;
    for (let i = 0; i < refused; i++) await failedRun();
    await refuseMarks();

    const runner = new CronRunner();
    await runner.start();
    // Each report is attempted (the unowned path records it in the inbox) and none can be marked.
    await waitUntil(() => listLocalInboxItems({ sourceDomain: "cron" }).length === refused);
    const failure = await runner.stop().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const raised = (failure as AggregateError).errors as Error[];
    expect(raised).toHaveLength(10);
    expect(raised[0]!.cause).not.toBeInstanceOf(SyntaxError);
    expect(pendingCronFailureReports()).toHaveLength(refused);
  });

  it("keeps a stop that raised for a refused mark failed on later stops, as the shutdown latch requires", async () => {
    operatorChat = OPERATOR_CHAT;
    await refuseMarks(await failedRun({ ownerPrincipal: "operator" }));

    const runner = new CronRunner();
    await runner.start();
    await waitUntil(() => directMessages.length === 1);
    await expect(runner.stop()).rejects.toThrow("Cron runner shutdown failed");
    // Retrying cannot certify success after a failed stop (quality/state-boundary): the failure stays latched.
    await expect(runner.stop()).rejects.toThrow("Cron runner shutdown failed");
  });

  it("keeps draining when a delivered report cannot be marked, and leaves it pending", async () => {
    operatorChat = OPERATOR_CHAT;
    const { settleCronRun, pendingCronFailureReports } = await import("./run-db.js");
    const { getDb } = await import("../router/router-db.js");
    const runIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const job = createAgentJob({ ownerPrincipal: "operator" });
      await new CronRunner().triggerJob(job.id);
      const dispatched = publishCalls.at(-1)!;
      const runId = String(dispatched.payload._cronRunId);
      runIds.push(runId);
      settleCronRun(runId, dispatched.sessionName, { lastStatus: "error", lastError: "failed before report" });
    }
    // The database refuses to mark the first report as reported, as a busy or read-only database would.
    getDb().run(
      `CREATE TRIGGER refuse_first_report BEFORE UPDATE OF reported ON cron_runs WHEN NEW.id = '${runIds[0]}' BEGIN SELECT RAISE(ABORT, 'database is busy'); END`,
    );

    const runner = new CronRunner();
    await runner.start();
    // Both reports go out in one digest; the second is still marked, the first stays pending.
    await waitUntil(() => pendingCronFailureReports().length === 1);
    expect(directMessages).toHaveLength(1);
    expect(pendingCronFailureReports()[0]!.id).toBe(runIds[0]);
    const failure = await runner.stop().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
  });

  it("does not send a report that was acknowledged while the start was still gathering the backlog", async () => {
    operatorChat = OPERATOR_CHAT;
    const { settleCronRun, pendingCronFailureReports, markCronRunReported } = await import("./run-db.js");
    const runIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const job = createAgentJob({ ownerPrincipal: "operator" });
      await new CronRunner().triggerJob(job.id);
      const dispatched = publishCalls.at(-1)!;
      runIds.push(String(dispatched.payload._cronRunId));
      settleCronRun(runIds[i]!, dispatched.sessionName, { lastStatus: "error", lastError: "failed before report" });
    }
    const runner = new CronRunner();
    try {
      await runner.start();
      // `cron ack-failures` settles both while the start is between reports.
      for (const runId of runIds) markCronRunReported(runId);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pendingCronFailureReports()).toHaveLength(0);
      expect(directAttempts).toHaveLength(0);
    } finally {
      await runner.stop();
    }
  });

  it("yields the event loop between reports that settle locally", async () => {
    const { settleCronRun, pendingCronFailureReports } = await import("./run-db.js");
    for (let i = 0; i < 6; i++) {
      const job = createAgentJob();
      await new CronRunner().triggerJob(job.id);
      const dispatched = publishCalls.at(-1)!;
      settleCronRun(String(dispatched.payload._cronRunId), dispatched.sessionName, {
        lastStatus: "error",
        lastError: "failed before report",
      });
    }
    expect(pendingCronFailureReports()).toHaveLength(6);
    const runner = new CronRunner();
    try {
      await runner.start();
      // One turn of the event loop: a backlog that drained through microtasks alone would already be empty.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pendingCronFailureReports().length).toBeGreaterThan(0);
      await waitUntil(() => pendingCronFailureReports().length === 0);
    } finally {
      await runner.stop();
    }
  });

  it("reconciles a persisted failure whose notification was interrupted", async () => {
    const job = createAgentJob();
    await new CronRunner().triggerJob(job.id);
    const { settleCronRun } = await import("./run-db.js");
    const dispatched = publishCalls[0]!;
    settleCronRun(String(dispatched.payload._cronRunId), dispatched.sessionName, {
      lastStatus: "error",
      lastError: "failed before report",
    });
    const { listLocalInboxItems } = await import("../inbox/local-db.js");
    expect(listLocalInboxItems({ sourceDomain: "cron" })).toHaveLength(0);
    const runner = new CronRunner();
    try {
      await runner.start();
      expect(listLocalInboxItems({ sourceDomain: "cron" })).toHaveLength(1);
    } finally {
      await runner.stop();
    }
  });
  it("keeps overlapping one-shots and records the later failure after recreation", async () => {
    const job = createAgentJob({ schedule: { type: "at", at: Date.now() }, deleteAfterRun: true });
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    await runner.triggerJob(job.id);
    expect(publishCalls[0]!.payload._cronRunId).not.toBe(publishCalls[1]!.payload._cronRunId);
    const sessionName = publishCalls[0]!.sessionName;
    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.complete", _turnProvenance: cronProvenance(job.id, 0) }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBeUndefined();
    await new CronRunner().handleRuntimeEvent(
      runtimeEvent(sessionName, {
        type: "turn.failed",
        error: "late failure",
        _turnProvenance: cronProvenance(job.id, 1),
      }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("error");
    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.complete", _turnProvenance: cronProvenance(job.id, 0) }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("error");
  });

  it("cannot attribute a human startup failure or mismatched run to a pending cron", async () => {
    const job = createAgentJob({ sessionTarget: "main" });
    await new CronRunner().triggerJob(job.id);
    const runner = new CronRunner();
    const sessionName = publishCalls[0]!.sessionName;
    await runner.handleRuntimeEvent(runtimeEvent(sessionName, { type: "turn.failed", error: "unrelated" }));
    await runner.handleRuntimeEvent(
      runtimeEvent("wrong-session", { type: "turn.failed", _turnProvenance: cronProvenance(job.id) }),
    );
    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, {
        type: "turn.failed",
        _turnProvenance: { ...cronProvenance(job.id), automationId: "cron:wrong-job" },
      }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBeUndefined();
  });

  it("uses the admitted owner and unique run id for reports after edits and deletion", async () => {
    const contact = createContact({ name: "Admitted owner", phone: "5511900000106" });
    const job = createAgentJob({ ownerPrincipal: `contact:${contact.id}` });
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    await runner.triggerJob(job.id);
    dbUpdateCronJob(job.id, { ownerPrincipal: "operator" });
    const { dbDeleteCronJob } = await import("./cron-db.js");
    dbDeleteCronJob(job.id);
    for (const index of [0, 1, 0]) {
      await new CronRunner().handleRuntimeEvent(
        runtimeEvent(publishCalls[index]!.sessionName, {
          type: "turn.failed",
          error: "safe diagnostic",
          _turnProvenance: cronProvenance(job.id, index),
        }),
      );
    }
    const { listLocalInboxItems } = await import("../inbox/local-db.js");
    const items = listLocalInboxItems({ sourceDomain: "cron" });
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.metadata.ownerPrincipal).toBe(`contact:${contact.id}`);
  });

  it("deletes a successful one-shot only when every admitted run is terminal", async () => {
    const job = createAgentJob({ schedule: { type: "at", at: Date.now() }, deleteAfterRun: true });
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    await runner.triggerJob(job.id);
    const sessionName = publishCalls[0]!.sessionName;
    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.complete", _turnProvenance: cronProvenance(job.id, 1) }),
    );
    expect(dbGetCronJob(job.id)).not.toBeNull();
    await runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.complete", _turnProvenance: cronProvenance(job.id, 0) }),
    );
    expect(dbGetCronJob(job.id)).toBeNull();
  });
});
