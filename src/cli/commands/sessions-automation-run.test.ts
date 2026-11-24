import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getOrCreateSession } from "../../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

afterAll(() => mock.restore());

const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

mock.module("../../omni/session-stream.js", () => ({
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  }),
}));

const { SessionCommands, sessionCloseThreadReturnSchema, sessionReportReturnSchema } = await import("./sessions.js");
const { closeChildRun, getChildRun, openChildRun } = await import("../../automation/child-runs.js");
const { getDb } = await import("../../router/router-db.js");

let stateDir: string | null = null;

// The first isolated state builds the whole schema; give it room on a loaded machine.
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sessions-automation-run-");
  publishCalls.length = 0;
}, 20_000);

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const PARENT_KEY = "agent:test-agent:whatsapp:main:group:120363000000000001";
const CHILD_KEY = "agent:test-agent:cron:job1:run:run-1";

function openRun() {
  getOrCreateSession(PARENT_KEY, "test-agent", stateDir!, { name: "grupo-updates" });
  getOrCreateSession(CHILD_KEY, "test-agent", stateDir!, { name: "test-agent-cron-updates-run1" });
  return openChildRun({
    id: "run-1",
    originKind: "cron",
    originId: "job1",
    originName: "updates",
    agentId: "test-agent",
    parentSessionKey: PARENT_KEY,
    parentSessionName: "grupo-updates",
    childSessionKey: CHILD_KEY,
    childSessionName: "test-agent-cron-updates-run1",
  });
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = original;
  }
}

describe("sessions report / close-thread inside an automation run", () => {
  it("close-thread --return closes the run and returns to its parent once", async () => {
    openRun();
    const payload = await quietly(() =>
      new SessionCommands().closeThread("Post novo: release saiu", "test-agent-cron-updates-run1", true),
    );

    expect(payload).toMatchObject({
      actionId: "thread.close",
      changed: true,
      runId: "run-1",
      surface: "headless",
      parentReturn: { requested: true, delivered: true, pending: false },
      parentSession: { sessionKey: PARENT_KEY, sessionName: "grupo-updates" },
    });
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]!.sessionName).toBe("grupo-updates");
    expect(String(publishCalls[0]!.payload.prompt)).toContain("Resultado: Post novo: release saiu");
    expect(getChildRun("run-1")).toMatchObject({ status: "closed", returnState: "returned", returnKind: "result" });
    // The gateway validates the declared return shape.
    expect(sessionCloseThreadReturnSchema.safeParse(payload).success).toBe(true);

    // A second return on the closed run fails loudly instead of being dropped.
    await expect(
      quietly(() => new SessionCommands().closeThread("outro", "test-agent-cron-updates-run1", true)),
    ).rejects.toThrow(/already closed; this return was not delivered/);
    expect(publishCalls).toHaveLength(1);
  });

  it("close-thread without --return closes silently", async () => {
    openRun();
    const payload = await quietly(() =>
      new SessionCommands().closeThread(undefined, "test-agent-cron-updates-run1", true),
    );

    expect(payload).toMatchObject({ changed: true, parentReturn: { requested: false, delivered: false } });
    expect(publishCalls).toHaveLength(0);
    expect(getChildRun("run-1")).toMatchObject({ status: "closed", returnState: "silent" });
  });

  it("report sends progress to the parent and keeps the run open", async () => {
    openRun();
    const payload = await quietly(() =>
      new SessionCommands().report("li 3 posts, nenhum novo", "test-agent-cron-updates-run1", true),
    );

    expect(payload).toMatchObject({ status: "published", actionId: "thread.report", runId: "run-1" });
    expect(sessionReportReturnSchema.safeParse(payload).success).toBe(true);
    expect(publishCalls).toHaveLength(1);
    expect(String(publishCalls[0]!.payload.prompt)).toContain("Progresso: li 3 posts, nenhum novo");
    expect(getChildRun("run-1")).toMatchObject({ status: "open", returnState: "none" });
  });

  it("retries only the very return still pending, never a different one", async () => {
    openRun();
    // Closed with return A whose delivery failed: A is pending.
    getDb()
      .query(
        "UPDATE automation_child_runs SET status = 'closed', return_state = 'pending', return_kind = 'result', return_text = 'A' WHERE id = 'run-1'",
      )
      .run();

    await expect(
      quietly(() => new SessionCommands().closeThread("B", "test-agent-cron-updates-run1", true)),
    ).rejects.toThrow(/already closed; this return was not delivered/);
    expect(publishCalls).toHaveLength(0);

    const payload = await quietly(() => new SessionCommands().closeThread("A", "test-agent-cron-updates-run1", true));
    expect(payload).toMatchObject({ changed: false, parentReturn: { delivered: true, pending: false } });
    expect(String(publishCalls[0]!.payload.prompt)).toContain("Resultado: A");
    expect(getChildRun("run-1")).toMatchObject({ returnState: "returned" });
  });

  it("refuses a return when the runner closed the run silently in between", async () => {
    const run = openRun();
    // The runner's end-of-turn close lands after the command read the run as open.
    await closeChildRun(getChildRun("run-1")!, null);

    await expect(quietly(() => new SessionCommands()["closeAutomationRun"](run, "tarde demais", true))).rejects.toThrow(
      /already closed; this return was not delivered/,
    );
    expect(publishCalls).toHaveLength(0);
  });

  it("refuses the Slack-only wait flags inside a run", async () => {
    openRun();
    await expect(
      quietly(() => new SessionCommands().report("esperando", "test-agent-cron-updates-run1", true, "decision")),
    ).rejects.toThrow(/apply to Slack threads/);
    expect(publishCalls).toHaveLength(0);
  });
});
