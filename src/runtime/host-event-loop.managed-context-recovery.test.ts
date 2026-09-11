import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHistory, saveMessage } from "../db.js";
import { nats } from "../nats.js";
import { getOrCreateSession, getSession, updateRuntimeProviderState } from "../router/index.js";
import { dbCreateAgent, dbDeleteSkillGrant, dbUpsertSkillGrant } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON } from "./context-window-recovery.js";
import { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import { buildRuntimeStartRequest } from "./runtime-request-builder.js";
import type { RuntimeCapabilities, RuntimeSessionHandle, SessionRuntimeProvider } from "./types.js";

const agentId = "managed-recovery";
const sessionKey = `agent:${agentId}:main`;
const providerId = "managed-recovery-fixture";
const skillId = "local:workspace:agents:skill-a";
const capabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "provider-session-id" },
  usage: { semantics: "terminal-event" },
  tools: {
    permissionMode: "ravi-host",
    accessRequirement: "tool_and_executable",
    supportsParallelCalls: false,
    availableCapabilities: [],
  },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: { availability: "none", loadedState: "none" },
  skillExposure: {
    contractVersion: 1,
    modes: ["textual"],
    nativeDiscovery: { user: "none", project: "none", plugins: "none" },
    modelCallFence: { contractVersion: 1, guarantee: "before-every-model-call" },
    contextUpdate: "rebuild",
  },
  supportsSessionResume: true,
  supportsSessionFork: true,
  supportsPartialText: true,
  supportsToolHooks: false,
  supportsHostSessionHooks: false,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};
const provider: SessionRuntimeProvider = {
  id: providerId,
  getCapabilities: () => capabilities,
  prepareSession(input) {
    if (!input.skillPolicy) throw new Error("Fixture requires a core skill policy");
    return {
      skillExposure: {
        snapshotId: input.skillPolicy.id,
        mode: input.skillExposureMode ?? "textual",
        preparedIds: input.skillPolicy.skills.map((skill) => skill.id),
      },
    };
  },
  startSession() {
    throw new Error("This test must not call a model");
  },
};

let stateDir: string;
let crashRecovery: RuntimeCrashRecoveryCoordinator;
let emitSpy: ReturnType<typeof spyOn>;

function fixture() {
  const lifecycle: string[] = [];
  const runtime: RuntimeSessionHandle = {
    provider: providerId,
    events: (async function* () {
      yield {
        type: "turn.failed",
        error: "The model's context window is exhausted.",
        recoverable: false,
        rawEvent: { type: "turn.failed", result: "context window exhausted" },
      };
    })(),
    interrupt: async () => {},
    close: async () => {
      lifecycle.push("close");
    },
  };
  const current = createQueuedRuntimeUserMessage({ prompt: "UNPROVED_CURRENT_PROVIDER_INPUT" });
  const streaming: RuntimeHostStreamingSession = {
    agentId,
    queryHandle: runtime,
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [current],
    currentTurnPendingIds: current.pendingId ? [current.pendingId] : [],
    currentModel: "fixture",
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
    currentCrashRecoveryTerminal: {
      status: "failed",
      completedAt: 1,
      startedTool: false,
      materializedOutput: false,
    },
  };
  const stashed = new Map<string, RuntimeUserMessage[]>();
  const run = (restart?: () => Promise<void>) =>
    runRuntimeEventLoop({
      runId: "recovery-old",
      sessionName: sessionKey,
      session: getOrCreateSession(sessionKey, agentId, stateDir),
      agent: { id: agentId, cwd: stateDir, provider: providerId },
      streaming,
      runtimeSession: runtime,
      runtimeCapabilities: capabilities,
      model: "fixture",
      instanceId: "test",
      defaultRuntimeProviderId: providerId,
      streamingSessions: new Map([[sessionKey, streaming]]),
      stashedMessages: stashed,
      safeEmit: async () => {},
      drainPendingStarts: () => {
        lifecycle.push("drain");
      },
      restartStashedSession: async (input) => {
        expect(input.reason).toBe(RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON);
        lifecycle.push("restart");
        await restart?.();
      },
    });
  return { streaming, runtime, stashed, lifecycle, run };
}

