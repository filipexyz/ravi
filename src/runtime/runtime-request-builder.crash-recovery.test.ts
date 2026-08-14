import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getOrCreateSession, resetSessionIfUnchanged, type AgentConfig, type SessionEntry } from "../router/index.js";
import { getSessionTurn, listSessionEvents } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import type { RuntimeHostStreamingSession, RuntimeMessageTarget } from "./host-session.js";
import { installCrashRecoveryApprovalFences } from "./runtime-request-builder.js";
import { buildRuntimeStartRequest } from "./runtime-request-builder.js";
import { persistStartedRuntimeProviderState } from "./session-launcher.js";
import type {
  RuntimeCapabilities,
  RuntimeHostServices,
  RuntimeSessionHandle,
  SessionRuntimeProvider,
} from "./types.js";

function createHostServices(overrides: Partial<RuntimeHostServices> = {}): RuntimeHostServices {
  return {
    authorizeCapability: async () => ({ allowed: true, inherited: false }),
    authorizeCommandExecution: async () => ({ approved: true }),
    authorizeToolUse: async () => ({ approved: true }),
    requestUserInput: async () => ({ approved: true }),
    listDynamicTools: () => [],
    executeDynamicTool: async () => ({ success: true, contentItems: [] }),
    ...overrides,
  };
}

function coordinatorWithMarker(
  marker: (attemptId: string, input: { attemptId: string; startedTool?: true; materializedOutput?: true }) => void,
): Pick<RuntimeCrashRecoveryCoordinator, "markTurnAttemptSafety"> {
  return {
    markTurnAttemptSafety: ((input: { attemptId: string; startedTool?: true; materializedOutput?: true }) => {
      marker(input.attemptId, input);
      return undefined;
    }) as unknown as RuntimeCrashRecoveryCoordinator["markTurnAttemptSafety"],
  };
}

