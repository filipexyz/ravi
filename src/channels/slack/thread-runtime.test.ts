import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { CliExpectedError } from "../../cli/expected-error.js";
import { getHistory, saveMessage } from "../../db.js";
import { nats } from "../../nats.js";
import * as sessionStream from "../../omni/session-stream.js";
import {
  flushPermissionAuditEvents,
  listPermissionDenials,
  recordAndEmitPermissionDenial,
  setPermissionAuditPublisherForTest,
} from "../../permissions/denials.js";
import { dbCreateAgent, dbGetAgent, dbUpdateAgent, dbUpsertChat, getDb } from "../../router/router-db.js";
import {
  attachChatToSession,
  deleteSession,
  getOrCreateSession,
  getSession,
  listSessionSubscriptions,
  renameSessionName,
  updateRuntimeProviderState,
  updateSessionModelOverride,
  updateSessionName,
  updateSessionRuntimeProviderOverride,
} from "../../router/sessions.js";
import type { SessionEntry } from "../../router/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { logger } from "../../utils/logger.js";
import * as outboundPublish from "../outbound-publish-outbox.js";
import { finalizeSlackThreadCreation } from "./thread-lifecycle.js";
import {
  closeSlackThreadLifecycle,
  createSlackThreadLifecycle,
  getSlackThreadLifecycle,
  markSlackThreadRootDelivered,
} from "./thread-lifecycle-store.js";
import { configureSlackThreadRuntime, type ConfigureSlackThreadRuntimeInput } from "./thread-runtime.js";

let stateDir: string | null = null;

beforeEach(async () => {
  logger.setLevel("error");
  stateDir = await createIsolatedRaviState("ravi-slack-thread-runtime-");
});

