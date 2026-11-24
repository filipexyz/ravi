import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getOrCreateSession, getSession, resolveSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

afterAll(() => mock.restore());

const emittedEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

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
    subscribe: mock(() => (async function* () {})()),
    close: mock(async () => {}),
  },
}));

mock.module("../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  }),
}));

const { CronRunner, THREAD_RUN_STALE_MS } = await import("./runner.js");
const { getDb } = await import("../router/router-db.js");
const { dbCreateCronJob, dbGetCronJob } = await import("./cron-db.js");
const { getCronRun } = await import("./run-db.js");
const { closeChildRun, getChildRun, listChildRunsForOrigin, openChildRun, pruneClosedChildRuns } = await import(
  "../automation/child-runs.js"
);
const { saveMessage } = await import("../db.js");

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-cron-thread-test-");
  emittedEvents.length = 0;
  publishCalls.length = 0;
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const PARENT_KEY = "agent:test-agent:whatsapp:main:group:120363000000000000";

function createParent(key = PARENT_KEY, agentId = "test-agent", name = "grupo-updates") {
  return getOrCreateSession(key, agentId, stateDir!, { name });
}

function createThreadJob(overrides: Partial<Parameters<typeof dbCreateCronJob>[0]> = {}) {
  return dbCreateCronJob({
    name: `updates-${Math.random().toString(36).slice(2, 8)}`,
    schedule: { type: "every", every: 60_000 },
    message: "read the blog and post what matters",
    agentId: "test-agent",
    sessionTarget: "thread",
    replySession: PARENT_KEY,
    ownerPrincipal: "operator",
    ...overrides,
  });
}

/** The run prompt the runner published, the last one for that job. */
function runDispatch(jobId: string) {
  const call = [...publishCalls].reverse().find((entry) => entry.payload._jobId === jobId);
  if (!call) throw new Error(`no run dispatched for ${jobId}`);
  return { sessionName: call.sessionName, runId: String(call.payload._cronRunId), payload: call.payload };
}

function parentReturns() {
  return publishCalls.filter((call) => call.payload._automationChildRun !== undefined);
}

async function endTurn(runner: InstanceType<typeof CronRunner>, jobId: string, type: string, extra = {}) {
  const run = runDispatch(jobId);
  await runner.handleRuntimeEvent({
    topic: `ravi.session.${run.sessionName}.runtime`,
    data: {
      type,
      ...extra,
      _turnProvenance: {
        origin: "cron",
        background: true,
        automationOriginated: true,
        automationId: `cron:${jobId}`,
        cronRunId: run.runId,
        reason: "prompt._cron",
      },
    },
  });
  return run;
}

