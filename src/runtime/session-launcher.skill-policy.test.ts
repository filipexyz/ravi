import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { configStore } from "../config-store.js";
import {
  getOrCreateSession,
  getSession,
  updateProviderSession,
  updateRuntimeProviderState,
  type SessionEntry,
} from "../router/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import * as eventLoop from "./host-event-loop.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import { registerRuntimeProvider, unregisterRuntimeProvider } from "./provider-registry.js";
import * as requestBuilder from "./runtime-request-builder.js";
import { startRuntimeSession } from "./session-launcher.js";
import { resolveSkillPolicy } from "./skill-policy.js";
import type { RuntimeCapabilities, RuntimeStartRequest } from "./types.js";

const sessionKey = "agent:main:launcher-policy";
const providerId = "launcher-policy-fixture";
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
  skillExposure: {
    contractVersion: 1,
    modelCallFence: { contractVersion: 1, guarantee: "before-every-model-call" },
    modes: ["textual"],
    nativeDiscovery: { user: "none", project: "none", plugins: "none" },
    contextUpdate: "rebuild",
  },
  supportsSessionResume: true,
  supportsSessionFork: true,
  supportsPartialText: false,
  supportsToolHooks: true,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};
const policySnapshot = resolveSkillPolicy({
  scope: { agentId: "main", executionId: "launcher-test", contextKey: "launcher-policy-context" },
  revisions: { policy: "1", catalog: "1", permissions: "1", toolSurface: "1" },
  catalog: [],
  selection: { baseline: [], fromCapabilities: [], fromGrants: [], local: [] },
  capabilityState: { available: [], authorized: [] },
});
const coreParams = {
  skillPolicySession: {
    contractVersion: 1,
    snapshotId: policySnapshot.id,
    contextFingerprint: "authorized-context",
  },
};

let stateDir: string | null = null;
let builderSpy: ReturnType<typeof spyOn> | undefined;
let loopSpy: ReturnType<typeof spyOn> | undefined;
let deliveredSession: SessionEntry | undefined;
let lastUsedProvider = providerId;
let effectiveContinuity: Pick<RuntimeStartRequest, "resume" | "resumeSession" | "forkSession"> = {};