afterAll(() => logger.setLevel("info"));

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("Slack parent thread runtime configuration", () => {
  it("lets the parent configure its started child and reads back the next-turn runtime", async () => {
    const fixture = await seedThread();
    const authorizeProviderChange = mock(() => {});
    const result = configureSlackThreadRuntime(
      { parentSession: fixture.parent, ref: fixture.child.name!, model: "gpt-6-astra", effort: "ultra" },
      authorizeProviderChange,
    );
    expect(result).toMatchObject({
      actionId: "thread.configure",
      status: "configured",
      changed: true,
      appliesOn: "next-turn",
      before: { provider: "codex", model: "gpt-5.6", effort: "high", thinking: "verbose" },
      after: { provider: "codex", model: "gpt-6-astra", effort: "ultra", thinking: "verbose" },
      thread: {
        requestId: fixture.requestId,
        status: "open",
        runtime: { provider: "codex", model: "gpt-6-astra", effort: "ultra" },
      },
    });
    expect(getSession(fixture.child.sessionKey)).toMatchObject({
      modelOverride: "gpt-6-astra",
      effortOverride: "ultra",
    });
    expect(authorizeProviderChange).not.toHaveBeenCalled();
  });

  it.each(["name", "key", "requestId", "threadTs"])("accepts its child's %s", async (kind) => {
    const fixture = await seedThread();
    const refs = {
      name: fixture.child.name!,
      key: fixture.child.sessionKey,
      requestId: fixture.requestId,
      threadTs: fixture.threadTs,
    };
    expect(
      configureSlackThreadRuntime(
        { parentSession: fixture.parent, ref: refs[kind as keyof typeof refs], effort: "ultra" },
        () => {},
      ).after.effort,
    ).toBe("ultra");
  });

  it("switches Claude/opus to Codex/astra atomically and clears incompatible provider state", async () => {
    const fixture = await seedThread();
    updateSessionRuntimeProviderOverride(fixture.child.sessionKey, "claude");
    updateSessionModelOverride(fixture.child.sessionKey, "opus");
    updateRuntimeProviderState(fixture.child.sessionKey, "claude", {
      providerSessionId: "private-provider-session",
      runtimeSessionParams: { private: "state" },
    });
    saveMessage(fixture.child.name!, "user", "Durable conversation", "private-provider-session");
    const history = getHistory(fixture.child.name!);
    const subscriptions = listSessionSubscriptions(fixture.child.sessionKey);
    const agent = dbGetAgent("ravi");
    const guard = mock((child: SessionEntry, next: string | null) => {
      expect(getDb().inTransaction).toBe(false);
      expect(next).toBe("codex");
      expect(child.runtimeProviderOverride).toBe("claude");
      expect(getSession(child.sessionKey)?.modelOverride).toBe("opus");
    });
    const result = configureSlackThreadRuntime(
      {
        parentSession: fixture.parent,
        ref: fixture.requestId,
        provider: "codex",
        model: "gpt-6-astra",
        effort: "ultra",
        thinking: "off",
      },
      guard,
    );
    expect(guard).toHaveBeenCalledTimes(1);
    expect(result.before).toEqual({ provider: "claude", model: "opus", effort: "high", thinking: "verbose" });
    expect(result.after).toEqual({ provider: "codex", model: "gpt-6-astra", effort: "ultra", thinking: "off" });
    expect(getSession(fixture.child.sessionKey)?.providerSessionId).toBeUndefined();
    expect(getSession(fixture.child.sessionKey)?.runtimeSessionParams).toBeUndefined();
    expect(getHistory(fixture.child.name!)).toEqual(history);
    expect(listSessionSubscriptions(fixture.child.sessionKey)).toEqual(subscriptions);
    expect(dbGetAgent("ravi")).toEqual(agent);
    expect(getSlackThreadLifecycle(fixture.requestId)).toEqual(fixture.record);
    expect(Object.keys(result).sort()).toEqual([
      "actionId",
      "after",
      "appliesOn",
      "before",
      "changed",
      "status",
      "thread",
    ]);
    expect(JSON.stringify(result)).not.toContain("private-provider-session");
    expect(JSON.stringify(result)).not.toContain("runtimeSessionParams");
  });

  it.each([
    {},
    { provider: "unknown", model: "gpt-6-astra" },
    { provider: "", effort: "ultra" },
    { provider: "claude", effort: "ultra" },
    { model: "opus", effort: "ultra" },
    { model: "gpt-6-astra ultra", effort: "ultra" },
    { model: " ", effort: "ultra" },
    { model: "gpt-6-astra", effort: "invalid" },
    { model: "gpt-6-astra", effort: "" },
    { model: "gpt-6-astra", thinking: "yes" },
    { model: "gpt-6-astra", thinking: "" },
  ] satisfies Array<Partial<ConfigureSlackThreadRuntimeInput>>)(
    "rejects invalid patch %j without partial writes",
    async (patch) => {
      const fixture = await seedThread();
      const before = getSession(fixture.child.sessionKey);
      const guard = mock(() => {});
      expect(() =>
        configureSlackThreadRuntime({ parentSession: fixture.parent, ref: fixture.requestId, ...patch }, guard),
      ).toThrow(CliExpectedError);
      expect(getSession(fixture.child.sessionKey)).toEqual(before);
      expect(getSlackThreadLifecycle(fixture.requestId)).toEqual(fixture.record);
      expect(guard).not.toHaveBeenCalled();
    },
  );

  it("refuses the provider guard before any write, including the other fields", async () => {
    const fixture = await seedThread();
    const before = getSession(fixture.child.sessionKey);
    const guard = mock(() => {
      throw new CliExpectedError("Provider authority required", "PERMISSION_DENIED", 3);
    });
    expect(() =>
      configureSlackThreadRuntime(
        {
          parentSession: fixture.parent,
          ref: fixture.requestId,
          provider: "claude",
          model: "opus",
          effort: "ultra",
          thinking: "off",
        },
        guard,
      ),
    ).toThrow("Provider authority required");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(getSession(fixture.child.sessionKey)).toEqual(before);
    expect(getSlackThreadLifecycle(fixture.requestId)).toEqual(fixture.record);
  });

  it("preserves the denial audit when the provider guard records it and refuses", async () => {
    const fixture = await seedThread();
    const before = getSession(fixture.child.sessionKey);
    const events: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const suppression = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    setPermissionAuditPublisherForTest((topic, data) => {
      events.push({ topic, data });
    });
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    try {
      expectErrorCode(
        () =>
          configureSlackThreadRuntime(
            {
              parentSession: fixture.parent,
              ref: fixture.requestId,
              provider: "claude",
              model: "opus",
              effort: "ultra",
            },
            (child) => {
              recordAndEmitPermissionDenial({
                subjectType: "agent",
                subjectId: child.agentId,
                agentId: child.agentId,
                sessionKey: child.sessionKey,
                relation: "mutate",
                objectType: "agents",
                objectId: "set",
                audit: { type: "scope", agentId: child.agentId, denied: "mutate:agents:set" },
              });
              throw new CliExpectedError("Provider authority required", "PERMISSION_DENIED", 3);
            },
          ),
        "PERMISSION_DENIED",
      );
      await flushPermissionAuditEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.topic).toBe("ravi.audit.denied");
      expect(listPermissionDenials({ subjectType: "agent", subjectId: "ravi" })).toEqual([
        expect.objectContaining({
          id: events[0]?.data.denialId,
          notifiedAt: expect.any(Number),
          sessionKey: fixture.child.sessionKey,
        }),
      ]);
      expect(getSession(fixture.child.sessionKey)).toEqual(before);
    } finally {
      setPermissionAuditPublisherForTest();
      if (suppression === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = suppression;
    }
  });

  it.each(["child-provider", "agent-default", "provider-intent"])(
    "refuses stale provider authorization after %s changes",
    async (change) => {
      const fixture = await seedThread();
      const guard = mock(() => {
        if (change === "child-provider") updateSessionRuntimeProviderOverride(fixture.child.sessionKey, "grok");
        else if (change === "provider-intent") updateSessionRuntimeProviderOverride(fixture.child.sessionKey, "codex");
        else dbUpdateAgent("ravi", { provider: "grok" });
      });
      expectErrorCode(
        () =>
          configureSlackThreadRuntime(
            {
              parentSession: fixture.parent,
              ref: fixture.requestId,
              provider: "claude",
              model: "opus",
              effort: "ultra",
            },
            guard,
          ),
        "THREAD_IDENTITY_MISMATCH",
      );
      expect(guard).toHaveBeenCalledTimes(1);
      expect(getSession(fixture.child.sessionKey)).toMatchObject({
        runtimeProviderOverride: change === "child-provider" ? "grok" : "codex",
        modelOverride: "gpt-5.6",
        effortOverride: "high",
        thinkingLevel: "verbose",
      });
      expect(getSlackThreadLifecycle(fixture.requestId)).toEqual(fixture.record);
    },
  );

  it.each(["codex", "clear"])("always calls the required provider guard for %s", async (provider) => {
    const fixture = await seedThread();
    const guard = mock((_child: SessionEntry, _next: string | null) => {});
    configureSlackThreadRuntime({ parentSession: fixture.parent, ref: fixture.requestId, provider }, guard);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard.mock.calls[0]?.[1]).toBe(provider === "clear" ? null : provider);
  });

  it("clears overrides and follows the configured agent provider instead of last-used history", async () => {
    const fixture = await seedThread();
    updateSessionRuntimeProviderOverride(fixture.child.sessionKey, "claude");
    updateSessionModelOverride(fixture.child.sessionKey, "opus");
    updateRuntimeProviderState(fixture.child.sessionKey, "claude", { providerSessionId: "private-provider-session" });
    const input = {
      parentSession: fixture.parent,
      ref: fixture.requestId,
      provider: "clear",
      model: "clear",
      effort: "clear",
      thinking: "clear",
    };
    const result = configureSlackThreadRuntime(input, () => {});
    expect(result.changed).toBe(true);
    expect(result.after).toEqual({ provider: null, model: null, effort: null, thinking: null });
    expect(result.thread.runtime).toMatchObject({ provider: "codex", model: "gpt-6-astra" });
    expect(getSession(fixture.child.sessionKey)).toMatchObject({ runtimeProvider: "codex" });
    expect(getSession(fixture.child.sessionKey)?.providerSessionId).toBeUndefined();
    const unchanged = getSession(fixture.child.sessionKey)!;
    expect(configureSlackThreadRuntime(input, () => {}).changed).toBe(false);
    expect(getSession(fixture.child.sessionKey)).toEqual({
      ...unchanged,
      runtimeProviderConfigRevision: (unchanged.runtimeProviderConfigRevision ?? 0) + 1,
      updatedAt: expect.any(Number),
    });
    expect(getSlackThreadLifecycle(fixture.requestId)).toEqual(fixture.record);
  });

  it("rematerializes stale last-used provider even when its override was already clear", async () => {
    const fixture = await seedThread();
    updateSessionRuntimeProviderOverride(fixture.child.sessionKey, null);
    updateRuntimeProviderState(fixture.child.sessionKey, "claude", { providerSessionId: "stale-provider-session" });
    const result = configureSlackThreadRuntime(
      { parentSession: fixture.parent, ref: fixture.requestId, provider: "clear" },
      () => {},
    );
    expect(result.before.provider).toBeNull();
    expect(result.after.provider).toBeNull();
    expect(result.changed).toBe(true);
    expect(result.thread.runtime.provider).toBe("codex");
    expect(getSession(fixture.child.sessionKey)?.providerSessionId).toBeUndefined();
  });

  it("keeps same-provider continuity and reports unchanged settings while recording fresh provider intent", async () => {
    const fixture = await seedThread();
    updateRuntimeProviderState(fixture.child.sessionKey, "codex", { providerSessionId: "private-provider-session" });
    const before = getSession(fixture.child.sessionKey)!;
    const result = configureSlackThreadRuntime(
      {
        parentSession: fixture.parent,
        ref: fixture.requestId,
        provider: "codex",
        model: "gpt-5.6",
        effort: "high",
        thinking: "verbose",
      },
      () => {},
    );
    expect(result.changed).toBe(false);
    expect(result.before).toEqual(result.after);
    expect(getSession(fixture.child.sessionKey)).toEqual({
      ...before,
      runtimeProviderConfigRevision: (before.runtimeProviderConfigRevision ?? 0) + 1,
      updatedAt: expect.any(Number),
    });
  });

  it("configures a closed thread without changing lifecycle, pending return, or output", async () => {
    const fixture = await seedThread();
    closeSlackThreadLifecycle({
      childSessionKey: fixture.child.sessionKey,
      returnResult: "Done",
      closedAt: 1700000000000,
    });
    const closed = getSlackThreadLifecycle(fixture.requestId);
    const refusePublish = async () => {
      throw new Error("Runtime configuration must not publish");
    };
    const publishPrompt = spyOn(sessionStream, "publishSessionPrompt").mockImplementation(refusePublish);
    const publishEvent = spyOn(nats, "emit").mockImplementation(refusePublish);
    const publishOutbound = spyOn(outboundPublish, "publishChannelOutboundJobDurably").mockImplementation(
      refusePublish,
    );
    try {
      const result = configureSlackThreadRuntime(
        { parentSession: fixture.parent, ref: fixture.requestId, effort: "ultra" },
        () => {},
      );
      expect(result.thread).toMatchObject({ status: "closed", parentReturn: { requested: true, pending: true } });
      expect(getSlackThreadLifecycle(fixture.requestId)).toEqual(closed);
      expect(publishPrompt).not.toHaveBeenCalled();
      expect(publishEvent).not.toHaveBeenCalled();
      expect(publishOutbound).not.toHaveBeenCalled();
    } finally {
      publishPrompt.mockRestore();
      publishEvent.mockRestore();
      publishOutbound.mockRestore();
    }
  });

  it.each(["name", "key", "requestId", "threadTs"])("refuses another parent's child by %s", async (kind) => {
    const fixture = await seedThread();
    const other = getOrCreateSession("other-parent", "ravi", "/tmp/ravi", { name: "other-parent", channel: "slack" });
    const refs = {
      name: fixture.child.name!,
      key: fixture.child.sessionKey,
      requestId: fixture.requestId,
      threadTs: fixture.threadTs,
    };
    expectErrorCode(
      () =>
        configureSlackThreadRuntime(
          { parentSession: other, ref: refs[kind as keyof typeof refs], effort: "ultra" },
          () => {},
        ),
      "THREAD_NOT_FOUND",
    );
    expect(getSession(fixture.child.sessionKey)).toEqual(fixture.child);
  });

  it("does not fall back to generic session resolution", async () => {
    const fixture = await seedThread();
    const unrelated = getOrCreateSession("unrelated", "ravi", "/tmp/ravi", { name: "unrelated" });
    for (const ref of [unrelated.name!, unrelated.sessionKey, "unknown"]) {
      expectErrorCode(
        () => configureSlackThreadRuntime({ parentSession: fixture.parent, ref, effort: "ultra" }, () => {}),
        "THREAD_NOT_FOUND",
      );
    }
    expect(getSession(unrelated.sessionKey)).toEqual(unrelated);
  });

  it("refuses a child trying to configure itself or a sibling", async () => {
    const fixture = await seedThread();
    for (const ref of [fixture.requestId, "sibling-thread"]) {
      expectErrorCode(
        () => configureSlackThreadRuntime({ parentSession: fixture.child, ref, effort: "ultra" }, () => {}),
        "THREAD_NOT_CHANNEL_ROOT",
      );
    }
  });

  it.each([true, false])("allows a WhatsApp-origin parent attached to Slack with output=%s", async (slackOutput) => {
    const fixture = await seedThread({ parentChannel: "whatsapp", slackOutput });
    const subscriptions = listSessionSubscriptions(fixture.parent.sessionKey);
    expect(subscriptions).toHaveLength(2);
    expect(getSession(fixture.parent.sessionKey)).toMatchObject({ channel: "whatsapp", lastChannel: "whatsapp" });
    expect(
      configureSlackThreadRuntime({ parentSession: fixture.parent, ref: fixture.requestId, effort: "ultra" }, () => {})
        .after.effort,
    ).toBe("ultra");
    expect(listSessionSubscriptions(fixture.parent.sessionKey)).toEqual(subscriptions);
  });

  it("uses an aligned root subscription when the lifecycle lacks its canonical root id", async () => {
    const fixture = await seedThread({ parentChannel: "whatsapp", slackOutput: false });
    getDb()
      .query("UPDATE slack_thread_lifecycle SET root_canonical_chat_id = NULL WHERE request_id = ?")
      .run(fixture.requestId);
    expect(
      configureSlackThreadRuntime({ parentSession: fixture.parent, ref: fixture.requestId, effort: "ultra" }, () => {})
        .after.effort,
    ).toBe("ultra");
  });

  it("refuses a root without a persisted Slack root binding", async () => {
    const fixture = await seedThread();
    getDb()
      .query("UPDATE slack_thread_lifecycle SET root_canonical_chat_id = NULL WHERE request_id = ?")
      .run(fixture.requestId);
    const unrelated = dbUpsertChat({
      channel: "slack",
      instanceId: "slack-instance-1",
      platformChatId: "C999",
      chatType: "channel",
    });
    attachChatToSession({ sessionKey: fixture.parent.sessionKey, chatId: unrelated.id });
    expectErrorCode(
      () =>
        configureSlackThreadRuntime(
          { parentSession: fixture.parent, ref: fixture.requestId, effort: "ultra" },
          () => {},
        ),
      "THREAD_NOT_CHANNEL_ROOT",
    );
  });

  it.each(["child-agent", "parent-agent", "child-name", "parent-name", "child-key", "canonical-chat"])(
    "refuses mismatched persisted %s identity",
    async (kind) => {
      const fixture = await seedThread();
      if (kind === "child-agent")
        getDb().query("UPDATE sessions SET agent_id = 'other' WHERE session_key = ?").run(fixture.child.sessionKey);
      if (kind === "parent-agent")
        getDb().query("UPDATE sessions SET agent_id = 'other' WHERE session_key = ?").run(fixture.parent.sessionKey);
      if (kind === "child-name") updateSessionName(fixture.child.sessionKey, "stale-child-name");
      if (kind === "parent-name") updateSessionName(fixture.parent.sessionKey, "stale-parent-name");
      if (kind === "child-key") {
        getOrCreateSession("forged-child", "ravi", "/tmp/ravi", { name: "forged-child" });
        getDb()
          .query(
            "UPDATE slack_thread_lifecycle SET child_session_key = 'forged-child', child_session_name = 'forged-child' WHERE request_id = ?",
          )
          .run(fixture.requestId);
      }
      if (kind === "canonical-chat")
        getDb()
          .query(
            "UPDATE slack_thread_lifecycle SET thread_canonical_chat_id = root_canonical_chat_id WHERE request_id = ?",
          )
          .run(fixture.requestId);
      const before = getSession(fixture.child.sessionKey);
      expectErrorCode(
        () =>
          configureSlackThreadRuntime(
            { parentSession: fixture.parent, ref: fixture.requestId, effort: "ultra" },
            () => {},
          ),
        "THREAD_IDENTITY_MISMATCH",
      );
      expect(getSession(fixture.child.sessionKey)).toEqual(before);
    },
  );

  it("uses the registry after a legitimate rename and refuses its old name", async () => {
    const fixture = await seedThread();
    renameSessionName(fixture.child.sessionKey, "renamed-child");
    renameSessionName(fixture.parent.sessionKey, "renamed-parent");
    expectErrorCode(
      () =>
        configureSlackThreadRuntime(
          { parentSession: fixture.parent, ref: fixture.child.name!, effort: "ultra" },
          () => {},
        ),
      "THREAD_NOT_FOUND",
    );
    expect(
      configureSlackThreadRuntime({ parentSession: fixture.parent, ref: "renamed-child", effort: "ultra" }, () => {})
        .thread.childSessionName,
    ).toBe("renamed-child");
  });

  it.each(["queued", "root_delivered", "starting", "failed"])(
    "refuses %s lifecycle without starting it",
    async (status) => {
      const fixture = await seedThread();
      getDb().query("UPDATE slack_thread_lifecycle SET status = ? WHERE request_id = ?").run(status, fixture.requestId);
      const record = getSlackThreadLifecycle(fixture.requestId);
      expectErrorCode(
        () =>
          configureSlackThreadRuntime(
            { parentSession: fixture.parent, ref: fixture.requestId, effort: "ultra" },
            () => {},
          ),
        "THREAD_NOT_STARTED",
      );
      expect(getSlackThreadLifecycle(fixture.requestId)).toEqual(record);
      expect(getSession(fixture.child.sessionKey)).toEqual(fixture.child);
    },
  );

  it("refuses a missing child without recreating it or shadowing its reserved name", async () => {
    const fixture = await seedThread();
    deleteSession(fixture.child.sessionKey);
    expectErrorCode(
      () =>
        configureSlackThreadRuntime(
          { parentSession: fixture.parent, ref: fixture.child.name!, effort: "ultra" },
          () => {},
        ),
      "THREAD_SESSION_MISSING",
    );
    expect(getSession(fixture.child.sessionKey)).toBeNull();
    expect(getSession(fixture.child.name!)).toBeNull();
    expect(getSlackThreadLifecycle(fixture.requestId)).toEqual(fixture.record);
  });

  it("refuses a stale parent handle after its session disappears", async () => {
    const fixture = await seedThread();
    deleteSession(fixture.parent.sessionKey);
    expectErrorCode(
      () =>
        configureSlackThreadRuntime(
          { parentSession: fixture.parent, ref: fixture.requestId, effort: "ultra" },
          () => {},
        ),
      "THREAD_PARENT_MISSING",
    );
    expect(getSession(fixture.child.sessionKey)).toEqual(fixture.child);
  });

  it("rolls back all fields and provider continuity when a later write fails", async () => {
    const fixture = await seedThread();
    updateRuntimeProviderState(fixture.child.sessionKey, "codex", { providerSessionId: "private-provider-session" });
    const before = getSession(fixture.child.sessionKey);
    getDb().exec(
      "CREATE TRIGGER reject_thread_effort BEFORE UPDATE OF effort_override ON sessions WHEN NEW.effort_override = 'ultra' BEGIN SELECT RAISE(ABORT, 'test effort write rejected'); END",
    );
    expect(() =>
      configureSlackThreadRuntime(
        { parentSession: fixture.parent, ref: fixture.requestId, provider: "claude", model: "opus", effort: "ultra" },
        () => {},
      ),
    ).toThrow("test effort write rejected");
    expect(getSession(fixture.child.sessionKey)).toEqual(before);
    expect(getSlackThreadLifecycle(fixture.requestId)).toEqual(fixture.record);
  });

  it("validates the resulting provider/model pair when a model override is cleared", async () => {
    const fixture = await seedThread();
    updateSessionRuntimeProviderOverride(fixture.child.sessionKey, "claude");
    updateSessionModelOverride(fixture.child.sessionKey, "opus");
    const before = getSession(fixture.child.sessionKey);
    expectErrorCode(
      () =>
        configureSlackThreadRuntime(
          { parentSession: fixture.parent, ref: fixture.requestId, model: "clear", effort: "ultra" },
          () => {},
        ),
      "THREAD_MODEL_INVALID",
    );
    expect(getSession(fixture.child.sessionKey)).toEqual(before);
  });

  it("rolls back when readback detects an unexpected persisted override", async () => {
    const fixture = await seedThread();
    const before = getSession(fixture.child.sessionKey);
    getDb().exec(
      "CREATE TRIGGER corrupt_thread_thinking AFTER UPDATE OF effort_override ON sessions BEGIN UPDATE sessions SET thinking_level = 'normal' WHERE session_key = NEW.session_key; END",
    );
    expect(() =>
      configureSlackThreadRuntime({ parentSession: fixture.parent, ref: fixture.requestId, effort: "ultra" }, () => {}),
    ).toThrow("readback did not match");
    expect(getSession(fixture.child.sessionKey)).toEqual(before);
  });
});