describe("runtime request crash recovery approval fences", () => {
  it("closes a provider started from stale session ownership before launcher callbacks continue", async () => {
    const stateDir = await createIsolatedRaviState("ravi-launcher-ownership-loss-");
    try {
      const admitted = getOrCreateSession("session:launcher-loss", "agent-a", stateDir);
      expect(resetSessionIfUnchanged(admitted)).toBe(true);
      const abortController = new AbortController();
      let closed = 0;
      const runtimeSession: RuntimeSessionHandle = {
        provider: "trace-provider",
        events: (async function* () {})(),
        interrupt: async () => {},
        close: async () => {
          closed += 1;
        },
      };

      await expect(
        persistStartedRuntimeProviderState({
          session: admitted,
          runtimeProviderId: "trace-provider",
          runtimeSession,
          abortController,
          canResumeStoredSession: false,
        }),
      ).rejects.toThrow("ownership changed");
      expect(abortController.signal.aborted).toBe(true);
      expect(closed).toBe(1);
      expect(admitted.runtimeProvider).toBeUndefined();
    } finally {
      await cleanupIsolatedRaviState(stateDir);
    }
  });

  it("mutates the host services object captured by Codex-style approval and user-input closures", async () => {
    const order: string[] = [];
    const hostServices = createHostServices({
      authorizeCommandExecution: mock(async () => {
        order.push("authorize-command");
        return { approved: true };
      }),
      authorizeToolUse: mock(async () => {
        order.push("authorize-tool");
        return { approved: true, updatedInput: { path: "safe" } };
      }),
      requestUserInput: mock(async (request) => {
        request.beforeExternalApproval?.();
        order.push("request-user-input");
        return { approved: true, answers: { choice: "A" } };
      }),
    });
    // Codex prepareSession creates a closure before the builder installs the
    // fences. It reads the same hostServices object when approval is requested.
    const capturedCommandApproval = () => hostServices.authorizeCommandExecution({ command: "bun test" });
    const capturedToolApproval = () => hostServices.authorizeToolUse({ toolName: "Edit" });
    const capturedUserInput = () =>
      hostServices.requestUserInput({ questions: [{ id: "choice", question: "Pick one" }] });
    const streamingSession = { currentCrashRecoveryAttemptId: "attempt-a", currentTurnToolStarted: false };

    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker((attemptId, input) =>
        order.push(input.materializedOutput ? `output-marker:${attemptId}` : `tool-marker:${attemptId}`),
      ),
    });

    await expect(capturedCommandApproval()).resolves.toEqual({ approved: true });
    await expect(capturedToolApproval()).resolves.toEqual({
      approved: true,
      updatedInput: { path: "safe" },
    });
    await expect(capturedUserInput()).resolves.toEqual({ approved: true, answers: { choice: "A" } });
    expect(order).toEqual([
      "authorize-command",
      "tool-marker:attempt-a",
      "authorize-tool",
      "tool-marker:attempt-a",
      "output-marker:attempt-a",
      "request-user-input",
    ]);
    expect(streamingSession.currentTurnToolStarted).toBe(true);
  });

  it("denies user input before marking or externalizing when no durable attempt is bound", async () => {
    const requestUserInput = mock(async () => ({ approved: true }));
    const markSafety = mock(() => {});
    const hostServices = createHostServices({ requestUserInput });
    const streamingSession = { currentCrashRecoveryAttemptId: undefined, currentTurnToolStarted: false };
    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker(markSafety),
    });

    await expect(
      hostServices.requestUserInput({ questions: [{ id: "choice", question: "Pick one" }] }),
    ).resolves.toEqual({
      approved: false,
      reason: "Runtime action approval denied because durable turn ownership changed before authorization completed.",
    });
    expect(markSafety).not.toHaveBeenCalled();
    expect(requestUserInput).not.toHaveBeenCalled();
  });

  it("does not externalize user input when the materialized-output marker fails", async () => {
    let externalized = false;
    const requestUserInput = mock(async (request: Parameters<RuntimeHostServices["requestUserInput"]>[0]) => {
      request.beforeExternalApproval?.();
      externalized = true;
      return { approved: true };
    });
    const hostServices = createHostServices({ requestUserInput });
    const streamingSession = {
      currentCrashRecoveryAttemptId: "attempt-user-input-marker-failure",
      currentTurnToolStarted: false,
    };
    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker(() => {
        throw new Error("output marker unavailable");
      }),
    });

    await expect(
      hostServices.requestUserInput({ questions: [{ id: "choice", question: "Pick one" }] }),
    ).rejects.toThrow("output marker unavailable");
    expect(requestUserInput).toHaveBeenCalledTimes(1);
    expect(externalized).toBe(false);
  });

  it("denies user input when ownership disappears while persisting its output marker", async () => {
    let externalized = false;
    const requestUserInput = mock(async (request: Parameters<RuntimeHostServices["requestUserInput"]>[0]) => {
      request.beforeExternalApproval?.();
      externalized = true;
      return { approved: true };
    });
    const hostServices = createHostServices({ requestUserInput });
    const streamingSession: { currentCrashRecoveryAttemptId?: string; currentTurnToolStarted?: boolean } = {
      currentCrashRecoveryAttemptId: "attempt-user-input-marker-race",
      currentTurnToolStarted: false,
    };
    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker(() => {
        streamingSession.currentCrashRecoveryAttemptId = undefined;
      }),
    });

    await expect(
      hostServices.requestUserInput({ questions: [{ id: "choice", question: "Pick one" }] }),
    ).resolves.toEqual({
      approved: false,
      reason: "Runtime action approval denied because durable turn ownership changed before authorization completed.",
    });
    expect(requestUserInput).toHaveBeenCalledTimes(1);
    expect(externalized).toBe(false);
  });

  it("denies a user-input result when ownership disappears while awaiting the external response", async () => {
    let resolveUserInput!: (result: { approved: boolean; answers: { choice: string } }) => void;
    let signalUserInputStarted!: () => void;
    const userInputStarted = new Promise<void>((resolve) => {
      signalUserInputStarted = resolve;
    });
    const requestUserInput = mock(async (request: Parameters<RuntimeHostServices["requestUserInput"]>[0]) => {
      request.beforeExternalApproval?.();
      signalUserInputStarted();
      return await new Promise<{ approved: boolean; answers: { choice: string } }>((resolve) => {
        resolveUserInput = resolve;
      });
    });
    const order: string[] = [];
    const hostServices = createHostServices({ requestUserInput });
    const streamingSession: { currentCrashRecoveryAttemptId?: string; currentTurnToolStarted?: boolean } = {
      currentCrashRecoveryAttemptId: "attempt-user-input-await-race",
      currentTurnToolStarted: false,
    };
    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker((_attemptId, input) => {
        expect(input).toEqual({
          attemptId: "attempt-user-input-await-race",
          materializedOutput: true,
        });
        order.push("output-marker");
      }),
    });

    const result = hostServices.requestUserInput({ questions: [{ id: "choice", question: "Pick one" }] });
    await userInputStarted;
    order.push("external-request");
    streamingSession.currentCrashRecoveryAttemptId = undefined;
    resolveUserInput({ approved: true, answers: { choice: "A" } });

    await expect(result).resolves.toEqual({
      approved: false,
      reason: "Runtime action approval denied because durable turn ownership changed before authorization completed.",
    });
    expect(order).toEqual(["output-marker", "external-request"]);
    expect(requestUserInput).toHaveBeenCalledTimes(1);
  });

  it("does not mark denied approvals", async () => {
    const markSafety = mock(() => {});
    const hostServices = createHostServices({
      authorizeCapability: async () => ({ allowed: false, inherited: false, reason: "capability denied" }),
      authorizeCommandExecution: async () => ({ approved: false, reason: "command denied" }),
      authorizeToolUse: async () => ({ approved: false, reason: "tool denied" }),
      requestUserInput: async () => ({ approved: false, reason: "user input denied locally" }),
    });
    const streamingSession = { currentCrashRecoveryAttemptId: "attempt-denied", currentTurnToolStarted: false };
    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker(markSafety),
    });

    await expect(
      hostServices.authorizeCapability({ permission: "use", objectType: "tool", objectId: "Bash" }),
    ).resolves.toEqual({
      allowed: false,
      inherited: false,
      reason: "capability denied",
    });
    await expect(hostServices.authorizeCommandExecution({ command: "unsafe" })).resolves.toEqual({
      approved: false,
      reason: "command denied",
    });
    await expect(hostServices.authorizeToolUse({ toolName: "Edit" })).resolves.toEqual({
      approved: false,
      reason: "tool denied",
    });
    await expect(
      hostServices.requestUserInput({ questions: [{ id: "choice", question: "Pick one" }] }),
    ).resolves.toEqual({
      approved: false,
      reason: "user input denied locally",
    });
    expect(markSafety).toHaveBeenCalledTimes(0);
    expect(streamingSession.currentTurnToolStarted).toBe(false);
  });

  it("fences a Codex-style capability escalation before its external approval request", async () => {
    const order: string[] = [];
    const authorizeCapability = mock(async (request: Parameters<RuntimeHostServices["authorizeCapability"]>[0]) => {
      request.beforeExternalApproval?.();
      order.push("external-capability-approval");
      return { allowed: true, inherited: false };
    });
    const hostServices = createHostServices({ authorizeCapability });
    const capturedCapabilityApproval = () =>
      hostServices.authorizeCapability({ permission: "use", objectType: "tool", objectId: "Bash" });
    const streamingSession = {
      currentCrashRecoveryAttemptId: "attempt-capability",
      currentTurnToolStarted: false,
    };
    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker((_attemptId, input) => {
        expect(input).toEqual({ attemptId: "attempt-capability", materializedOutput: true });
        order.push("output-marker");
      }),
    });

    await expect(capturedCapabilityApproval()).resolves.toEqual({ allowed: true, inherited: false });
    expect(order).toEqual(["output-marker", "external-capability-approval"]);
    expect(streamingSession.currentTurnToolStarted).toBe(false);
  });

  it("denies a capability result when durable attempt ownership disappears while awaiting authorization", async () => {
    let resolveAuthorization!: (result: { allowed: boolean; inherited: boolean }) => void;
    let signalAuthorizationStarted!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => {
      signalAuthorizationStarted = resolve;
    });
    const authorizeCapability = mock(async () => {
      signalAuthorizationStarted();
      return await new Promise<{ allowed: boolean; inherited: boolean }>((resolve) => {
        resolveAuthorization = resolve;
      });
    });
    const hostServices = createHostServices({ authorizeCapability });
    const streamingSession: { currentCrashRecoveryAttemptId?: string; currentTurnToolStarted?: boolean } = {
      currentCrashRecoveryAttemptId: "attempt-capability-raced",
      currentTurnToolStarted: false,
    };
    const markSafety = mock(() => {});
    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker(markSafety),
    });

    const authorization = hostServices.authorizeCapability({
      permission: "use",
      objectType: "tool",
      objectId: "Bash",
    });
    await authorizationStarted;
    streamingSession.currentCrashRecoveryAttemptId = undefined;
    resolveAuthorization({ allowed: true, inherited: false });

    await expect(authorization).resolves.toEqual({
      allowed: false,
      inherited: false,
      reason: "Runtime action approval denied because durable turn ownership changed before authorization completed.",
    });
    expect(markSafety).not.toHaveBeenCalled();
  });

  it("denies before consulting the provider approval service when no durable attempt is bound", async () => {
    const authorizeCommandExecution = mock(async () => ({ approved: true }));
    const authorizeCapability = mock(async () => ({ allowed: true, inherited: false }));
    const hostServices = createHostServices({ authorizeCommandExecution, authorizeCapability });
    const streamingSession = { currentCrashRecoveryAttemptId: undefined, currentTurnToolStarted: false };
    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker(() => {
        throw new Error("unexpected marker call");
      }),
    });

    await expect(hostServices.authorizeCommandExecution({ command: "bun test" })).resolves.toEqual({
      approved: false,
      reason: "Runtime action approval denied because durable turn ownership changed before authorization completed.",
    });
    expect(authorizeCommandExecution).toHaveBeenCalledTimes(0);
    await expect(
      hostServices.authorizeCapability({ permission: "use", objectType: "tool", objectId: "Bash" }),
    ).resolves.toEqual({
      allowed: false,
      inherited: false,
      reason: "Runtime action approval denied because durable turn ownership changed before authorization completed.",
    });
    expect(authorizeCapability).not.toHaveBeenCalled();
    expect(streamingSession.currentTurnToolStarted).toBe(false);
  });

  it("denies allow when durable attempt ownership disappears during authorization", async () => {
    let resolveAuthorization!: (result: { approved: boolean }) => void;
    let signalAuthorizationStarted!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => {
      signalAuthorizationStarted = resolve;
    });
    const hostServices = createHostServices({
      authorizeCommandExecution: async () => {
        signalAuthorizationStarted();
        return await new Promise((resolve) => {
          resolveAuthorization = resolve;
        });
      },
    });
    const markSafety = mock(() => {});
    const streamingSession: { currentCrashRecoveryAttemptId?: string; currentTurnToolStarted?: boolean } = {
      currentCrashRecoveryAttemptId: "attempt-raced",
      currentTurnToolStarted: false,
    };
    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker(markSafety),
    });

    const approval = hostServices.authorizeCommandExecution({ command: "bun test" });
    await authorizationStarted;
    streamingSession.currentCrashRecoveryAttemptId = undefined;
    resolveAuthorization({ approved: true });

    await expect(approval).resolves.toEqual({
      approved: false,
      reason: "Runtime action approval denied because durable turn ownership changed before authorization completed.",
    });
    expect(markSafety).toHaveBeenCalledTimes(0);
    expect(streamingSession.currentTurnToolStarted).toBe(false);
  });

  it("propagates marker persistence failure instead of returning allow", async () => {
    const hostServices = createHostServices();
    const streamingSession = {
      currentCrashRecoveryAttemptId: "attempt-marker-failure",
      currentTurnToolStarted: false,
    };
    installCrashRecoveryApprovalFences({
      hostServices,
      streamingSession,
      crashRecovery: coordinatorWithMarker(() => {
        throw new Error("marker unavailable");
      }),
    });

    await expect(hostServices.authorizeToolUse({ toolName: "Edit" })).rejects.toThrow("marker unavailable");
    expect(streamingSession.currentTurnToolStarted).toBe(false);
  });
});

