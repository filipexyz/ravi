import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { PublishSessionPromptOptions } from "../../omni/session-stream.js";
import { getOrCreateSession, getSession, listSessionSubscriptions } from "../../router/index.js";
import { dbUpsertChat } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  closeSlackThread,
  deliverSlackThreadParentReturn,
  finalizeSlackThreadCreation,
  registerSlackThreadInboundLifecycle,
} from "./thread-lifecycle.js";
import {
  claimSlackThreadCreation,
  completeSlackThreadCreation,
  createSlackThreadLifecycle,
  findSlackThreadLifecycleByChildSession,
  getSlackThreadLifecycle,
  markSlackThreadRootDelivered,
} from "./thread-lifecycle-store.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-slack-thread-lifecycle-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("Slack thread lifecycle", () => {
  it("materializes one child turn after durable root delivery and applies its model first", async () => {
    const fixture = seedPendingCreation();
    const prompts: Array<{
      sessionName: string;
      payload: Record<string, unknown>;
      options?: PublishSessionPromptOptions;
    }> = [];
    const events: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const dependencies = {
      publishPrompt: mock(
        async (sessionName: string, payload: Record<string, unknown>, options?: PublishSessionPromptOptions) => {
          prompts.push({ sessionName, payload, options });
        },
      ),
      publishEvent: mock(async (topic: string, payload: Record<string, unknown>) => {
        events.push({ topic, payload });
      }),
    };

    const first = await finalizeSlackThreadCreation(fixture.requestId, dependencies);
    const repeated = await finalizeSlackThreadCreation(fixture.requestId, dependencies);

    expect(first).toMatchObject({
      status: "opened",
      requestId: fixture.requestId,
      childSessionKey: `ravi-parent:thread:${fixture.threadTs}`,
      childSessionName: "ravi-parent-t-1713000000000100",
      providerThreadId: fixture.threadTs,
    });
    expect(repeated).toEqual({ status: "ignored", requestId: fixture.requestId });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      sessionName: "ravi-parent-t-1713000000000100",
      payload: {
        prompt: "[System] Execute: [from: ravi-parent] Investigate the branch",
        source: {
          channel: "slack",
          chatId: "C123",
          threadId: fixture.threadTs,
          sourceMessageId: fixture.threadTs,
          actorType: "agent",
          actorAgentId: "ravi",
        },
        context: {
          isGroup: true,
          groupId: "C123",
          actorType: "agent",
          actorAgentId: "ravi",
        },
        _turnOrigin: {
          protocol: "ravi.runtime.turn-origin",
          schemaVersion: 1,
          producer: "channel",
          action: "session.bootstrap",
          principal: {
            type: "agent",
            id: "ravi",
          },
        },
      },
      options: {
        messageId: `slack-thread-start:${fixture.requestId}`,
      },
    });
    const child = getSession(`ravi-parent:thread:${fixture.threadTs}`);
    expect(child).toMatchObject({
      name: "ravi-parent-t-1713000000000100",
      modelOverride: "gpt-5.6",
      lastChannel: "slack",
      lastTo: "C123",
      lastAccountId: "ravi-slack",
      lastThreadId: fixture.threadTs,
    });
    expect(listSessionSubscriptions(child!.sessionKey)).toEqual([
      expect.objectContaining({
        role: "primary",
        speechMode: "speak",
        outputAttachedAt: expect.any(Number),
      }),
    ]);
    expect(getSlackThreadLifecycle(fixture.requestId)).toMatchObject({
      status: "open",
      childSessionKey: child!.sessionKey,
      childSessionName: child!.name,
      promptPublishedAt: expect.any(Number),
    });
    expect(events).toEqual([
      {
        topic: "ravi.inbound.thread.created",
        payload: expect.objectContaining({
          source: "ravi.chat_action",
          requestId: fixture.requestId,
          sessionKey: child!.sessionKey,
          threadTs: fixture.threadTs,
          agentId: "ravi",
          modelOverride: "gpt-5.6",
        }),
      },
    ]);
  });

  it("keeps the agent bootstrap pending when inbound reaches the thread first", async () => {
    const fixture = seedPendingCreation();
    const child = getOrCreateSession(`ravi-parent:thread:${fixture.threadTs}`, "ravi", "/tmp/ravi", {
      name: "ravi-parent-t-1713000000000100",
      lastThreadId: fixture.threadTs,
    });
    const threadChat = dbUpsertChat({
      channel: "slack",
      instanceId: "slack-instance-1",
      platformChatId: `C123#${fixture.threadTs}`,
      chatType: "thread",
      title: "C123",
    });

    const observed = registerSlackThreadInboundLifecycle({
      childSession: child,
      accountId: "ravi-slack",
      instanceId: "slack-instance-1",
      platformChatId: "C123",
      threadCanonicalChatId: threadChat.id,
      providerThreadId: fixture.threadTs,
    });
    expect(observed).toMatchObject({
      source: "action",
      status: "root_delivered",
      childSessionKey: child.sessionKey,
    });
    expect(observed.promptPublishedAt).toBeUndefined();

    const prompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const result = await finalizeSlackThreadCreation(fixture.requestId, {
      publishPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
        prompts.push({ sessionName, payload });
      }),
      publishEvent: mock(async () => {}),
    });

    expect(result.status).toBe("opened");
    expect(prompts).toEqual([
      {
        sessionName: child.name!,
        payload: expect.objectContaining({
          prompt: "[System] Execute: [from: ravi-parent] Investigate the branch",
        }),
      },
    ]);
    expect(getSlackThreadLifecycle(fixture.requestId)).toMatchObject({
      status: "open",
      childSessionKey: child.sessionKey,
      promptPublishedAt: expect.any(Number),
    });
  });

  it("rejects completion from an expired creation claim", () => {
    const fixture = seedPendingCreation();
    expect(
      claimSlackThreadCreation({
        requestId: fixture.requestId,
        claimId: "claim-a",
        leaseMs: 1_000,
        now: 1_000,
      }),
    ).not.toBeNull();
    expect(
      claimSlackThreadCreation({
        requestId: fixture.requestId,
        claimId: "claim-b",
        leaseMs: 1_000,
        now: 2_001,
      }),
    ).not.toBeNull();

    expect(() =>
      completeSlackThreadCreation({
        requestId: fixture.requestId,
        claimId: "claim-a",
        childSessionKey: `ravi-parent:thread:${fixture.threadTs}`,
        childSessionName: "ravi-parent-t-1713000000000100",
        threadCanonicalChatId: "chat-thread",
        promptPublishedAt: 2_002,
      }),
    ).toThrow("creation claim was lost");
    expect(getSlackThreadLifecycle(fixture.requestId)).toMatchObject({
      status: "starting",
      creationClaimId: "claim-b",
    });
  });

  it("keeps Slack DM forks out of group session state", async () => {
    const fixture = seedPendingCreation({ channelId: "D123", chatType: "dm" });
    const prompts: Array<{ payload: Record<string, unknown> }> = [];

    await finalizeSlackThreadCreation(fixture.requestId, {
      publishPrompt: mock(async (_sessionName: string, payload: Record<string, unknown>) => {
        prompts.push({ payload });
      }),
      publishEvent: mock(async () => {}),
    });

    const child = getSession(`ravi-parent:thread:${fixture.threadTs}`)!;
    expect(child.chatType).toBe("dm");
    expect(child.groupId).toBeUndefined();
    expect(prompts[0]?.payload).toMatchObject({
      source: {
        chatId: "D123",
        threadId: fixture.threadTs,
      },
      context: {
        isGroup: false,
      },
    });
    expect((prompts[0]?.payload.context as Record<string, unknown>).groupId).toBeUndefined();
  });

  it("closes silently or returns one structured completion to the parent, then reopens on inbound", async () => {
    const fixture = seedPendingCreation();
    const prompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const events: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const dependencies = {
      publishPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
        prompts.push({ sessionName, payload });
      }),
      publishEvent: mock(async (topic: string, payload: Record<string, unknown>) => {
        events.push({ topic, payload });
      }),
    };
    await finalizeSlackThreadCreation(fixture.requestId, dependencies);
    prompts.length = 0;
    events.length = 0;
    const child = getSession(`ravi-parent:thread:${fixture.threadTs}`)!;

    const silent = await closeSlackThread(child, undefined, dependencies);
    expect(silent).toMatchObject({
      changed: true,
      parentReturnDelivered: false,
      record: {
        status: "closed",
        parentReturnRequested: false,
      },
    });
    expect(prompts).toHaveLength(0);

    const threadChatId = findSlackThreadLifecycleByChildSession(child.sessionKey)!.threadCanonicalChatId!;
    registerSlackThreadInboundLifecycle({
      childSession: child,
      accountId: "ravi-slack",
      instanceId: "slack-instance-1",
      platformChatId: "C123",
      threadCanonicalChatId: threadChatId,
      providerThreadId: fixture.threadTs,
    });
    expect(findSlackThreadLifecycleByChildSession(child.sessionKey)?.status).toBe("open");

    const returned = await closeSlackThread(child, "The branch is fixed", dependencies);
    const repeated = await closeSlackThread(child, "The branch is fixed", dependencies);
    expect(returned).toMatchObject({
      changed: true,
      parentReturnDelivered: true,
      record: {
        status: "closed",
        closeSequence: 2,
        parentReturnRequested: true,
        closeResult: "The branch is fixed",
      },
    });
    expect(repeated.changed).toBe(false);
    expect(prompts).toEqual([
      {
        sessionName: "ravi-parent",
        payload: expect.objectContaining({
          prompt: expect.stringContaining("Resultado: The branch is fixed"),
          _slackThreadLifecycle: expect.objectContaining({
            eventType: "thread.closed",
            childSessionKey: child.sessionKey,
            closeSequence: 2,
          }),
          _turnOrigin: {
            protocol: "ravi.runtime.turn-origin",
            schemaVersion: 1,
            producer: "channel",
            action: "session.return",
            principal: {
              type: "agent",
              id: "ravi",
            },
          },
        }),
      },
    ]);
  });

  it("preserves a pending parent completion when inbound reopens the thread", async () => {
    const fixture = seedPendingCreation();
    const childPrompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const creationDependencies = {
      publishPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
        childPrompts.push({ sessionName, payload });
      }),
      publishEvent: mock(async () => {}),
    };
    await finalizeSlackThreadCreation(fixture.requestId, creationDependencies);
    const child = getSession(`ravi-parent:thread:${fixture.threadTs}`)!;
    const failedReturnDependencies = {
      publishPrompt: mock(async (sessionName: string) => {
        if (sessionName === "ravi-parent") throw new Error("parent prompt unavailable");
      }),
      publishEvent: mock(async () => {}),
    };

    const closed = await closeSlackThread(child, "Pending result", failedReturnDependencies);
    expect(closed).toMatchObject({
      parentReturnDelivered: false,
      record: {
        status: "closed",
        parentReturnRequested: true,
      },
    });
    expect(closed.record.parentNotifiedAt).toBeUndefined();

    const threadChatId = findSlackThreadLifecycleByChildSession(child.sessionKey)!.threadCanonicalChatId!;
    const reopened = registerSlackThreadInboundLifecycle({
      childSession: child,
      accountId: "ravi-slack",
      instanceId: "slack-instance-1",
      platformChatId: "C123",
      threadCanonicalChatId: threadChatId,
      providerThreadId: fixture.threadTs,
    });
    expect(reopened).toMatchObject({
      status: "open",
      parentReturnRequested: true,
      closeResult: "Pending result",
    });
    expect(reopened.parentNotifiedAt).toBeUndefined();

    const parentPrompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const recoveryDependencies = {
      publishPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
        parentPrompts.push({ sessionName, payload });
      }),
      publishEvent: mock(async () => {}),
    };
    expect(await deliverSlackThreadParentReturn(fixture.requestId, recoveryDependencies)).toBe(true);
    expect(await deliverSlackThreadParentReturn(fixture.requestId, recoveryDependencies)).toBe(false);
    expect(parentPrompts).toEqual([
      {
        sessionName: "ravi-parent",
        payload: expect.objectContaining({
          prompt: expect.stringContaining("Resultado: Pending result"),
        }),
      },
    ]);
  });
});