function expectErrorCode(action: () => unknown, code: string) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CliExpectedError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

async function seedThread(
  input: {
    parentKey?: string;
    requestId?: string;
    threadTs?: string;
    parentChannel?: "slack" | "whatsapp";
    slackOutput?: boolean;
  } = {},
) {
  const parentKey = input.parentKey ?? "ravi-parent";
  const requestId = input.requestId ?? "slack-thread:req-1";
  const threadTs = input.threadTs ?? "1713000000.000100";
  if (!dbGetAgent("ravi")) dbCreateAgent({ id: "ravi", cwd: "/tmp/ravi", provider: "codex", model: "gpt-6-astra" });
  const parent = getOrCreateSession(parentKey, "ravi", "/tmp/ravi", {
    name: parentKey,
    channel: input.parentChannel ?? "slack",
    chatType: "channel",
    lastChannel: input.parentChannel ?? "slack",
    lastTo: input.parentChannel === "whatsapp" ? "whatsapp-group" : "C123",
    lastAccountId: input.parentChannel === "whatsapp" ? "ravi-whatsapp" : "ravi-slack",
  });
  const root = dbUpsertChat({
    channel: "slack",
    instanceId: "slack-instance-1",
    platformChatId: "C123",
    chatType: "channel",
  });
  if (input.parentChannel === "whatsapp") {
    const original = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "whatsapp-instance-1",
      platformChatId: "whatsapp-group",
      chatType: "group",
    });
    attachChatToSession({ sessionKey: parent.sessionKey, chatId: original.id, role: "primary" });
    attachChatToSession({
      sessionKey: parent.sessionKey,
      chatId: root.id,
      role: "input",
      setOutputTarget: input.slackOutput ?? true,
    });
  }
  createSlackThreadLifecycle({
    requestId,
    parentSessionKey: parent.sessionKey,
    parentSessionName: parent.name!,
    accountId: "ravi-slack",
    instanceId: "slack-instance-1",
    platformChatId: "C123",
    rootCanonicalChatId: root.id,
    initialPrompt: "Investigate the branch",
    providerOverride: "codex",
    modelOverride: "gpt-5.6",
    effortOverride: "high",
    thinkingLevel: "verbose",
  });
  markSlackThreadRootDelivered({ requestId, providerThreadId: threadTs, canonicalRootMessageId: `root:${requestId}` });
  const dependencies = {
    publishPrompt: mock(async () => {}),
    publishEvent: mock(async () => {}),
    publishOutbound: mock(async () => {}),
  };
  await finalizeSlackThreadCreation(requestId, dependencies);
  const record = getSlackThreadLifecycle(requestId)!;
  const child = getSession(record.childSessionKey!)!;
  dependencies.publishPrompt.mockClear();
  dependencies.publishEvent.mockClear();
  dependencies.publishOutbound.mockClear();
  return { parent, child, record, requestId, threadTs, dependencies };
}
