import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getOrCreateSession } from "../../router/index.js";
import { dbCreateAgent, dbUpsertChat } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { getChildRun, openChildRun, pendingChildRunSession } from "../../automation/child-runs.js";
import { createSlackThreadLifecycle, markSlackThreadRootDelivered } from "./thread-lifecycle-store.js";
import { finalizeSlackThreadCreation } from "./thread-lifecycle.js";
import { resolveSlackRunTarget } from "./automation-surface.js";

let stateDir: string | null = null;

// The first isolated state builds the whole schema; give it room on a loaded machine.
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-slack-automation-surface-");
}, 20_000);

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const LAUNCH = {
  prompt: "[Cron: updates 24/11]\nread the blog",
  deliveryBarrier: "after_response",
  deliveryBarrierSource: "default",
  _cron: true,
  _jobId: "job-1",
  _cronAuthority: { jobId: "job-1", ownerPrincipal: "contact:c1", ownerIsOperator: false },
  _cronRunId: "run-1",
};

function seedRunThread() {
  dbCreateAgent({ id: "ravi", cwd: "/tmp/ravi" });
  getOrCreateSession("ravi-parent", "ravi", "/tmp/ravi", { name: "ravi-parent", chatType: "channel" });
  const rootChat = dbUpsertChat({
    channel: "slack",
    instanceId: "slack-instance-1",
    platformChatId: "C123",
    chatType: "channel",
  });
  openChildRun({
    id: "run-1",
    originKind: "cron",
    originId: "job-1",
    originName: "updates",
    agentId: "ravi",
    parentSessionKey: "ravi-parent",
    parentSessionName: "ravi-parent",
    childSessionKey: pendingChildRunSession("run-1"),
    childSessionName: pendingChildRunSession("run-1"),
    surface: "slack-thread",
    surfaceRef: "slack-thread:run-1",
    launch: LAUNCH,
  });
  createSlackThreadLifecycle({
    requestId: "slack-thread:run-1",
    parentSessionKey: "ravi-parent",
    parentSessionName: "ravi-parent",
    accountId: "slack-instance-1",
    instanceId: "slack-instance-1",
    platformChatId: "C123",
    rootCanonicalChatId: rootChat.id,
    initialPrompt: "Execução do cron “updates”",
    requestedBy: "cron updates",
  });
  markSlackThreadRootDelivered({
    requestId: "slack-thread:run-1",
    providerThreadId: "1713000000.000200",
    canonicalRootMessageId: "cm_root",
  });
}

describe("Slack surface for automation runs", () => {
  it("starts an automation run's thread with the run's own launch, never the agent's bootstrap", async () => {
    seedRunThread();
    const prompts: Array<{ session: string; payload: Record<string, unknown> }> = [];
    const deps = {
      publishPrompt: mock(async (session: string, payload: Record<string, unknown>) => {
        prompts.push({ session, payload });
      }),
      publishEvent: mock(async () => {}),
    };

    const result = await finalizeSlackThreadCreation("slack-thread:run-1", deps);

    expect(result).toMatchObject({ status: "opened", childSessionKey: "ravi-parent:thread:1713000000.000200" });
    expect(prompts).toHaveLength(1);
    const { session, payload } = prompts[0]!;
    expect(session).toBe(result.childSessionName!);
    // The job's envelope, as a headless run gets it; no bootstrap origin, no "[System] Execute" wrapper.
    expect(payload).toMatchObject({
      prompt: LAUNCH.prompt,
      _cron: true,
      _cronRunId: "run-1",
      _cronAuthority: LAUNCH._cronAuthority,
    });
    expect(payload._turnOrigin).toBeUndefined();
    expect(String(payload.prompt)).not.toContain("[System] Execute");
    expect(payload.source).toMatchObject({ channel: "slack", chatId: "C123", threadId: "1713000000.000200" });
    expect(getChildRun("run-1")).toMatchObject({
      childSessionKey: "ravi-parent:thread:1713000000.000200",
      childSessionName: result.childSessionName,
    });

    // A replayed finalization publishes nothing more.
    await finalizeSlackThreadCreation("slack-thread:run-1", deps);
    expect(prompts).toHaveLength(1);
  });

  it("shows nothing for a parent with no Slack chat", () => {
    dbCreateAgent({ id: "ravi", cwd: "/tmp/ravi" });
    const parent = getOrCreateSession("agent:ravi:whatsapp:main:group:1", "ravi", "/tmp/ravi", { name: "grupo" });
    expect(resolveSlackRunTarget(parent)).toBeNull();
  });
});
