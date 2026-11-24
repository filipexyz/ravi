import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getOrCreateSession } from "../../router/index.js";
import { dbCreateAgent, dbUpsertChannel, dbUpsertChat, getDb } from "../../router/router-db.js";
import { attachChatToSession, getSession } from "../../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  childRunSurfaceRef,
  closeChildRun,
  getChildRun,
  openChildRun,
  pendingChildRunSession,
} from "../../automation/child-runs.js";
import {
  createSlackThreadLifecycle,
  getSlackThreadLifecycle,
  markSlackThreadRootDelivered,
} from "./thread-lifecycle-store.js";
import { finalizeSlackThreadCreation } from "./thread-lifecycle.js";
import { resolveSlackRunTarget } from "./automation-surface.js";
import { closeSlackThreadFromCommand } from "./slash-command-handler.js";

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
const REF = childRunSurfaceRef("run-1");

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
    surfaceRef: REF,
    launch: LAUNCH,
  });
  createSlackThreadLifecycle({
    requestId: REF,
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
    requestId: REF,
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

    const result = await finalizeSlackThreadCreation(REF, deps);

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
    await finalizeSlackThreadCreation(REF, deps);
    expect(prompts).toHaveLength(1);
  });

  it("still starts the run when its creation is retried after the launch failed to publish, with the same message id", async () => {
    seedRunThread();
    const messageIds: string[] = [];
    let brokerDown = true;
    const deps = {
      publishPrompt: mock(
        async (_session: string, _payload: Record<string, unknown>, options?: { messageId?: string }) => {
          if (brokerDown) {
            brokerDown = false;
            throw new Error("broker unavailable");
          }
          messageIds.push(options?.messageId ?? "");
        },
      ),
      publishEvent: mock(async () => {}),
    };

    await expect(finalizeSlackThreadCreation(REF, deps)).rejects.toThrow("broker unavailable");
    // Bound already: the retry is the same session, and it must still get the launch.
    expect(getChildRun("run-1")?.childSessionKey).toBe("ravi-parent:thread:1713000000.000200");

    await finalizeSlackThreadCreation(REF, deps);
    expect(messageIds).toEqual([`slack-thread-start:${REF}`]);
  });

  it("starts nothing in the late thread of a run closed before its root landed, and closes that thread", async () => {
    seedRunThread();
    await closeChildRun(getChildRun("run-1")!, null);
    const deps = { publishPrompt: mock(async () => {}), publishEvent: mock(async () => {}) };

    const result = await finalizeSlackThreadCreation(REF, deps);

    expect(result.status).toBe("opened");
    expect(deps.publishPrompt).not.toHaveBeenCalled();
    expect(getChildRun("run-1")?.childSessionKey).toBe(pendingChildRunSession("run-1"));
    expect(getSlackThreadLifecycle(REF)?.status).toBe("closed");
  });

  it("never starts a run's late thread as an ordinary one when the run's row is gone", async () => {
    seedRunThread();
    getDb().query("DELETE FROM automation_child_runs WHERE id = ?").run("run-1");
    const deps = { publishPrompt: mock(async () => {}), publishEvent: mock(async () => {}) };

    await finalizeSlackThreadCreation(REF, deps);

    // Neither the launch nor the agent's bootstrap: the title is not an instruction.
    expect(deps.publishPrompt).not.toHaveBeenCalled();
    expect(getSlackThreadLifecycle(REF)?.status).toBe("closed");
  });

  it("closes the run, without a return, when a person closes its thread", async () => {
    seedRunThread();
    const deps = { publishPrompt: mock(async () => {}), publishEvent: mock(async () => {}) };
    const opened = await finalizeSlackThreadCreation(REF, deps);
    expect(getChildRun("run-1")?.status).toBe("open");

    const result = await closeSlackThreadFromCommand("ravi-parent", opened.childSessionName!, undefined, deps);

    expect(result).toMatchObject({ kind: "closed", changed: true });
    expect(getSlackThreadLifecycle(REF)?.status).toBe("closed");
    expect(getChildRun("run-1")).toMatchObject({ status: "closed", returnState: "silent" });
  });

  it("shows a run only in the chat its parent answers in, never in another chat attached to it", () => {
    dbCreateAgent({ id: "ravi", cwd: "/tmp/ravi" });
    dbUpsertChannel({ name: "slack-instance-1", provider: "slack", credentialConnection: "installation-a" });
    const chat = (platformChatId: string, channel = "slack", instanceId = "slack-instance-1") =>
      dbUpsertChat({ channel, instanceId, platformChatId, chatType: channel === "slack" ? "channel" : "group" });

    // Answers in a private WhatsApp group; a Slack channel is attached for input only.
    const privateParent = getOrCreateSession("ravi-private", "ravi", "/tmp/ravi", { name: "ravi-private" });
    attachChatToSession({
      sessionKey: privateParent.sessionKey,
      chatId: chat("120363@g.us", "whatsapp", "wa-1").id,
      role: "primary",
      setOutputTarget: true,
    });
    attachChatToSession({
      sessionKey: privateParent.sessionKey,
      chatId: chat("C123").id,
      role: "input",
      setOutputTarget: false,
    });
    expect(resolveSlackRunTarget(getSession(privateParent.sessionKey)!)).toBeNull();

    // Answers in a Slack channel: the run shows there.
    const slackParent = getOrCreateSession("ravi-slack", "ravi", "/tmp/ravi", { name: "ravi-slack" });
    attachChatToSession({
      sessionKey: slackParent.sessionKey,
      chatId: chat("C456").id,
      role: "primary",
      setOutputTarget: true,
    });
    expect(resolveSlackRunTarget(getSession(slackParent.sessionKey)!)).toMatchObject({
      platformChatId: "C456",
      accountId: "slack-instance-1",
    });
  });

  it("shows nothing for a parent with no Slack chat", () => {
    dbCreateAgent({ id: "ravi", cwd: "/tmp/ravi" });
    const parent = getOrCreateSession("agent:ravi:whatsapp:main:group:1", "ravi", "/tmp/ravi", { name: "grupo" });
    expect(resolveSlackRunTarget(parent)).toBeNull();
  });
});