const TRACE_SESSION_KEY = "agent:main:crash-recovery-builder";
const TRACE_SESSION_NAME = "crash-recovery-builder";
const TRACE_AGENT_ID = "main";
const TRACE_PROVIDER_ID = "trace-provider";
const TRACE_MODEL = "trace-model";

const traceCapabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "provider-session-id" },
  usage: { semantics: "terminal-event" },
  tools: {
    permissionMode: "ravi-host",
    accessRequirement: "tool_and_executable",
    supportsParallelCalls: false,
  },
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

const traceSource: RuntimeMessageTarget = {
  channel: "whatsapp",
  accountId: "main",
  chatId: "builder-test",
  sourceMessageId: "message-builder-test",
};

function traceSession(stateDir: string): SessionEntry {
  return {
    sessionKey: TRACE_SESSION_KEY,
    name: TRACE_SESSION_NAME,
    agentId: TRACE_AGENT_ID,
    agentCwd: stateDir,
    createdAt: 1,
    updatedAt: 1,
  };
}

function traceAgent(stateDir: string): AgentConfig {
  return {
    id: TRACE_AGENT_ID,
    cwd: stateDir,
    provider: TRACE_PROVIDER_ID,
    settingSources: ["project"],
  };
}

function emptyRuntimeSession(): RuntimeSessionHandle {
  return {
    provider: TRACE_PROVIDER_ID,
    events: (async function* () {})(),
    interrupt: async () => {},
  };
}

