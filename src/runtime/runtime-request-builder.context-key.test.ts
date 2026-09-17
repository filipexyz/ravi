import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getOrCreateSession, type AgentConfig, type SessionEntry } from "../router/index.js";
import { dbListContexts } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { resolveRuntimeContext } from "./context-registry.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import type { RuntimeHostStreamingSession, RuntimeMessageTarget } from "./host-session.js";
import { buildRuntimeStartRequest } from "./runtime-request-builder.js";
import type { RuntimeCapabilities, RuntimeSessionHandle, SessionRuntimeProvider } from "./types.js";

const SESSION_KEY = "agent:main:context-key-builder";
const SESSION_NAME = "context-key-builder";
const AGENT_ID = "main";
const PROVIDER_ID = "trace-provider";
const MODEL = "trace-model";

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

const source: RuntimeMessageTarget = {
  channel: "whatsapp",
  accountId: "main",
  chatId: "context-key-builder",
  sourceMessageId: "message-context-key-builder",
};

function session(stateDir: string): SessionEntry {
  return {
    sessionKey: SESSION_KEY,
    name: SESSION_NAME,
    agentId: AGENT_ID,
    agentCwd: stateDir,
    createdAt: 1,
    updatedAt: 1,
  };
}

function agent(stateDir: string): AgentConfig {
  return {
    id: AGENT_ID,
    cwd: stateDir,
    provider: PROVIDER_ID,
    settingSources: ["project"],
  };
}

function emptyRuntimeSession(): RuntimeSessionHandle {
  return {
    provider: PROVIDER_ID,
    events: (async function* () {})(),
    interrupt: async () => {},
  };
}

function streamingSession(prompt: string): RuntimeHostStreamingSession {
  return {
    agentId: AGENT_ID,
    queryHandle: emptyRuntimeSession(),
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [createQueuedRuntimeUserMessage({ prompt, source })],
    currentSource: source,
    currentModel: MODEL,
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
    traceRunId: "run-context-key",
  };
}

function crashRecovery(): RuntimeCrashRecoveryCoordinator {
  let attempt = 0;
  return {
    startTurnAttempt: () => ({ attemptId: `attempt-context-key-${++attempt}` }),
    markTurnAttemptSafety: () => undefined,
  } as unknown as RuntimeCrashRecoveryCoordinator;
}

describe("runtime request first-turn context key", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-request-context-key-");
    getOrCreateSession(SESSION_KEY, AGENT_ID, stateDir);
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("does not revoke the published key when the first turn starts after request build", async () => {
    const sessionCwd = stateDir!;
    const streaming = streamingSession("ravi agents list");
    const runtimeProvider: SessionRuntimeProvider = {
      id: PROVIDER_ID,
      getCapabilities: () => capabilities,
      startSession: () => emptyRuntimeSession(),
    };
    const { runtimeRequest } = await buildRuntimeStartRequest({
      runId: "run-context-key-first-turn",
      sessionName: SESSION_NAME,
      prompt: { prompt: "ravi agents list", source },
      session: session(sessionCwd),
      agent: agent(sessionCwd),
      runtimeProviderId: PROVIDER_ID,
      runtimeProvider,
      runtimeCapabilities: capabilities,
      sessionCwd,
      dbSessionKey: SESSION_KEY,
      model: MODEL,
      runtimeResolution: {
        options: { model: MODEL },
        sources: { model: "agent_default", effort: null, thinking: null },
        hasTaskRuntimeContext: false,
      },
      storedRuntimeSessionParams: undefined,
      canResumeStoredSession: false,
      resolvedSource: source,
      streamingSession: streaming,
      stashedMessages: new Map(),
      defaultRuntimeProviderId: "claude",
      crashRecovery: crashRecovery(),
    });

    const runtimeEnv = runtimeRequest.env;
    if (!runtimeEnv) throw new Error("expected runtime env");
    const publishedKey = runtimeEnv.RAVI_CONTEXT_KEY;
    const toolSpawnEnv = { ...runtimeEnv };
    expect(publishedKey).toBeTruthy();
    expect(resolveRuntimeContext(publishedKey, { touch: false })).not.toBeNull();

    await expect(runtimeRequest.prompt.next()).resolves.toMatchObject({ done: false });

    expect(runtimeEnv.RAVI_CONTEXT_KEY).toBe(publishedKey);
    expect(streaming.currentRuntimeContextKey).toBe(publishedKey);
    expect(toolSpawnEnv.RAVI_CONTEXT_KEY).toBe(publishedKey);
    expect(resolveRuntimeContext(toolSpawnEnv.RAVI_CONTEXT_KEY, { touch: false })?.contextKey).toBe(publishedKey);
    expect(
      dbListContexts({ sessionKey: SESSION_KEY, kind: "turn-runtime", includeInactive: true }).filter(
        (context) => !context.revokedAt,
      ),
    ).toHaveLength(1);

    streaming.pendingMessages.push(createQueuedRuntimeUserMessage({ prompt: "second turn", source }));
    streaming.onTurnComplete?.();
    await expect(runtimeRequest.prompt.next()).resolves.toMatchObject({ done: false });

    expect(runtimeEnv.RAVI_CONTEXT_KEY).not.toBe(publishedKey);
    expect(streaming.currentRuntimeContextKey).toBe(runtimeEnv.RAVI_CONTEXT_KEY);
    expect(resolveRuntimeContext(publishedKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(runtimeEnv.RAVI_CONTEXT_KEY, { touch: false })).not.toBeNull();

    streaming.done = true;
    streaming.onTurnComplete?.();
    await runtimeRequest.prompt.return(undefined);
  });
});