async function request(streaming: RuntimeHostStreamingSession, runId: string) {
  const session = getOrCreateSession(sessionKey, agentId, stateDir);
  return buildRuntimeStartRequest({
    runId,
    sessionName: sessionKey,
    prompt: { prompt: "BUILD_ONLY" },
    session,
    agent: { id: agentId, cwd: stateDir, provider: providerId, settingSources: [] },
    runtimeProviderId: providerId,
    runtimeProvider: provider,
    runtimeCapabilities: capabilities,
    sessionCwd: stateDir,
    dbSessionKey: sessionKey,
    model: "fixture",
    runtimeResolution: {
      options: { model: "fixture" },
      sources: { model: "agent_default", effort: null, thinking: null },
      hasTaskRuntimeContext: false,
    },
    storedRuntimeSessionParams: session.runtimeSessionParams,
    storedProviderSessionId: session.providerSessionId,
    canResumeStoredSession: Boolean(session.providerSessionId),
    streamingSession: streaming,
    stashedMessages: new Map(),
    defaultRuntimeProviderId: providerId,
    crashRecovery,
  });
}

describe("managed context-window recovery", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-managed-context-recovery-");
    dbCreateAgent({ id: agentId, cwd: stateDir });
    getOrCreateSession(sessionKey, agentId, stateDir);
    const skillDir = join(stateDir, ".agents", "skills", "skill-a");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      '---\nname: skill-a\ndescription: Fixture skill A\nravi.requires: {"kind":"none"}\n---\nSKILL_A_CONTENT\n',
    );
    dbUpsertSkillGrant({ agentId, skillName: skillId });
    saveMessage(sessionKey, "assistant", "REVOKED_SKILL_A_ASSISTANT_MARKER", "old-provider");
    saveMessage(sessionKey, "user", "REVOKED_SKILL_A_RAVI_INJECTION", "old-provider");
    emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    crashRecovery = new RuntimeCrashRecoveryCoordinator({ instanceId: "managed-recovery-fixture" });
    crashRecovery.start();
  });
  afterEach(async () => {
    crashRecovery.stopGracefully("fixture_complete");
    emitSpy.mockRestore();
    await cleanupIsolatedRaviState(stateDir);
  });

  test("never restores revoked skill text through recovery history when authority changes before restart", async () => {
    const old = fixture();
    const initial = await request(old.streaming, "initial");
    expect(initial.runtimeRequest.skillPolicy?.skills.map((skill) => skill.id)).toContain(skillId);
    const binding = getSession(sessionKey)?.runtimeSessionParams?.skillPolicySession;
    updateRuntimeProviderState(sessionKey, providerId, {
      providerSessionId: "old-provider",
      runtimeSessionDisplayId: "old-provider",
      runtimeSessionParams: { skillPolicySession: binding, nativeThread: "old-provider" },
    });
    const historyBefore = getHistory(sessionKey);
    let rebuilt = false;
    await old.run(async () => {
      dbDeleteSkillGrant(agentId, skillId);
      const recovered = old.stashed.get(sessionKey);
      const recoveredText = JSON.stringify(recovered);
      expect(recoveredText).not.toContain("REVOKED_SKILL_A");
      expect(recoveredText).not.toContain("UNPROVED_CURRENT_PROVIDER_INPUT");
      expect(recovered?.[0]?.message.content).toContain("No verified human input is available");
      expect(getHistory(sessionKey)).toEqual(historyBefore);
      expect(getSession(sessionKey)?.runtimeSessionParams?.skillPolicySession).toEqual(binding);
      expect(getSession(sessionKey)?.runtimeSessionParams?.skillPolicyRebuild).toMatchObject({
        contractVersion: 1,
        reason: "skill-policy-change",
      });
      const next = fixture();
      next.streaming.pendingMessages = recovered ?? [];
      next.streaming.currentCrashRecoveryTerminal = undefined;
      const built = await request(next.streaming, "after-revocation");
      expect(built.runtimeRequest.resume).toBeUndefined();
      expect(built.runtimeRequest.resumeSession).toBeUndefined();
      expect(built.runtimeRequest.skillPolicy?.skills.map((skill) => skill.id)).not.toContain(skillId);
      expect(built.runtimeRequest.systemPromptAppend).not.toContain("REVOKED_SKILL_A");
      const delivered = await built.runtimeRequest.prompt.next();
      expect(delivered.done).toBe(false);
      expect(JSON.stringify(delivered.value)).not.toContain("REVOKED_SKILL_A");
      expect(JSON.stringify(delivered.value)).not.toContain("UNPROVED_CURRENT_PROVIDER_INPUT");
      next.streaming.done = true;
      next.streaming.onTurnComplete?.();
      await built.runtimeRequest.prompt.return(undefined);
      rebuilt = true;
    });
    expect(rebuilt).toBe(true);
    expect(old.lifecycle).toEqual(["close", "restart", "drain"]);
    expect(getHistory(sessionKey)).toEqual(historyBefore);
  }, 60_000);

  test.each(["absent", "failed"])("blocks managed restart when resource-close acknowledgement is %s", async (mode) => {
    updateRuntimeProviderState(sessionKey, providerId, {
      providerSessionId: "old-provider",
      runtimeSessionParams: {
        skillPolicySession: { contractVersion: 1, snapshotId: "old", contextFingerprint: "old" },
      },
    });
    const current = fixture();
    current.runtime.close =
      mode === "absent"
        ? undefined
        : async () => {
            throw new Error("Resource close failed");
          };
    await current.run();
    expect(current.lifecycle).toEqual(["drain"]);
    expect(current.stashed.get(sessionKey)).toHaveLength(1);
    expect(JSON.stringify(current.stashed.get(sessionKey))).not.toContain("REVOKED_SKILL_A");
    expect(getHistory(sessionKey)).toHaveLength(2);
  });

  test("keeps validated effects and queued successors without replaying unproved current intent", async () => {
    updateRuntimeProviderState(sessionKey, providerId, {
      providerSessionId: "old-provider",
      runtimeSessionParams: {
        skillPolicySession: { contractVersion: 1, snapshotId: "old", contextFingerprint: "old" },
        skillPolicyRebuild: {
          contractVersion: 1,
          reason: "skill-policy-change",
          continuity: {
            prompt: "REVOKED_SKILL_A_PERSISTED_PROMPT",
            effects: [
              { id: "effect-completed", status: "completed", args: "REVOKED_SKILL_A_ARGS" },
              { id: "effect-uncertain", status: "uncertain", result: "REVOKED_SKILL_A_RESULT" },
            ],
          },
        },
      },
    });
    const current = fixture();
    const successor = createQueuedRuntimeUserMessage({ prompt: "QUEUED_SUCCESSOR" });
    current.streaming.pendingMessages.push(successor);
    await current.run();
    const recovered = current.stashed.get(sessionKey);
    expect(recovered).toHaveLength(2);
    expect(recovered?.[1]).toEqual(successor);
    expect(JSON.stringify(recovered)).not.toContain("REVOKED_SKILL_A");
    expect(JSON.stringify(recovered)).not.toContain("UNPROVED_CURRENT_PROVIDER_INPUT");
    expect(recovered?.[0]?.message.content).toContain("Do not replay completed actions or retry uncertain actions");
    expect(getSession(sessionKey)?.runtimeSessionParams?.skillPolicyRebuild).toMatchObject({
      continuity: {
        requiresReconciliation: true,
        effects: [
          { id: "effect-completed", status: "completed" },
          { id: "effect-uncertain", status: "uncertain" },
        ],
      },
    });
    expect(getHistory(sessionKey)).toHaveLength(2);
  });

  test("does not broaden context-window replay when tool effects already occurred", async () => {
    const params = {
      skillPolicySession: { contractVersion: 1, snapshotId: "old", contextFingerprint: "old" },
      nativeThread: "old-provider",
    };
    updateRuntimeProviderState(sessionKey, providerId, {
      providerSessionId: "old-provider",
      runtimeSessionParams: params,
    });
    const current = fixture();
    current.streaming.currentTurnToolStarted = true;
    await current.run();
    expect(current.lifecycle).toEqual(["close", "drain"]);
    expect(current.stashed.get(sessionKey)).toBeUndefined();
    expect(getSession(sessionKey)?.runtimeSessionParams).toEqual(params);
    expect(getHistory(sessionKey)).toHaveLength(2);
  });
});