function traceStreamingSession(): RuntimeHostStreamingSession {
  return {
    agentId: TRACE_AGENT_ID,
    queryHandle: emptyRuntimeSession(),
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [createQueuedRuntimeUserMessage({ prompt: "persist me", source: traceSource })],
    currentSource: traceSource,
    currentModel: TRACE_MODEL,
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: false,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: "sentinel",
    traceRunId: "run-builder-failure",
  };
}

describe("runtime request durable attempt preparation", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-request-crash-recovery-");
    getOrCreateSession(TRACE_SESSION_KEY, TRACE_AGENT_ID, stateDir);
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("terminalizes the historical trace when durable attempt creation fails before provider delivery", async () => {
    const sessionCwd = stateDir!;
    const streamingSession = traceStreamingSession();
    const runtimeProvider: SessionRuntimeProvider = {
      id: TRACE_PROVIDER_ID,
      getCapabilities: () => traceCapabilities,
      startSession: () => emptyRuntimeSession(),
    };
    const crashRecovery = {
      startTurnAttempt: () => {
        throw new Error("attempt ledger unavailable");
      },
      markTurnAttemptSafety: () => {
        throw new Error("unexpected marker call");
      },
    } as unknown as RuntimeCrashRecoveryCoordinator;
    const { runtimeRequest } = await buildRuntimeStartRequest({
      runId: "run-builder-failure",
      sessionName: TRACE_SESSION_NAME,
      prompt: { prompt: "persist me", source: traceSource },
      session: traceSession(sessionCwd),
      agent: traceAgent(sessionCwd),
      runtimeProviderId: TRACE_PROVIDER_ID,
      runtimeProvider,
      runtimeCapabilities: traceCapabilities,
      sessionCwd,
      dbSessionKey: TRACE_SESSION_KEY,
      model: TRACE_MODEL,
      runtimeResolution: {
        options: { model: TRACE_MODEL },
        sources: { model: "agent_default", effort: null, thinking: null },
        hasTaskRuntimeContext: false,
      },
      storedRuntimeSessionParams: undefined,
      canResumeStoredSession: false,
      resolvedSource: traceSource,
      streamingSession,
      stashedMessages: new Map(),
      defaultRuntimeProviderId: "claude",
      crashRecovery,
    });

    await expect(runtimeRequest.prompt.next()).rejects.toThrow("attempt ledger unavailable");

    const adapterRequest = listSessionEvents(TRACE_SESSION_KEY).find((event) => event.eventType === "adapter.request");
    expect(adapterRequest?.turnId).toBeTruthy();
    expect(getSessionTurn(adapterRequest!.turnId!)).toMatchObject({
      status: "failed",
      abortReason: "durable_attempt_persistence_failed",
      error: "attempt ledger unavailable",
    });
    expect(streamingSession.pendingMessages).toHaveLength(1);
    expect(streamingSession.durableTurnPreparationFailed).toBe(true);
  });

  it("persists an unfenced replay policy before handing a provider-native turn to the adapter", async () => {
    const sessionCwd = stateDir!;
    const streamingSession = traceStreamingSession();
    const providerNativeCapabilities: RuntimeCapabilities = {
      ...traceCapabilities,
      tools: { ...traceCapabilities.tools, permissionMode: "provider-native" },
    };
    const runtimeProvider: SessionRuntimeProvider = {
      id: TRACE_PROVIDER_ID,
      getCapabilities: () => providerNativeCapabilities,
      startSession: () => emptyRuntimeSession(),
    };
    let attemptInput: { metadata?: Record<string, unknown> } | undefined;
    const crashRecovery = {
      startTurnAttempt: (input: { metadata?: Record<string, unknown> }) => {
        attemptInput = input;
        return { attemptId: "attempt-provider-native" };
      },
      markTurnAttemptSafety: () => {
        throw new Error("unexpected marker call");
      },
    } as unknown as RuntimeCrashRecoveryCoordinator;
    const { runtimeRequest } = await buildRuntimeStartRequest({
      runId: "run-builder-provider-native",
      sessionName: TRACE_SESSION_NAME,
      prompt: { prompt: "persist me", source: traceSource },
      session: traceSession(sessionCwd),
      agent: traceAgent(sessionCwd),
      runtimeProviderId: TRACE_PROVIDER_ID,
      runtimeProvider,
      runtimeCapabilities: providerNativeCapabilities,
      sessionCwd,
      dbSessionKey: TRACE_SESSION_KEY,
      model: TRACE_MODEL,
      runtimeResolution: {
        options: { model: TRACE_MODEL },
        sources: { model: "agent_default", effort: null, thinking: null },
        hasTaskRuntimeContext: false,
      },
      storedRuntimeSessionParams: undefined,
      canResumeStoredSession: false,
      resolvedSource: traceSource,
      streamingSession,
      stashedMessages: new Map(),
      defaultRuntimeProviderId: "claude",
      crashRecovery,
    });

    await expect(runtimeRequest.prompt.next()).resolves.toMatchObject({ done: false });

    expect(streamingSession.toolEffectFence).toBe("provider_event_only");
    expect(attemptInput?.metadata).toMatchObject({ toolEffectFence: "provider_event_only" });
    streamingSession.done = true;
    streamingSession.onTurnComplete?.();
    await runtimeRequest.prompt.return(undefined);
  });
});