describe("cron thread mode", () => {
  it("opens a fresh child session for every run, parented to the reply session", async () => {
    createParent();
    const job = createThreadJob();
    const runner = new CronRunner();

    await runner.triggerJob(job.id);
    const first = runDispatch(job.id);
    await runner.triggerJob(job.id);
    const second = runDispatch(job.id);

    expect(first.sessionName).not.toBe(second.sessionName);
    for (const run of [first, second]) {
      const child = resolveSession(run.sessionName)!;
      expect(child.sessionKey).toBe(`agent:test-agent:cron:${job.id}:run:${run.runId}`);
      // Named after the whole run id: never the name (and history) of an earlier, pruned run.
      expect(run.sessionName).toBe(`test-agent-run-${run.runId}`);
      expect(child.agentId).toBe("test-agent");
      // Headless: no source, so the run's own replies reach no chat.
      expect(run.payload.source).toBeUndefined();
      expect(run.payload._cronAuthority).toMatchObject({ jobId: job.id, ownerPrincipal: "operator" });
      expect(String(run.payload.prompt)).toContain("read the blog and post what matters");
      expect(String(run.payload.prompt)).toContain("ravi sessions close-thread --return");
      expect(getChildRun(run.runId)).toMatchObject({
        status: "open",
        returnState: "none",
        parentSessionKey: PARENT_KEY,
        parentSessionName: "grupo-updates",
        childSessionName: run.sessionName,
      });
    }
  });

  it("closes silently when the run replied nothing, and releases the child's runtime", async () => {
    createParent();
    const job = createThreadJob();
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    const run = await endTurn(runner, job.id, "turn.complete");

    expect(getChildRun(run.runId)).toMatchObject({ status: "closed", returnState: "silent" });
    expect(parentReturns()).toHaveLength(0);
    expect(getCronRun(run.runId)?.status).toBe("ok");
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("ok");
    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        topic: "ravi.session.abort",
        data: expect.objectContaining({ sessionName: run.sessionName, reason: "automation_child_run_closed" }),
      }),
    );
  });

  it("returns the run's final reply to the parent once when it did not close itself", async () => {
    createParent();
    const job = createThreadJob();
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    const { sessionName } = runDispatch(job.id);
    // A headless run's reply reaches no chat; the runtime keeps it in the run's own history.
    saveMessage(sessionName, "assistant", "Post novo no blog: release 3.261124.1 saiu", null, {
      utteranceClass: "final",
    });
    const run = await endTurn(runner, job.id, "turn.complete");

    const returns = parentReturns();
    expect(returns).toHaveLength(1);
    expect(returns[0]!.sessionName).toBe("grupo-updates");
    expect(String(returns[0]!.payload.prompt)).toContain("\n> Post novo no blog: release 3.261124.1 saiu");
    expect(returns[0]!.payload._turnOrigin).toMatchObject({ action: "session.return" });
    expect(getChildRun(run.runId)).toMatchObject({ status: "closed", returnState: "returned", returnKind: "auto" });
  });

  it("closes silently when the run's final reply is @@SILENT@@", async () => {
    createParent();
    const job = createThreadJob();
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    saveMessage(runDispatch(job.id).sessionName, "assistant", "@@SILENT@@", null, { utteranceClass: "final" });
    const run = await endTurn(runner, job.id, "turn.complete");

    expect(parentReturns()).toHaveLength(0);
    expect(getChildRun(run.runId)).toMatchObject({ status: "closed", returnState: "silent" });
  });

  it("does not return twice when the run closed itself with a result", async () => {
    createParent();
    const job = createThreadJob();
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    const { runId, sessionName } = runDispatch(job.id);
    saveMessage(sessionName, "assistant", "texto final que não deve virar segundo retorno", null, {
      utteranceClass: "final",
    });
    await closeChildRun(getChildRun(runId)!, { kind: "result", text: "resultado explícito" });
    await endTurn(runner, job.id, "turn.complete");

    const returns = parentReturns();
    expect(returns).toHaveLength(1);
    expect(String(returns[0]!.payload.prompt)).toContain("\n> resultado explícito");
    expect(getChildRun(runId)).toMatchObject({ status: "closed", returnState: "returned", returnKind: "result" });
  });

  it("sends one error return when the run's turn fails", async () => {
    createParent();
    const job = createThreadJob();
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    const run = await endTurn(runner, job.id, "turn.failed", { error: "provider refused the model" });

    const returns = parentReturns();
    expect(returns).toHaveLength(1);
    expect(String(returns[0]!.payload.prompt)).toContain("falhou.");
    // The parent may relay it to a shared chat: a classified reason, never the provider's raw text.
    expect(String(returns[0]!.payload.prompt)).toContain("\n> erro de execução");
    expect(String(returns[0]!.payload.prompt)).not.toContain("provider refused the model");
    expect(getChildRun(run.runId)).toMatchObject({ status: "closed", returnState: "error" });
    expect(dbGetCronJob(job.id)?.lastStatus).toBe("error");
  });

  it("refuses a report-to session of another agent and opens no child", async () => {
    createParent("agent:other-agent:main", "other-agent", "other-agent");
    const job = createThreadJob({ replySession: "agent:other-agent:main" });
    await new CronRunner().triggerJob(job.id);

    expect(publishCalls.filter((call) => call.payload._jobId === job.id)).toHaveLength(0);
    expect(listChildRunsForOrigin("cron", job.id)).toHaveLength(0);
    const stored = dbGetCronJob(job.id)!;
    expect(stored.lastStatus).toBe("error");
    expect(stored.lastError).toContain("THREAD_PARENT_OTHER_AGENT");
  });

  it("refuses a report-to session that is another run's own session, and opens no child", async () => {
    createParent();
    const first = createThreadJob();
    const runner = new CronRunner();
    await runner.triggerJob(first.id);
    const runSession = resolveSession(runDispatch(first.id).sessionName)!;
    const job = createThreadJob({ replySession: runSession.sessionKey });

    await runner.triggerJob(job.id);

    expect(publishCalls.filter((call) => call.payload._jobId === job.id)).toHaveLength(0);
    expect(listChildRunsForOrigin("cron", job.id)).toHaveLength(0);
    expect(dbGetCronJob(job.id)!.lastError).toContain("THREAD_PARENT_UNSTABLE");
  });

  it("reports to the agent's main session when the job has no reply session", async () => {
    const job = createThreadJob({ replySession: undefined });
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    const { runId } = runDispatch(job.id);

    const run = getChildRun(runId)!;
    expect(run.parentSessionKey).toBe("agent:test-agent:main");
    expect(getSession(run.parentSessionKey)?.agentId).toBe("test-agent");
  });

  it("skips a scheduled run while the previous one is open; a manual run still goes", async () => {
    createParent();
    const job = createThreadJob();
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    const dispatched = publishCalls.length;

    await runner["executeJob"](dbGetCronJob(job.id)!, true);

    expect(publishCalls).toHaveLength(dispatched);
    expect(listChildRunsForOrigin("cron", job.id)).toHaveLength(1);
    expect(dbGetCronJob(job.id)!.nextRunAt).toBeGreaterThan(Date.now());

    await runner.triggerJob(job.id);
    expect(listChildRunsForOrigin("cron", job.id)).toHaveLength(2);
  });

  it("closes a run left open past the stale limit as failed, then runs again", async () => {
    createParent();
    const job = createThreadJob();
    const runner = new CronRunner();
    await runner.triggerJob(job.id);
    const stale = runDispatch(job.id);
    getDb()
      .query("UPDATE automation_child_runs SET created_at = ? WHERE id = ?")
      .run(Date.now() - THREAD_RUN_STALE_MS - 1, stale.runId);

    await runner["executeJob"](dbGetCronJob(job.id)!, true);

    expect(getChildRun(stale.runId)).toMatchObject({ status: "closed", returnState: "error" });
    expect(parentReturns()).toHaveLength(1);
    expect(String(parentReturns()[0]!.payload.prompt)).toContain("did not end within 120 min");
    expect(runDispatch(job.id).runId).not.toBe(stale.runId);
  });

  it("tells a trigger's owner when its run's return is given up after a day", async () => {
    const { dbCreateTrigger } = await import("../triggers/triggers-db.js");
    createParent();
    const trigger = dbCreateTrigger({
      name: "blog-watch",
      agentId: "test-agent",
      topic: "ravi.test.blog",
      message: "read the blog",
      session: "thread",
      replySession: PARENT_KEY,
      ownerPrincipal: "operator",
      cooldownMs: 0,
    });
    const childKey = `agent:test-agent:trigger:${trigger.id}:run:tr-1`;
    getOrCreateSession(childKey, "test-agent", stateDir!, { name: "test-agent-run-tr-1" });
    openChildRun({
      id: "tr-1",
      originKind: "trigger",
      originId: trigger.id,
      originName: trigger.name,
      agentId: "test-agent",
      parentSessionKey: PARENT_KEY,
      parentSessionName: "grupo-updates",
      childSessionKey: childKey,
      childSessionName: "test-agent-run-tr-1",
    });
    // Closed a day and more ago with a return that never reached the parent.
    getDb()
      .query(
        "UPDATE automation_child_runs SET status = 'closed', return_state = 'pending', return_kind = 'result', return_text = 'x', closed_at = ? WHERE id = 'tr-1'",
      )
      .run(Date.now() - 25 * 60 * 60_000);
    const { listLocalInboxItems } = await import("../inbox/local-db.js");
    const notice = () =>
      listLocalInboxItems().find(
        (item) => item.sourceType === "run_return_undelivered" && item.sourceId === trigger.id,
      );
    const runner = new CronRunner();

    // The real notice, no module mock (one would leak into other files of the same process): with no
    // owner chat here, it is recorded in the inbox and settled.
    await runner.start();
    try {
      const deadline = Date.now() + 3_000;
      while (!notice() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    } finally {
      await runner.stop();
    }

    expect(notice()).toMatchObject({ sourceDomain: "triggers", sourceId: trigger.id });
    expect(notice()!.metadata).toMatchObject({ runId: "tr-1", originKind: "trigger", ownerPrincipal: "operator" });
    expect(getChildRun("tr-1")).toMatchObject({ returnState: "error" });
  });

  it("prunes a job's oldest closed runs, sessions included", async () => {
    createParent();
    const job = createThreadJob();
    const runner = new CronRunner();
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      await runner.triggerJob(job.id);
      const run = await endTurn(runner, job.id, "turn.complete");
      runs.push(run.runId);
    }
    const oldest = getChildRun(runs[0]!)!;

    const pruned = pruneClosedChildRuns("cron", job.id, 2);

    expect(pruned).toEqual([oldest.childSessionKey]);
    expect(getChildRun(runs[0]!)).toBeNull();
    expect(getSession(oldest.childSessionKey)).toBeNull();
    expect(listChildRunsForOrigin("cron", job.id).map((run) => run.id)).toEqual([runs[2], runs[1]]);
  });
});
