import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

afterAll(() => mock.restore());

const emittedEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
const subscribedTopics: string[] = [];
let publishError: Error | null = null;

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
  }),
}));

const { CronRunner } = await import("./runner.js");
const { dbCreateCronJob, dbGetCronJob, dbMarkJobDispatched, dbUpdateJobState } = await import("./cron-db.js");
const { CRON_RUNTIME_EVENTS_TOPIC } = await import("./turn-outcome.js");

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-cron-runner-test-");
  emittedEvents.length = 0;
  publishCalls.length = 0;
  subscribedTopics.length = 0;
  publishError = null;
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

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

function cronProvenance(jobId: string) {
  return {
    origin: "cron",
    background: true,
    automationOriginated: true,
    automationId: `cron:${jobId}`,
    reason: "prompt._cron",
  };
}

function runtimeEvent(sessionName: string, data: Record<string, unknown>) {
  return { topic: `ravi.session.${sessionName}.runtime`, data };
}

describe("CronRunner agent job outcome tracking", () => {
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

    runner.handleRuntimeEvent(
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

  it("records ok only after the turn completes", async () => {
    const job = createAgentJob({ sessionTarget: "main" });
    const runner = new CronRunner();

    await runner.triggerJob(job.id);
    const { sessionName } = publishCalls[0]!;
    expect(dbGetCronJob(job.id)?.lastStatus).toBeUndefined();

    runner.handleRuntimeEvent(
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
    runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.failed", error: "boom", _turnProvenance: cronProvenance(job.id) }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("error");

    await runner.triggerJob(job.id);
    const redispatched = dbGetCronJob(job.id)!;
    expect(redispatched.lastStatus).toBeUndefined();
    expect(redispatched.lastError).toBeUndefined();

    runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.complete", _turnProvenance: cronProvenance(job.id) }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("ok");
  });

  it("records interrupted turns as errors", async () => {
    const job = createAgentJob();
    const runner = new CronRunner();

    await runner.triggerJob(job.id);
    const { sessionName } = publishCalls[0]!;
    runner.handleRuntimeEvent(
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

    runner.handleRuntimeEvent(
      runtimeEvent(sessionName, {
        type: "turn.failed",
        error: "human turn failed",
        _turnProvenance: { origin: "human", background: false, automationOriginated: false, reason: "contact" },
      }),
    );
    runner.handleRuntimeEvent(
      runtimeEvent(sessionName, {
        type: "turn.complete",
        _turnProvenance: { origin: "trigger", automationId: "trigger:t1", background: true, reason: "x" },
      }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBeUndefined();

    runner.handleRuntimeEvent(
      runtimeEvent(sessionName, { type: "turn.complete", _turnProvenance: cronProvenance(job.id) }),
    );
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("ok");
  });

  it("attributes pre-turn failures without provenance to the pending dispatch on that session", async () => {
    const job = createAgentJob();
    const other = createAgentJob();
    const runner = new CronRunner();

    await runner.triggerJob(job.id);
    await runner.triggerJob(other.id);
    const jobSession = publishCalls[0]!.sessionName;
    const otherSession = publishCalls[1]!.sessionName;
    expect(jobSession).not.toBe(otherSession);

    runner.handleRuntimeEvent(
      runtimeEvent(jobSession, {
        type: "turn.failed",
        error: "Runtime failed to start: spawn ENOENT",
        recoverable: false,
      }),
    );

    expect(dbGetCronJob(job.id)).toMatchObject({
      lastStatus: "error",
      lastError: "Runtime failed to start: spawn ENOENT",
    });
    expect(dbGetCronJob(other.id)?.lastStatus).toBeUndefined();

    // A pending dispatch is consumed once; a later unrelated launch failure on
    // the same session is not re-attributed to the finished run.
    runner.handleRuntimeEvent(runtimeEvent(jobSession, { type: "turn.complete" }));
    runner.handleRuntimeEvent(runtimeEvent(jobSession, { type: "turn.failed", error: "later failure" }));
    expect(dbGetCronJob(job.id)?.lastError).toBe("Runtime failed to start: spawn ENOENT");
  });

  it("records provenance-correlated outcomes even without an in-memory pending dispatch", () => {
    const job = createAgentJob();
    const runner = new CronRunner();
    const dispatchedAt = Date.now() - 4_000;
    dbMarkJobDispatched(job.id, { lastRunAt: dispatchedAt, nextRunAt: dispatchedAt + 60_000 });

    runner.handleRuntimeEvent(
      runtimeEvent("test-agent", {
        type: "turn.failed",
        error: "400 model not supported",
        _turnProvenance: cronProvenance(job.id),
      }),
    );

    const failed = dbGetCronJob(job.id)!;
    expect(failed.lastStatus).toBe("error");
    expect(failed.lastError).toBe("400 model not supported");
    expect(failed.lastDurationMs).toBeGreaterThanOrEqual(4_000);
  });

  it("does not let shell on-error notification turns overwrite the shell result", () => {
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

    runner.handleRuntimeEvent(
      runtimeEvent("ops", { type: "turn.complete", _turnProvenance: cronProvenance(shellJob.id) }),
    );

    expect(dbGetCronJob(shellJob.id)).toMatchObject({
      lastStatus: "error",
      lastError: "Shell command failed with exit code 1",
      lastExitCode: 1,
    });
  });

  it("ignores outcomes for unknown jobs and non-terminal events", () => {
    const job = createAgentJob();
    const runner = new CronRunner();
    dbMarkJobDispatched(job.id, { lastRunAt: Date.now() });

    runner.handleRuntimeEvent(
      runtimeEvent("test-agent", { type: "turn.failed", error: "x", _turnProvenance: cronProvenance("missing") }),
    );
    runner.handleRuntimeEvent(
      runtimeEvent("test-agent", { type: "assistant.message", text: "hi", _turnProvenance: cronProvenance(job.id) }),
    );
    runner.handleRuntimeEvent({ topic: "ravi.session.test-agent.response", data: { type: "turn.failed", error: "x" } });

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
