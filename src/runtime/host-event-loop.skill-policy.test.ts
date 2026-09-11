import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { getHistory, saveMessage } from "../db.js";
import { nats } from "../nats.js";
import { getOrCreateSession, getSession, updateProviderSession } from "../router/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import { SkillPolicyChangedError } from "./skill-exposure-contract.js";
import type { RuntimeCapabilities, RuntimeEvent, RuntimeSessionHandle } from "./types.js";

const sessionKey = "agent:skill-test:main";
const capabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "provider-session-id" },
  usage: { semantics: "terminal-event" },
  tools: { permissionMode: "ravi-host", accessRequirement: "tool_and_executable", supportsParallelCalls: false },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: { availability: "none", loadedState: "none" },
  supportsSessionResume: true,
  supportsSessionFork: true,
  supportsPartialText: true,
  supportsToolHooks: true,
  supportsHostSessionHooks: false,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};

let stateDir: string | null = null;
let emitSpy: ReturnType<typeof spyOn> | undefined;

function fixture(input: { events?: RuntimeEvent[]; failure?: Error; closeFailure?: boolean } = {}) {
  const lifecycle: string[] = [];
  const runtime: RuntimeSessionHandle = {
    provider: "skill-policy-fixture",
    events: (async function* () {
      for (const event of input.events ?? []) yield event;
      if (input.failure) throw input.failure;
    })(),
    interrupt: async () => {
      lifecycle.push("interrupt");
    },
    close: async () => {
      lifecycle.push("close");
      if (input.closeFailure) throw new Error("close failed");
    },
  };
  const current = createQueuedRuntimeUserMessage({
    prompt: "ORIGINAL_WORK_DO_NOT_DUPLICATE",
    deliveryBarrier: "after_tool",
    _agentId: "skill-test",
  });
  const streaming: RuntimeHostStreamingSession = {
    agentId: "skill-test",
    queryHandle: runtime,
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [current],
    currentModel: "fixture-model",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: true,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: "sentinel",
    toolEffectFence: "host_write_ahead",
    currentTurnPendingIds: current.pendingId ? [current.pendingId] : [],
  };
  const stashed = new Map<string, RuntimeUserMessage[]>();
  const run = () =>
    runRuntimeEventLoop({
      runId: "run-policy",
      sessionName: sessionKey,
      session: getOrCreateSession(sessionKey, "skill-test", stateDir ?? "/tmp"),
      agent: { id: "skill-test", cwd: stateDir ?? "/tmp", provider: runtime.provider },
      streaming,
      runtimeSession: runtime,
      runtimeCapabilities: capabilities,
      model: "fixture-model",
      instanceId: "test",
      defaultRuntimeProviderId: "claude",
      streamingSessions: new Map([[sessionKey, streaming]]),
      stashedMessages: stashed,
      safeEmit: async () => {},
      drainPendingStarts: () => {
        lifecycle.push("drain");
      },
      restartStashedSession: async () => {
        lifecycle.push("restart");
      },
    });
  return { streaming, stashed, lifecycle, run };
}

