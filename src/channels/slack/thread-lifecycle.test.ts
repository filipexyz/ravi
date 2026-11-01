import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { PublishSessionPromptOptions } from "../../omni/session-stream.js";
import type { ChannelOutboundJob } from "../outbound-stream.js";
import { deleteSession, getOrCreateSession, getSession, listSessionSubscriptions } from "../../router/index.js";
import { dbUpsertChat } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  closeSlackThread,
  closeSlackThreadRecord,
  deliverSlackThreadParentReturn,
  finalizeSlackThreadCreation,
  listSlackThreadsForSession,
  registerSlackThreadInboundLifecycle,
  reportSlackThreadProgress,
  sendSlackThreadMessage,
  slackThreadTitle,
  summarizeSlackThreadRuntime,
} from "./thread-lifecycle.js";
import {
  claimSlackThreadCreation,
  completeSlackThreadCreation,
  createSlackThreadLifecycle,
  findSlackThreadLifecycleByChildSession,
  findSlackThreadLifecycleByChildRef,
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
  it("closes the selected request when two records refer to the same child", async () => {
    const fixture = seedPendingCreation();
    const deps = {
      publishPrompt: mock(async () => {}),
      publishEvent: mock(async () => {}),
      publishOutbound: mock(async () => {}),
    };
    await finalizeSlackThreadCreation(fixture.requestId, deps);
    const first = getSlackThreadLifecycle(fixture.requestId)!;
    createSlackThreadLifecycle({
      requestId: "slack-thread:duplicate-child",
      parentSessionKey: first.parentSessionKey,
      parentSessionName: first.parentSessionName,
      initiatorSessionKey: first.parentSessionKey,
      initiatorSessionName: first.parentSessionName,
      accountId: first.accountId,
      instanceId: first.instanceId,
      platformChatId: first.platformChatId,
      rootCanonicalChatId: first.rootCanonicalChatId,
      initialPrompt: "Second request",
    });
    markSlackThreadRootDelivered({
      requestId: "slack-thread:duplicate-child",
      providerThreadId: "1713000000.000200",
      canonicalRootMessageId: "second",
    });
    claimSlackThreadCreation({ requestId: "slack-thread:duplicate-child", claimId: "claim-duplicate", leaseMs: 1000 });
    completeSlackThreadCreation({
      requestId: "slack-thread:duplicate-child",
      claimId: "claim-duplicate",
      childSessionKey: first.childSessionKey!,
      childSessionName: first.childSessionName!,
      threadCanonicalChatId: first.threadCanonicalChatId!,
      promptPublishedAt: Date.now(),
    });
    await closeSlackThreadRecord(first, undefined, deps);
    expect(getSlackThreadLifecycle(first.requestId)?.status).toBe("closed");
    expect(getSlackThreadLifecycle("slack-thread:duplicate-child")?.status).toBe("open");
  });
  it("closes a pruned child's durable card without recreating the session", async () => {
    const fixture = seedPendingCreation();
    const jobs: ChannelOutboundJob[] = [];
    const deps = {
      publishPrompt: mock(async () => {}),
      publishEvent: mock(async () => {}),
      publishOutbound: mock(async (job: ChannelOutboundJob) => {
        jobs.push(job);
      }),
    };
    await finalizeSlackThreadCreation(fixture.requestId, deps);
    const child = getSession(`ravi-parent:thread:${fixture.threadTs}`)!;
    deleteSession(child.sessionKey);
    const record = findSlackThreadLifecycleByChildRef(child.name!)!;
    expect(record.childSessionKey).toBe(child.sessionKey);
    const result = await closeSlackThreadRecord(record, undefined, deps);
    expect(result.record.status).toBe("closed");
    expect(getSession(child.sessionKey)).toBeNull();
    expect(
      jobs.some(
        (job) =>
          job.request.content.type === "chat_action" &&
          job.request.content.actionId === "message.edit" &&
          job.request.content.threadCard?.status === "closed",
      ),
    ).toBe(true);
    expect((await closeSlackThreadRecord(record, undefined, deps)).changed).toBe(false);
    expect(findSlackThreadLifecycleByChildRef("unknown")).toBeNull();
  });

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
      runtimeProviderOverride: "codex",
      effortOverride: "high",
      thinkingLevel: "verbose",
      lastChannel: "slack",
      lastTo: "C123",
      lastAccountId: "ravi-slack",
      lastThreadId: fixture.threadTs,
    });
    expect(JSON.parse(child!.lastContext!)).toEqual({
      channelId: "slack",
      channelName: "Slack",
      isGroup: true,
      groupName: "C123",
      groupId: "C123",
    });
    expect(listSessionSubscriptions(child!.sessionKey)).toEqual([
      expect.objectContaining({
        role: "primary",
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
    expect((prompts[0]?.payload.context as Record<string, unknown> | undefined)?.groupId).toBeUndefined();
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

    const failingDependencies = {
      publishPrompt: mock(async () => {
        throw new Error("nats down");
      }),
      publishEvent: mock(async () => {}),
    };
    await expect(closeSlackThread(child, "Second result", failingDependencies)).rejects.toMatchObject({
      code: "THREAD_PARENT_RETURN_PENDING",
    });

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

describe("Slack thread orchestration", () => {
  function capture() {
    const prompts: Array<{
      sessionName: string;
      payload: Record<string, unknown>;
      options?: PublishSessionPromptOptions;
    }> = [];
    return {
      prompts,
      dependencies: {
        publishPrompt: mock(
          async (sessionName: string, payload: Record<string, unknown>, options?: PublishSessionPromptOptions) => {
            prompts.push({ sessionName, payload, options });
          },
        ),
        publishEvent: mock(async () => {}),
      },
    };
  }

  it("names the thread by title, session and link when it returns or reports to the parent", async () => {
    const fixture = seedPendingCreation({ teamId: "T0123" });
    const { prompts, dependencies } = capture();
    await finalizeSlackThreadCreation(fixture.requestId, dependencies);
    prompts.length = 0;
    const child = getSession(`ravi-parent:thread:${fixture.threadTs}`)!;

    const report = await reportSlackThreadProgress(child, "Found the failing commit", dependencies);
    await closeSlackThread(child, "The branch is fixed", dependencies);

    const link = `slack://channel?team=T0123&id=C123&thread_ts=${fixture.threadTs}`;
    expect(prompts.map((entry) => entry.sessionName)).toEqual(["ravi-parent", "ravi-parent"]);
    expect(prompts[0]!.payload).toMatchObject({
      prompt: [
        `[System] Inform: Slack thread "Investigate the branch" (${child.name}) reporta progresso.`,
        `Link: ${link}`,
        "Progresso: Found the failing commit",
      ].join("\n"),
      source: { chatId: "C123", actorType: "system" },
      _slackThreadLifecycle: { eventType: "thread.report", eventId: report.messageId },
      _turnOrigin: { producer: "channel", action: "session.return" },
    });
    expect((prompts[0]!.payload.source as Record<string, unknown>).threadId).toBeUndefined();
    expect(prompts[0]!.options).toEqual({ messageId: report.messageId });
    expect(prompts[1]!.payload.prompt).toBe(
      [
        `[System] Inform: Slack thread "Investigate the branch" (${child.name}) concluída.`,
        `Link: ${link}`,
        "Resultado: The branch is fixed",
      ].join("\n"),
    );
    expect(findSlackThreadLifecycleByChildSession(child.sessionKey)?.status).toBe("closed");
  });

  it("lists a parent's threads from the parent or a child, open by default", async () => {
    const fixture = seedPendingCreation();
    const { dependencies } = capture();
    await finalizeSlackThreadCreation(fixture.requestId, dependencies);
    const parent = getSession("ravi-parent")!;
    const child = getSession(`ravi-parent:thread:${fixture.threadTs}`)!;

    const fromParent = listSlackThreadsForSession(parent);
    expect(fromParent).toMatchObject({
      parentSessionKey: "ravi-parent",
      parentSessionName: "ravi-parent",
      threads: [
        {
          requestId: fixture.requestId,
          title: "Investigate the branch",
          status: "open",
          source: "action",
          childSessionName: child.name,
          slackThreadTs: fixture.threadTs,
          link: null,
          parentReturn: { requested: false, pending: false },
        },
      ],
    });
    expect(listSlackThreadsForSession(child).threads.map((thread) => thread.requestId)).toEqual([fixture.requestId]);

    await closeSlackThread(child, undefined, dependencies);
    expect(listSlackThreadsForSession(parent).threads).toEqual([]);
    expect(listSlackThreadsForSession(parent, { includeClosed: true }).threads[0]?.status).toBe("closed");
  });

  it("sends parent instructions into the thread, reopening a closed one, and only from the parent", async () => {
    const fixture = seedPendingCreation();
    const { prompts, dependencies } = capture();
    await finalizeSlackThreadCreation(fixture.requestId, dependencies);
    const parent = getSession("ravi-parent")!;
    const child = getSession(`ravi-parent:thread:${fixture.threadTs}`)!;
    await closeSlackThread(child, undefined, dependencies);
    prompts.length = 0;

    const sent = await sendSlackThreadMessage(
      { parentSession: parent, ref: child.name!, message: "Also check the release branch" },
      dependencies,
    );

    expect(sent.reopened).toBe(true);
    expect(sent.record.status).toBe("open");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionName).toBe(child.name!);
    expect(prompts[0]!.payload).toMatchObject({
      prompt: "[System] Execute: [from: ravi-parent] Also check the release branch",
      source: { chatId: "C123", threadId: fixture.threadTs, actorType: "agent", actorAgentId: "ravi" },
      deliveryBarrier: "after_tool",
      _slackThreadLifecycle: { eventType: "thread.message", reopened: true },
      _turnOrigin: {
        producer: "session-relay",
        action: "execute",
        principal: { type: "agent", id: "ravi" },
        session: { key: "ravi-parent", name: "ravi-parent" },
      },
    });

    const byRequest = await sendSlackThreadMessage(
      { parentSession: parent, ref: fixture.requestId, message: "Status?" },
      dependencies,
    );
    expect(byRequest.reopened).toBe(false);
    await expect(
      sendSlackThreadMessage({ parentSession: child, ref: fixture.requestId, message: "Hi" }, dependencies),
    ).rejects.toThrow("this session is a thread");
    await expect(
      sendSlackThreadMessage({ parentSession: parent, ref: "unknown-thread", message: "Hi" }, dependencies),
    ).rejects.toThrow("Slack thread not found for this session: unknown-thread");
  });

  it("updates the thread's root card on report, close and reopen", async () => {
    const fixture = seedPendingCreation({ requestedBy: "Ana Souza" });
    const { dependencies } = capture();
    const jobs: ChannelOutboundJob[] = [];
    const withCards = {
      ...dependencies,
      publishOutbound: mock(async (job: ChannelOutboundJob) => {
        jobs.push(job);
      }),
    };
    await finalizeSlackThreadCreation(fixture.requestId, withCards);
    const parent = getSession("ravi-parent")!;
    const child = getSession(`ravi-parent:thread:${fixture.threadTs}`)!;
    expect(jobs).toHaveLength(0);

    await reportSlackThreadProgress(child, "Found the failing commit", withCards);
    await closeSlackThread(child, "The branch is fixed", withCards);
    await closeSlackThread(child, "The branch is fixed", withCards);
    await sendSlackThreadMessage({ parentSession: parent, ref: child.name!, message: "Check again" }, withCards);
    await sendSlackThreadMessage({ parentSession: parent, ref: child.name!, message: "Status?" }, withCards);

    // A repeated close and a send to an open thread leave the card as it is.
    expect(jobs.map((job) => (job.request.content as { threadCard?: unknown }).threadCard)).toEqual([
      {
        status: "open",
        note: "Found the failing commit",
        updatedAt: expect.any(Number),
        requestedBy: "Ana Souza",
        runtime: "codex · gpt-5.6 · high · verbose",
      },
      {
        status: "closed",
        note: "The branch is fixed",
        updatedAt: expect.any(Number),
        requestedBy: "Ana Souza",
        runtime: "codex · gpt-5.6 · high · verbose",
      },
      {
        status: "reopened",
        updatedAt: expect.any(Number),
        requestedBy: "Ana Souza",
        runtime: "codex · gpt-5.6 · high · verbose",
      },
    ]);
    expect(jobs[0]!.request).toMatchObject({
      origin: { sessionName: "ravi-parent", responsePhase: "chat_action" },
      target: { channel: "slack", accountId: "ravi-slack", instanceId: "slack-instance-1", chatId: "C123" },
      content: {
        type: "chat_action",
        actionId: "message.edit",
        providerMessageId: fixture.threadTs,
        text: "Investigate the branch",
      },
    });
    expect(new Set(jobs.map((job) => job.request.idempotencyKey)).size).toBe(3);
  });

  it("leaves the root of a thread a person started alone", async () => {
    const { dependencies } = capture();
    const publishOutbound = mock(async () => {});
    getOrCreateSession("ravi-parent", "ravi", "/tmp/ravi", { name: "ravi-parent", chatType: "channel" });
    const child = getOrCreateSession("ravi-parent:thread:1713000000.000900", "ravi", "/tmp/ravi", {
      name: "ravi-parent-thread",
      chatType: "channel",
    });
    const threadChat = dbUpsertChat({
      channel: "slack",
      instanceId: "slack-instance-1",
      platformChatId: "C123#1713000000.000900",
      chatType: "thread",
      title: "C123",
    });
    registerSlackThreadInboundLifecycle({
      childSession: child,
      accountId: "ravi-slack",
      instanceId: "slack-instance-1",
      platformChatId: "C123",
      threadCanonicalChatId: threadChat.id,
      providerThreadId: "1713000000.000900",
    });

    await reportSlackThreadProgress(child, "Halfway", { ...dependencies, publishOutbound });
    await closeSlackThread(child, "Done", { ...dependencies, publishOutbound });

    expect(publishOutbound).not.toHaveBeenCalled();
  });

  it("refuses to send to a thread whose first turn has not started", async () => {
    const fixture = seedPendingCreation();
    const { dependencies } = capture();
    const parent = getSession("ravi-parent")!;

    await expect(
      sendSlackThreadMessage({ parentSession: parent, ref: fixture.requestId, message: "Hi" }, dependencies),
    ).rejects.toThrow(`Slack thread has not started yet: ${fixture.requestId}`);
    await expect(
      sendSlackThreadMessage({ parentSession: parent, ref: fixture.requestId, message: "Hi" }, dependencies),
    ).rejects.toMatchObject({ code: "THREAD_NOT_STARTED" });
  });

  it("marks an open thread whose session is gone as missing, not unstarted, and refuses to send to it", async () => {
    const fixture = seedPendingCreation();
    const { dependencies } = capture();
    await finalizeSlackThreadCreation(fixture.requestId, dependencies);
    const parent = getSession("ravi-parent")!;
    const childKey = `ravi-parent:thread:${fixture.threadTs}`;
    expect(listSlackThreadsForSession(parent).threads[0]?.childSessionMissing).toBe(false);

    deleteSession(childKey);

    const [thread] = listSlackThreadsForSession(parent).threads;
    expect(thread).toMatchObject({
      status: "open",
      childSessionKey: childKey,
      childSessionMissing: true,
    });
    const record = getSlackThreadLifecycle(fixture.requestId)!;
    expect(
      summarizeSlackThreadRuntime({ ...record, providerOverride: undefined, effortOverride: undefined }),
    ).toMatchObject({ providerSource: "child_missing", effortSource: "child_missing" });
    await expect(
      sendSlackThreadMessage({ parentSession: parent, ref: fixture.requestId, message: "Hi" }, dependencies),
    ).rejects.toMatchObject({ code: "THREAD_SESSION_MISSING" });
    await expect(
      sendSlackThreadMessage({ parentSession: parent, ref: "unknown-thread", message: "Hi" }, dependencies),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    await expect(
      sendSlackThreadMessage(
        { parentSession: { ...parent, name: "team's channel" }, ref: "unknown-thread", message: "Hi" },
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
      suggestedAction: "List this session's threads with: ravi sessions threads --all --session 'team'\\''s channel'",
    });
  });

  it("titles a thread with the first line of its initial message, trimmed", () => {
    expect(slackThreadTitle({ initialPrompt: "\n  Fix the deploy  \nDetails follow" })).toBe("Fix the deploy");
    expect(slackThreadTitle({ initialPrompt: `${"x".repeat(100)}` })).toBe(`${"x".repeat(79)}…`);
    expect(slackThreadTitle({})).toBeUndefined();
  });
});

function seedPendingCreation(
  input: { channelId?: string; chatType?: "channel" | "dm"; teamId?: string; requestedBy?: string } = {},
): {
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
    ...(input.teamId ? { rawProvenance: { source: "slack.socket_mode", teamId: input.teamId } } : {}),
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
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    modelOverride: "gpt-5.6",
    providerOverride: "codex",
    effortOverride: "high",
    thinkingLevel: "verbose",
  });
  markSlackThreadRootDelivered({
    requestId,
    providerThreadId: threadTs,
    canonicalRootMessageId: "cm_root",
  });
  return { requestId, threadTs };
}
