import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSession } from "../router/sessions.js";
import { createContact, deleteContact, setContactStatus } from "../contacts.js";
import { pickRuntimeTurnAuthorityEnvelope } from "../runtime/delivery-queue.js";
import { CRON_RUN_AUTHORITY_ENV } from "./authority.js";
import { accessActorFromTurn } from "../access/actor.js";
import { buildRuntimeRequestContext } from "../runtime/runtime-request-context.js";
import type { RuntimeLaunchPrompt } from "../runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

afterAll(() => mock.restore());

const emittedEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
const subscribedTopics: string[] = [];
let publishError: Error | null = null;
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
    onPublish?.();
  }),
}));

const { CronRunner } = await import("./runner.js");
const { resolveConnectorTurn } = await import("../link/connector-turn.js");
const { dbCreateCronJob, dbGetCronJob, dbMarkJobDispatched, dbUpdateJobState, dbUpdateCronJob } = await import(
  "./cron-db.js"
);
const { CRON_RUNTIME_EVENTS_TOPIC } = await import("./turn-outcome.js");

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-cron-runner-test-");
  emittedEvents.length = 0;
  publishCalls.length = 0;
  subscribedTopics.length = 0;
  publishError = null;
  onPublish = null;
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
    await new CronRunner().triggerJob(job.id);
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
    // The env file cannot rename the automation the command acts for.
    writeFileSync(
      envFile,
      `RAVI_AUTOMATION_PRINCIPAL=automation:cron:someone-else\n${CRON_RUN_AUTHORITY_ENV}=invalid\n`,
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
    dbUpdateCronJob(operatorJob.jobId, { ownerPrincipal: "unknown" });
    const allowed = resolveConnectorTurn({ ...owner, env: operatorJob.env });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.turn).toMatchObject({
        speaker: { kind: "automation" },
        routine: { kind: "cron", id: operatorJob.jobId },
      });
    }
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