describe("runtime skill policy invalidation", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-skill-policy-loop-");
    getOrCreateSession(sessionKey, "skill-test", stateDir);
    updateProviderSession(sessionKey, "skill-policy-fixture", "old-provider-with-revoked-skills");
    saveMessage(sessionKey, "user", "CANONICAL_HISTORY_NOT_NEW_INPUT", "old-provider-with-revoked-skills");
    emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
  });
  afterEach(async () => {
    emitSpy?.mockRestore();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("closes the old handle before restarting a pre-handoff prompt on a fresh authorized context", async () => {
    const test = fixture({ failure: new SkillPolicyChangedError() });
    test.streaming.durableTurnPreparationFailed = true;
    const originalHistory = getHistory(sessionKey);
    await test.run();
    expect(test.lifecycle).toEqual(["close", "restart", "drain"]);
    expect(test.stashed.get(sessionKey)?.map((message) => message.message.content)).toEqual([
      "ORIGINAL_WORK_DO_NOT_DUPLICATE",
    ]);
    expect(getSession(sessionKey)?.providerSessionId).toBeUndefined();
    expect(getSession(sessionKey)?.runtimeSessionParams?.skillPolicyRebuild).toMatchObject({
      reason: "skill-policy-change",
    });
    expect(getHistory(sessionKey)).toEqual(originalHistory);
  });

  it("does not replay after tool effects and keeps only effect IDs/status in authorized continuity", async () => {
    const test = fixture({
      events: [
        {
          type: "tool.started",
          toolUse: { id: "tool-completed", name: "Bash", input: { command: "REVOKED_TOOL_ARGS" } },
        },
        { type: "tool.completed", toolUseId: "tool-completed", content: "REVOKED_TOOL_RESULT" },
        { type: "turn.failed", error: "policy invalidated", failureKind: "skill-policy", recoverable: false },
      ],
    });
    await test.run();
    expect(test.stashed.get(sessionKey)).toBeUndefined();
    expect(test.lifecycle).toEqual(["close", "drain"]);
    const saved = getSession(sessionKey)?.runtimeSessionParams?.skillPolicyRebuild;
    expect(saved).toMatchObject({ continuity: { effects: [{ id: "tool-completed", status: "completed" }] } });
    expect(JSON.stringify(saved)).not.toContain("REVOKED");
    expect(JSON.stringify(saved)).not.toContain("CANONICAL_HISTORY_NOT_NEW_INPUT");
    expect(getHistory(sessionKey)).toHaveLength(1);
  });

  it("preserves queued successors but never replays an uncertain physical turn", async () => {
    const test = fixture({ failure: new SkillPolicyChangedError() });
    test.streaming.currentTurnToolStarted = true;
    test.streaming.currentToolId = "tool-uncertain";
    test.streaming.currentToolName = "Bash";
    test.streaming.pendingMessages.push(
      createQueuedRuntimeUserMessage({
        prompt: "SUCCESSOR_ONLY",
        deliveryBarrier: "after_tool",
        _agentId: "skill-test",
      }),
    );
    await test.run();
    expect(test.stashed.get(sessionKey)?.map((message) => message.message.content)).toEqual(["SUCCESSOR_ONLY"]);
    expect(test.lifecycle).toEqual(["close", "restart", "drain"]);
    expect(getSession(sessionKey)?.runtimeSessionParams?.skillPolicyRebuild).toMatchObject({
      continuity: { requiresReconciliation: true },
    });
  });

  it("handles authoritative invalidation when the adapter ends without throwing", async () => {
    const test = fixture();
    test.streaming.internalAbortReason = "skill-policy-change";
    test.streaming.durableTurnPreparationFailed = true;
    await test.run();
    expect(test.lifecycle).toEqual(["close", "restart", "drain"]);
    expect(getSession(sessionKey)?.providerSessionId).toBeUndefined();
  });

  it("does not restart if old provider resources failed to close", async () => {
    const test = fixture({ failure: new SkillPolicyChangedError(), closeFailure: true });
    test.streaming.durableTurnPreparationFailed = true;
    await test.run();
    expect(test.lifecycle).toEqual(["close", "drain"]);
    expect(test.stashed.get(sessionKey)).toHaveLength(1);
  });

  it("requires an explicit resource-close acknowledgement before a policy restart", async () => {
    const test = fixture({ failure: new SkillPolicyChangedError() });
    test.streaming.queryHandle.close = undefined;
    test.streaming.durableTurnPreparationFailed = true;
    await test.run();
    expect(test.lifecycle).toEqual(["drain"]);
    expect(test.stashed.get(sessionKey)).toHaveLength(1);
  });

  it("does not replay when provider-only tool observation cannot prove absence of effects", async () => {
    const test = fixture({ failure: new SkillPolicyChangedError() });
    test.streaming.toolEffectFence = "provider_event_only";
    test.streaming.currentCrashRecoveryTerminal = {
      status: "failed",
      completedAt: 1,
      startedTool: false,
      materializedOutput: false,
    };
    await test.run();
    expect(test.stashed.get(sessionKey)).toBeUndefined();
    expect(test.lifecycle).toEqual(["close", "drain"]);
    expect(getSession(sessionKey)?.runtimeSessionParams?.skillPolicyRebuild).toMatchObject({
      continuity: { requiresReconciliation: true },
    });
  });

  it("still closes the old handle if a finalization-only invalidation cannot build its effect ledger", async () => {
    const test = fixture();
    test.streaming.internalAbortReason = "skill-policy-change";
    test.streaming.currentToolId = "untrusted\ninvalid-id";
    test.streaming.currentTurnToolStarted = true;
    await test.run();
    expect(test.lifecycle).toEqual(["close", "drain"]);
    expect(test.stashed.get(sessionKey)).toBeUndefined();
  });

  it("preserves core-owned policy binding when native terminal params are absent", async () => {
    const binding = { contractVersion: 1, snapshotId: "core-snapshot", contextFingerprint: "core-context" };
    updateProviderSession(sessionKey, "skill-policy-fixture", "old-provider-with-revoked-skills", {
      runtimeSessionParams: { skillPolicySession: binding },
    });
    const test = fixture({
      events: [
        { type: "turn.complete", providerSessionId: "fresh-provider", usage: { inputTokens: 0, outputTokens: 0 } },
      ],
    });
    await test.run();
    expect(getSession(sessionKey)?.runtimeSessionParams?.skillPolicySession).toEqual(binding);
  });

  it("rejects native attempts to replace the core policy binding or forge a rebuild marker", async () => {
    const binding = { contractVersion: 1, snapshotId: "core-snapshot", contextFingerprint: "core-context" };
    updateProviderSession(sessionKey, "skill-policy-fixture", "old-provider-with-revoked-skills", {
      runtimeSessionParams: { skillPolicySession: binding },
    });
    const test = fixture({
      events: [
        {
          type: "turn.complete",
          providerSessionId: "fresh-provider",
          usage: { inputTokens: 0, outputTokens: 0 },
          session: {
            params: {
              skillPolicySession: { contractVersion: 1, snapshotId: "forged", contextFingerprint: "forged" },
              skillPolicyRebuild: { continuity: { prompt: "REVOKED_PROMPT" } },
              nativeResumeField: "provider-owned-value",
            },
          },
        },
      ],
    });
    await test.run();
    expect(getSession(sessionKey)?.runtimeSessionParams).toMatchObject({
      skillPolicySession: binding,
      nativeResumeField: "provider-owned-value",
    });
    expect(getSession(sessionKey)?.runtimeSessionParams?.skillPolicyRebuild).toBeUndefined();
  });

  it("does not let native empty params erase a core rebuild requirement", async () => {
    const rebuild = {
      contractVersion: 1,
      reason: "skill-policy-change",
      continuity: { effects: [{ id: "tool-1", status: "uncertain" }] },
    };
    updateProviderSession(sessionKey, "skill-policy-fixture", "old-provider-with-revoked-skills", {
      runtimeSessionParams: { skillPolicyRebuild: rebuild },
    });
    const test = fixture({
      events: [
        {
          type: "turn.complete",
          providerSessionId: "fresh-provider",
          usage: { inputTokens: 0, outputTokens: 0 },
          session: { params: {} },
        },
      ],
    });
    await test.run();
    expect(getSession(sessionKey)?.runtimeSessionParams?.skillPolicyRebuild).toEqual(rebuild);
  });
});