describe("session launcher skill-policy continuity", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-launcher-policy-");
    configStore.refresh();
    getOrCreateSession(sessionKey, "main", stateDir, { name: sessionKey });
    updateProviderSession(sessionKey, providerId, "legacy-provider-context", {
      runtimeSessionParams: {
        skillPolicySession: { contractVersion: 1, snapshotId: "legacy", contextFingerprint: "legacy" },
        native: "old-state",
      },
    });
    effectiveContinuity = {};
    deliveredSession = undefined;
    lastUsedProvider = providerId;
    registerRuntimeProvider(providerId, () => ({
      id: providerId,
      getCapabilities: () => capabilities,
      prepareSession: async () => ({}),
      startSession: () => ({
        provider: providerId,
        events: (async function* () {})(),
        interrupt: async () => {},
        close: async () => {},
      }),
    }));
    // The request builder is a separate policy boundary. Its test double makes
    // the same authoritative state handoff without touching global native SDKs.
    builderSpy = spyOn(requestBuilder, "buildRuntimeStartRequest").mockImplementation(async (input) => {
      input.session.runtimeSessionParams = structuredClone(coreParams);
      input.session.providerSessionId = undefined;
      input.session.sdkSessionId = undefined;
      input.session.runtimeSessionDisplayId = undefined;
      input.session.runtimeProvider = lastUsedProvider;
      updateRuntimeProviderState(sessionKey, lastUsedProvider, { runtimeSessionParams: coreParams });
      return {
        runtimeRequest: {
          prompt: (async function* () {})(),
          model: "fixture-model",
          cwd: stateDir ?? "/tmp",
          abortController: input.streamingSession.abortController,
          systemPromptAppend: "authorized prompt",
          skillPolicy: policySnapshot,
          skillExposure: { snapshotId: policySnapshot.id, mode: "textual", preparedIds: [] },
          verifySkillPolicy: () => {},
          verifySkillPolicyAtDispatch: () => {},
          ...effectiveContinuity,
        },
        toolContext: {},
      };
    });
    loopSpy = spyOn(eventLoop, "runRuntimeEventLoop").mockImplementation(async (input) => {
      deliveredSession = structuredClone(input.session);
    });
  });

  afterEach(async () => {
    builderSpy?.mockRestore();
    loopSpy?.mockRestore();
    unregisterRuntimeProvider(providerId);
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  async function launch() {
    const emitted: unknown[] = [];
    await startRuntimeSession({
      sessionName: sessionKey,
      prompt: { prompt: "New human task", _agentId: "main" },
      configModel: "fixture-model",
      instanceId: "launcher-test",
      streamingSessions: new Map<string, RuntimeHostStreamingSession>(),
      stashedMessages: new Map<string, RuntimeUserMessage[]>(),
      safeEmit: async (_subject, payload) => {
        emitted.push(payload);
      },
      drainPendingStarts: () => {},
      crashRecovery: new RuntimeCrashRecoveryCoordinator({ instanceId: "launcher-test" }),
    });
    expect(emitted).toEqual([]);
    expect(deliveredSession).toBeDefined();
  }

  it("does not restore revoked native resume IDs or replace the builder's new policy binding", async () => {
    await launch();
    expect(deliveredSession?.providerSessionId).toBeUndefined();
    expect(deliveredSession?.sdkSessionId).toBeUndefined();
    expect(deliveredSession?.runtimeSessionDisplayId).toBeUndefined();
    expect(deliveredSession?.runtimeSessionParams).toEqual(coreParams);
    expect(getSession(sessionKey)?.runtimeSessionParams).toEqual(coreParams);
  });

  it("uses the accepted resume identity from the effective request instead of the stale resolver decision", async () => {
    effectiveContinuity = {
      resume: "accepted-resume-id",
      resumeSession: { displayId: "accepted-display-id", params: { native: "accepted-native-state" } },
    };
    await launch();
    expect(deliveredSession?.providerSessionId).toBe("accepted-display-id");
    expect(deliveredSession?.sdkSessionId).toBe("accepted-display-id");
    expect(deliveredSession?.runtimeSessionParams).toEqual(coreParams);
  });

  it("uses an accepted resume ID when the adapter provides no display identity", async () => {
    effectiveContinuity = { resume: "accepted-resume-id" };
    await launch();
    expect(deliveredSession?.providerSessionId).toBe("accepted-resume-id");
    expect(deliveredSession?.runtimeSessionDisplayId).toBe("accepted-resume-id");
    expect(deliveredSession?.runtimeSessionParams).toEqual(coreParams);
  });

  it("does not infer a native identity from opaque resume params or mark the runtime as last-used", async () => {
    effectiveContinuity = { resumeSession: { params: { opaqueProviderState: "native-state" } } };
    lastUsedProvider = "previous-successful-runtime";
    await launch();
    expect(deliveredSession?.providerSessionId).toBeUndefined();
    expect(deliveredSession?.runtimeProvider).toBe("previous-successful-runtime");
    expect(getSession(sessionKey)?.runtimeProvider).toBe("previous-successful-runtime");
  });

  it("does not mistake an accepted parent fork for the identity of the new child session", async () => {
    effectiveContinuity = {
      resume: "parent-provider-context",
      forkSession: true,
      resumeSession: { displayId: "parent-display" },
    };
    await launch();
    expect(deliveredSession?.providerSessionId).toBeUndefined();
    expect(deliveredSession?.runtimeSessionDisplayId).toBeUndefined();
    expect(deliveredSession?.runtimeSessionParams).toEqual(coreParams);
  });
});