function seedPendingCreation(input: { channelId?: string; chatType?: "channel" | "dm" } = {}): {
  requestId: string;
  threadTs: string;
} {
  const channelId = input.channelId ?? "C123";
  const chatType = input.chatType ?? "channel";
  getOrCreateSession("ravi-parent", "ravi", "/tmp/ravi", {
    name: "ravi-parent",
    chatType,
  });
  const rootChat = dbUpsertChat({
    channel: "slack",
    instanceId: "slack-instance-1",
    platformChatId: channelId,
    chatType,
    title: channelId,
  });
  const requestId = "slack-thread:req-1";
  const threadTs = "1713000000.000100";
  createSlackThreadLifecycle({
    requestId,
    parentSessionKey: "ravi-parent",
    parentSessionName: "ravi-parent",
    initiatorSessionKey: "ravi-parent",
    initiatorSessionName: "ravi-parent",
    accountId: "ravi-slack",
    instanceId: "slack-instance-1",
    platformChatId: channelId,
    rootCanonicalChatId: rootChat.id,
    initialPrompt: "Investigate the branch",
    modelOverride: "gpt-5.6",
  });
  markSlackThreadRootDelivered({
    requestId,
    providerThreadId: threadTs,
    canonicalRootMessageId: "cm_root",
  });
  return { requestId, threadTs };
}
