import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRecentHistory, saveMessage } from "../db.js";
import { nats } from "../nats.js";
import { attachChatToSession } from "../router/sessions.js";
import { classifyTurnProvenance } from "./turn-provenance.js";
import {
  getOrCreateSession,
  getSession,
  updateRuntimeProviderState,
  type AgentConfig,
  type SessionEntry,
} from "../router/index.js";
import { dbUpsertChat, getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getSessionTraceBlob, getSessionTurn, listSessionEvents } from "../session-trace/session-trace-db.js";
import { recordAdapterRequestTrace } from "../session-trace/runtime-trace.js";
import {
  bindRuntimeCredentialAttemptTurn,
  createRuntimeCredential,
  getRuntimeCredentialHealth,
  markRuntimeCredentialAttemptStarted,
  reserveRuntimeCredentialAttempt,
} from "./credential-store.js";
import { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { getRuntimeTurnAttempt } from "./crash-recovery-store.js";
import { RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON } from "./context-window-recovery.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import type { RuntimeHostStreamingSession, RuntimeMessageTarget, RuntimeUserMessage } from "./host-session.js";
import {
  classifyUserFacingRuntimeLimitFailure,
  resetUserFacingRuntimeLimitSuppressionsForTest,
  runRuntimeEventLoop,
  shouldSuppressUserFacingRuntimeLimitFailure,
} from "./host-event-loop.js";
import { getRuntimeLiveStateForSession } from "./live-state.js";
import type { RuntimeRecoveryExhaustedAlertInput } from "./runtime-recovery-alert.js";
import { buildRuntimeStartRequest, resolveRuntimeCredentialUpstreamProvider } from "./runtime-request-builder.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";
import type {
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeProviderId,
  RuntimeSessionHandle,
  RuntimeSkillVisibilitySnapshot,
  SessionRuntimeProvider,
} from "./types.js";

let stateDir: string | null = null;
let crashRecovery: RuntimeCrashRecoveryCoordinator;

const SESSION_KEY = "agent:main:main";
const SESSION_NAME = "trace-runtime";
const AGENT_ID = "main";
const PROVIDER: RuntimeProviderId = "trace-provider";
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
  supportsPlugins: true,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};

const source: RuntimeMessageTarget = {
  channel: "whatsapp",
  accountId: "main",
  instanceId: "instance-1",
  chatId: "5511999999999",
  canonicalChatId: "chat_1",
  actorType: "contact",
  contactId: "contact_1",
  platformIdentityId: "pi_contact_1",
  rawSenderId: "5511999999999@s.whatsapp.net",
  normalizedSenderId: "5511999999999",
  identityConfidence: 1,
  identityProvenance: { source: "test" },
  sourceMessageId: "wamid-1",
};

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: AGENT_ID,
    cwd: stateDir ?? "/tmp",
    provider: PROVIDER,
    settingSources: ["project"],
    ...overrides,
  };
}

function makeSession(): SessionEntry {
  return {
    sessionKey: SESSION_KEY,
    name: SESSION_NAME,
    agentId: AGENT_ID,
    agentCwd: stateDir ?? "/tmp",
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeStreamingSession(overrides: Partial<RuntimeHostStreamingSession> = {}): RuntimeHostStreamingSession {
  const abortController = new AbortController();
  return {
    agentId: AGENT_ID,
    queryHandle: makeRuntimeSession([]),
    starting: false,
    abortController,
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentSource: source,
    currentModel: MODEL,
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
    traceRunId: "run-1",
    toolEffectFence: "host_write_ahead",
    ...overrides,
  };
}

function makeRuntimeSession(
  events: RuntimeEvent[],
  options: Pick<RuntimeSessionHandle, "ambiguousTurnRecoveryStrategy"> = {},
): RuntimeSessionHandle {
  return {
    provider: PROVIDER,
    events: (async function* () {
      for (const event of events) {
        yield event;
      }
    })(),
    interrupt: async () => {},
    ...options,
  };
}

function makeNeverEndingRuntimeSession(
  lifecycle?: string[],
  options: Pick<RuntimeSessionHandle, "ambiguousTurnRecoveryStrategy"> = {},
): RuntimeSessionHandle {
  let resolveClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  return {
    provider: PROVIDER,
    events: {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            await closed;
            return { done: true, value: undefined };
          },
        };
      },
    },
    interrupt: async () => {
      lifecycle?.push("interrupt");
    },
    close: async () => {
      lifecycle?.push("close");
      resolveClose();
    },
    ...options,
  };
}

function makeSkillVisibility(state: "advertised" | "loaded" = "loaded"): RuntimeSkillVisibilitySnapshot {
  return {
    skills: [
      {
        id: "trace-skill",
        provider: PROVIDER,
        state,
        confidence: state === "loaded" ? "observed" : "declared",
        source: "test",
        loadedAt: state === "loaded" ? 123 : null,
        lastSeenAt: 123,
      },
    ],
    loadedSkills: state === "loaded" ? ["trace-skill"] : [],
    updatedAt: 123,
  };
}

function makeRaviTaskSkillVisibility(): RuntimeSkillVisibilitySnapshot {
  return {
    skills: [
      {
        id: "ravi-system-tasks",
        provider: "codex",
        state: "advertised",
        confidence: "declared",
        source: "codex:sync",
        evidence: [{ kind: "system-prompt", observedAt: 100, detail: "test catalog" }],
        loadedAt: null,
        lastSeenAt: 100,
      },
    ],
    loadedSkills: [],
    updatedAt: 100,
  };
}

function makeLoadedRaviTaskSkillVisibility(): RuntimeSkillVisibilitySnapshot {
  return {
    skills: [
      {
        id: "ravi-system-tasks",
        provider: "codex",
        state: "loaded",
        confidence: "observed",
        source: "catalog:ravi-system/tasks",
        evidence: [{ kind: "skill-gate", observedAt: 100, detail: "delivered by skill gate for Bash" }],
        loadedAt: 100,
        lastSeenAt: 100,
      },
    ],
    loadedSkills: ["ravi-system-tasks"],
    updatedAt: 100,
  };
}

function seedRuntimeCredentialAttempt(id: string) {
  const credential = createRuntimeCredential({
    id,
    label: `Credential ${id}`,
    runtimeProvider: PROVIDER,
    upstreamProvider: "openai",
    authMethod: "api-key",
    bindings: [
      {
        sourceKind: "env",
        targetKind: "env",
        targetName: "OPENAI_API_KEY",
        secretRef: `env:${id.toUpperCase()}_SECRET`,
        sourceHint: `${id.toUpperCase()}_SECRET`,
        sensitive: true,
        remoteForward: false,
      },
    ],
  });
  const attemptId = reserveRuntimeCredentialAttempt({
    credentialId: credential.id,
    sessionKey: SESSION_KEY,
    sessionName: SESSION_NAME,
    runId: "run-1",
    runtimeProvider: credential.runtimeProvider,
    upstreamProvider: credential.upstreamProvider,
    model: MODEL,
  });

  return {
    attemptId,
    credentialId: credential.id,
    label: credential.label,
    fingerprint: credential.fingerprint,
    runtimeProvider: credential.runtimeProvider,
    ...(credential.upstreamProvider ? { upstreamProvider: credential.upstreamProvider } : {}),
    ...(credential.authMethod ? { authMethod: credential.authMethod } : {}),
    ...(credential.sessionCompatibilityKey ? { sessionCompatibilityKey: credential.sessionCompatibilityKey } : {}),
    resolvedEnv: {},
    sensitiveEnvKeys: credential.sensitiveEnvKeys,
    remoteForwardEnvKeys: credential.remoteForwardEnvKeys,
    bindings: credential.bindings,
  };
}

function seedAdapterTrace(streaming: RuntimeHostStreamingSession, turnId = "turn-1"): void {
  const trace = recordAdapterRequestTrace({
    sessionKey: SESSION_KEY,
    sessionName: SESSION_NAME,
    agentId: AGENT_ID,
    runId: streaming.traceRunId,
    turnId,
    provider: PROVIDER,
    model: MODEL,
    prompt: "hello runtime",
    systemPrompt: "## Identidade\n\nVoce e Ravi.",
    cwd: stateDir ?? "/tmp",
    resume: false,
    fork: false,
    source,
    deliveryBarrier: "after_tool",
    hasHooks: false,
    pluginNames: [],
    mcpServerNames: [],
    hasRemoteSpawn: false,
    toolAccessMode: "restricted",
    capabilitySummary: { ...capabilities },
  });

  if (!trace) {
    throw new Error("adapter trace was not recorded");
  }

  streaming.currentTraceTurnId = trace.turnId;
  streaming.currentTraceTurnStartedAt = trace.startedAt;
  streaming.currentTraceUserPromptSha256 = trace.userPromptSha256;
  streaming.currentTraceSystemPromptSha256 = trace.systemPromptSha256;
  streaming.currentTraceRequestBlobSha256 = trace.requestBlobSha256;
  streaming.currentTraceTurnTerminalRecorded = false;
  const provenance = classifyTurnProvenance({ source: streaming.currentSource });
  const attempt = crashRecovery.startTurnAttempt({
    turnId: trace.turnId,
    runId: streaming.traceRunId ?? "run-1",
    sessionKey: SESSION_KEY,
    sessionName: SESSION_NAME,
    agentId: AGENT_ID,
    provider: PROVIDER,
    model: streaming.currentModel,
    startedAt: trace.startedAt,
    requestBlobSha256: trace.requestBlobSha256,
    userPromptSha256: trace.userPromptSha256,
    systemPromptSha256: trace.systemPromptSha256,
    originKind: provenance.origin,
    source: streaming.currentSource ?? null,
    turnProvenance: provenance,
    deliveryBarrier: "after_tool",
    pendingIds: streaming.currentTurnPendingIds ?? [],
  });
  streaming.currentCrashRecoveryAttemptId = attempt.attemptId;
  bindRuntimeCredentialAttemptTurn(streaming.currentRuntimeCredential?.attemptId, turnId);
  markRuntimeCredentialAttemptStarted(streaming.currentRuntimeCredential?.attemptId);
}

async function runTraceLoop(
  streaming: RuntimeHostStreamingSession,
  runtimeSession: RuntimeSessionHandle,
  overrides: Partial<Parameters<typeof runRuntimeEventLoop>[0]> = {},
): Promise<void> {
  await runRuntimeEventLoop({
    runId: streaming.traceRunId ?? "run-1",
    sessionName: SESSION_NAME,
    session: makeSession(),
    agent: makeAgent(),
    streaming,
    runtimeSession,
    runtimeCapabilities: capabilities,
    model: MODEL,
    instanceId: "test-instance",
    defaultRuntimeProviderId: "claude",
    streamingSessions: new Map([[SESSION_NAME, streaming]]),
    stashedMessages: new Map(),
    safeEmit: async () => {},
    drainPendingStarts: () => {},
    crashRecovery,
    ...overrides,
  });
}

describe("runtime session trace instrumentation", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-trace-test-");
    getOrCreateSession(SESSION_KEY, AGENT_ID, stateDir ?? "/tmp");
    crashRecovery = new RuntimeCrashRecoveryCoordinator({ instanceId: "trace-test" });
    crashRecovery.start();
    resetUserFacingRuntimeLimitSuppressionsForTest();
  });

  afterEach(async () => {
    resetUserFacingRuntimeLimitSuppressionsForTest();
    if (crashRecovery.acceptingDeliveries) {
      crashRecovery.stopGracefully("test_cleanup");
    }
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("records adapter.request with prompt blobs when the runtime prompt generator yields", async () => {
    const rulesDir = join(stateDir ?? "/tmp", ".ravi", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(stateDir ?? "/tmp", "AGENTS.md"), "# Trace Workspace\n\nTrace workspace instruction.\n");
    writeFileSync(join(rulesDir, "project-tracking.md"), "Trace Ravi rule.\n");

    const streaming = makeStreamingSession({
      pendingMessages: [
        createQueuedRuntimeUserMessage({
          prompt: "hello trace",
          deliveryBarrier: "after_tool",
          taskBarrierTaskId: "task-1",
        }),
      ],
    });
    const provider: SessionRuntimeProvider = {
      id: PROVIDER,
      getCapabilities: () => capabilities,
      startSession: () => makeRuntimeSession([]),
    };

    const { runtimeRequest } = await buildRuntimeStartRequest({
      runId: "run-build-1",
      sessionName: SESSION_NAME,
      prompt: {
        prompt: "hello trace",
        source,
        taskBarrierTaskId: "task-1",
        deliveryBarrier: "after_tool",
      },
      session: makeSession(),
      agent: makeAgent({ systemPromptAppend: "Trace agent instruction." }),
      runtimeProviderId: PROVIDER,
      runtimeProvider: provider,
      runtimeCapabilities: capabilities,
      sessionCwd: stateDir ?? "/tmp",
      dbSessionKey: SESSION_KEY,
      model: MODEL,
      runtimeResolution: {
        options: { model: MODEL, effort: "high", thinking: "normal" },
        sources: { model: "agent_default", effort: "task_override", thinking: "task_override" },
        hasTaskRuntimeContext: true,
      },
      storedRuntimeSessionParams: undefined,
      canResumeStoredSession: false,
      resolvedSource: source,
      streamingSession: streaming,
      stashedMessages: new Map(),
      defaultRuntimeProviderId: "claude",
      crashRecovery,
    });

    expect(runtimeRequest.env).toMatchObject({
      RAVI_INSTANCE_ID: "instance-1",
      RAVI_CANONICAL_CHAT_ID: "chat_1",
      RAVI_ACTOR_TYPE: "contact",
      RAVI_CONTACT_ID: "contact_1",
      RAVI_PLATFORM_IDENTITY_ID: "pi_contact_1",
      RAVI_RAW_SENDER_ID: "5511999999999@s.whatsapp.net",
      RAVI_NORMALIZED_SENDER_ID: "5511999999999",
    });

    const yielded = await runtimeRequest.prompt.next();
    expect(yielded.value?.message.content).toBe("hello trace");
    const attemptId = streaming.currentCrashRecoveryAttemptId;
    expect(attemptId).toBeTruthy();
    expect(getRuntimeTurnAttempt(attemptId!)).toMatchObject({
      status: "running",
      sessionKey: SESSION_KEY,
      sessionName: SESSION_NAME,
      agentId: AGENT_ID,
      provider: PROVIDER,
      model: MODEL,
      originKind: "task",
      deliveryBarrier: "after_tool",
      taskBarrierTaskId: "task-1",
      pendingIds: [streaming.currentTurnPendingIds?.[0]],
      startedTool: false,
      materializedOutput: false,
    });
    streaming.done = true;
    streaming.onTurnComplete?.();
    await runtimeRequest.prompt.return?.(undefined);

    const events = listSessionEvents(SESSION_KEY);
    const adapterRequest = events.find((event) => event.eventType === "adapter.request");
    expect(adapterRequest?.messageId).toBe("wamid-1");
    expect(adapterRequest).toMatchObject({
      canonicalChatId: "chat_1",
      actorType: "contact",
      contactId: "contact_1",
      platformIdentityId: "pi_contact_1",
      rawSenderId: "5511999999999@s.whatsapp.net",
      normalizedSenderId: "5511999999999",
      identityConfidence: 1,
      identityProvenance: { source: "test" },
    });
    expect(adapterRequest?.payloadJson).toMatchObject({
      run_id: "run-build-1",
      session_key: SESSION_KEY,
      provider: PROVIDER,
      model: MODEL,
      effort: "high",
      thinking: "normal",
      model_source: "agent_default",
      effort_source: "task_override",
      thinking_source: "task_override",
      cwd: stateDir,
      delivery_barrier: "after_tool",
      task_barrier_task_id: "task-1",
      tool_access_mode: "restricted",
      turn_provenance: {
        origin: "task",
        background: true,
        automationOriginated: true,
        automationId: "task:task-1",
        reason: "prompt.taskBarrierTaskId",
      },
    });
    expect(streaming.currentTurnProvenance).toMatchObject({ origin: "task", background: true });

    const turn = getSessionTurn(streaming.currentTraceTurnId ?? "");
    expect(turn?.status).toBe("running");
    const systemPrompt = getSessionTraceBlob(turn?.systemPromptSha256 ?? "")?.contentText;
    expect(systemPrompt).toContain("## Identidade");
    expect(systemPrompt).toContain("## Workspace Instructions");
    expect(systemPrompt).toContain("Trace workspace instruction.");
    expect(systemPrompt).toContain("## Ravi Rules");
    expect(systemPrompt).toContain("Trace Ravi rule.");
    expect(systemPrompt).toContain("## Agent Instructions");
    expect(systemPrompt).toContain("Trace agent instruction.");
    expect(getSessionTraceBlob(turn?.userPromptSha256 ?? "")?.contentText).toBe("hello trace");
    expect(getSessionTraceBlob(turn?.requestBlobSha256 ?? "")?.contentJson).toMatchObject({
      user_prompt_chars: "hello trace".length,
      system_prompt_sha256: turn?.systemPromptSha256,
      user_prompt_sha256: turn?.userPromptSha256,
      system_prompt_section_metadata: expect.arrayContaining([
        expect.objectContaining({
          id: "workspace.instructions",
          title: "Workspace Instructions",
          source: join(stateDir ?? "/tmp", "AGENTS.md"),
          chars: expect.any(Number),
          sha256: expect.any(String),
        }),
        expect.objectContaining({
          id: "ravi.rules",
          title: "Ravi Rules",
          source: rulesDir,
          chars: expect.any(Number),
          sha256: expect.any(String),
        }),
        expect.objectContaining({
          id: "agent.system_prompt_append",
          title: "Agent Instructions",
          source: "agent:main:systemPromptAppend",
          chars: "Trace agent instruction.".length,
          sha256: expect.any(String),
        }),
      ]),
    });
  });

  it("blocks invisible provider env fallback when a managed credential pool cannot resolve", async () => {
    createRuntimeCredential({
      id: "rcred_trace_missing",
      label: "Trace missing secret",
      runtimeProvider: PROVIDER,
      upstreamProvider: "openai",
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "OPENAI_API_KEY",
          secretRef: "env:RAVI_TRACE_MISSING_OPENAI_KEY",
          sourceHint: "RAVI_TRACE_MISSING_OPENAI_KEY",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });

    const streaming = makeStreamingSession({
      pendingMessages: [
        createQueuedRuntimeUserMessage({
          prompt: "hello trace",
          deliveryBarrier: "after_tool",
        }),
      ],
    });
    const provider: SessionRuntimeProvider = {
      id: PROVIDER,
      getCapabilities: () => capabilities,
      startSession: () => makeRuntimeSession([]),
    };

    await expect(
      buildRuntimeStartRequest({
        runId: "run-build-missing-credential",
        sessionName: SESSION_NAME,
        prompt: {
          prompt: "hello trace",
          source,
          deliveryBarrier: "after_tool",
        },
        session: makeSession(),
        agent: makeAgent(),
        runtimeProviderId: PROVIDER,
        runtimeProvider: provider,
        runtimeCapabilities: capabilities,
        sessionCwd: stateDir ?? "/tmp",
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
        crashRecovery,
      }),
    ).rejects.toThrow("No managed runtime credential could be resolved");
  });

  it("infers upstream provider and maps Codex auth profiles into the runtime env", async () => {
    const previousCodexProvider = process.env.RAVI_CODEX_PROVIDER;
    const previousPiProvider = process.env.RAVI_PI_PROVIDER;
    const previousClaudeProvider = process.env.RAVI_CLAUDE_UPSTREAM_PROVIDER;
    delete process.env.RAVI_CODEX_PROVIDER;
    delete process.env.RAVI_PI_PROVIDER;
    delete process.env.RAVI_CLAUDE_UPSTREAM_PROVIDER;

    createRuntimeCredential({
      id: "rcred_codex_profile",
      label: "Codex profile",
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      authMethod: "codex-profile",
      sourceKind: "provider-profile",
      authProfileRef: "~/ravi-test-codex-home",
      bindings: [
        {
          sourceKind: "provider-profile",
          targetKind: "auth-profile",
          targetName: "profile",
          secretRef: "file:~/ravi-test-codex-home",
          sourceHint: "~/ravi-test-codex-home",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });

    const streaming = makeStreamingSession({
      pendingMessages: [
        createQueuedRuntimeUserMessage({
          prompt: "hello codex profile",
          deliveryBarrier: "after_tool",
        }),
      ],
    });
    const provider: SessionRuntimeProvider = {
      id: "codex",
      getCapabilities: () => capabilities,
      startSession: () => makeRuntimeSession([]),
    };

    try {
      const { runtimeRequest, runtimeCredentialAttempt } = await buildRuntimeStartRequest({
        runId: "run-build-codex-profile",
        sessionName: SESSION_NAME,
        prompt: {
          prompt: "hello codex profile",
          source,
          deliveryBarrier: "after_tool",
        },
        session: makeSession(),
        agent: makeAgent({ provider: "codex" }),
        runtimeProviderId: "codex",
        runtimeProvider: provider,
        runtimeCapabilities: capabilities,
        sessionCwd: stateDir ?? "/tmp",
        dbSessionKey: SESSION_KEY,
        model: "gpt-5",
        runtimeResolution: {
          options: { model: "gpt-5" },
          sources: { model: "agent_default", effort: null, thinking: null },
          hasTaskRuntimeContext: false,
        },
        storedRuntimeSessionParams: undefined,
        canResumeStoredSession: false,
        resolvedSource: source,
        streamingSession: streaming,
        stashedMessages: new Map(),
        defaultRuntimeProviderId: "claude",
        crashRecovery,
      });

      expect(resolveRuntimeCredentialUpstreamProvider("codex", "gpt-5")).toBe("openai");
      expect(resolveRuntimeCredentialUpstreamProvider("pi", "kimi-coding/kimi-for-coding")).toBe("kimi-coding");
      expect(resolveRuntimeCredentialUpstreamProvider("claude", "sonnet")).toBe("anthropic");
      expect(runtimeCredentialAttempt?.credentialId).toBe("rcred_codex_profile");
      expect(runtimeRequest.env?.CODEX_HOME).toContain("ravi-test-codex-home");

      const yielded = await runtimeRequest.prompt.next();
      expect(yielded.value?.message.content).toBe("hello codex profile");
      streaming.done = true;
      streaming.onTurnComplete?.();
      await runtimeRequest.prompt.return?.(undefined);

      const attemptRow = getDb()
        .prepare("SELECT id, turn_id, status FROM runtime_credential_attempts WHERE credential_id = ?")
        .get("rcred_codex_profile") as { id: string; turn_id: string | null; status: string } | undefined;
      expect(attemptRow?.id).toBe(runtimeCredentialAttempt?.attemptId);
      expect(attemptRow?.turn_id).toBe(streaming.currentTraceTurnId);
      expect(attemptRow?.status).toBe("started");

      const adapterRequest = listSessionEvents(SESSION_KEY).find((event) => event.eventType === "adapter.request");
      expect(adapterRequest?.payloadJson).toMatchObject({
        runtime_credential: "[REDACTED]",
      });
    } finally {
      if (previousCodexProvider === undefined) delete process.env.RAVI_CODEX_PROVIDER;
      else process.env.RAVI_CODEX_PROVIDER = previousCodexProvider;
      if (previousPiProvider === undefined) delete process.env.RAVI_PI_PROVIDER;
      else process.env.RAVI_PI_PROVIDER = previousPiProvider;
      if (previousClaudeProvider === undefined) delete process.env.RAVI_CLAUDE_UPSTREAM_PROVIDER;
      else process.env.RAVI_CLAUDE_UPSTREAM_PROVIDER = previousClaudeProvider;
    }
  });

  it("records tool events and terminal turn.complete state from the runtime event loop", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming);
    const crashRecoveryAttemptId = streaming.currentCrashRecoveryAttemptId!;

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "tool.started",
          toolUse: { id: "tool-1", name: "Bash", input: { cmd: "rg trace" } },
        },
        {
          type: "tool.completed",
          toolUseId: "tool-1",
          toolName: "Bash",
          content: "ok",
        },
        {
          type: "turn.complete",
          providerSessionId: "provider-after",
          session: {
            displayId: "provider-after",
            params: {
              sessionId: "provider-after",
              skillVisibility: makeSkillVisibility("loaded"),
            },
          },
          usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheCreationTokens: 1 },
        },
      ]),
    );

    const events = listSessionEvents(SESSION_KEY);
    expect(events.map((event) => event.eventType)).toEqual([
      "adapter.request",
      "tool.start",
      "tool.end",
      "turn.complete",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.runId)).toEqual(["run-1", "run-1", "run-1", "run-1"]);
    expect(events.map((event) => event.turnId)).toEqual(["turn-1", "turn-1", "turn-1", "turn-1"]);
    const turn = getSessionTurn("turn-1");
    expect(turn?.status).toBe("complete");
    expect(turn?.providerSessionIdAfter).toBe("provider-after");
    expect(turn?.inputTokens).toBe(10);
    expect(turn?.outputTokens).toBe(4);
    expect(getRuntimeTurnAttempt(crashRecoveryAttemptId)).toMatchObject({
      status: "complete",
      completedAt: turn?.completedAt,
      startedTool: true,
      materializedOutput: false,
    });
    expect(getRuntimeLiveStateForSession(makeSession())?.loadedSkills).toEqual(["trace-skill"]);
    expect(
      (getSession(SESSION_KEY)?.runtimeSessionParams?.skillVisibility as RuntimeSkillVisibilitySnapshot).loadedSkills,
    ).toEqual(["trace-skill"]);
    expect(events[1]).toMatchObject({
      eventType: "tool.start",
      canonicalChatId: "chat_1",
      actorType: "contact",
      contactId: "contact_1",
    });
    expect(streaming.currentTraceTurnId).toBeUndefined();
    expect(streaming.currentCrashRecoveryTerminal).toMatchObject({
      status: "complete",
      startedTool: true,
      materializedOutput: false,
    });
  });

  it("marks the active credential attempt succeeded on a successful terminal turn", async () => {
    const streaming = makeStreamingSession({
      currentRuntimeCredential: seedRuntimeCredentialAttempt("rcred_success"),
    });
    seedAdapterTrace(streaming, "turn-success");

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.complete",
          providerSessionId: "provider-after",
          usage: { inputTokens: 2, outputTokens: 1 },
        },
      ]),
    );

    const attempt = getDb()
      .prepare("SELECT turn_id, status, completed_at FROM runtime_credential_attempts WHERE credential_id = ?")
      .get("rcred_success") as { turn_id: string | null; status: string; completed_at: number | null } | undefined;
    expect(attempt?.turn_id).toBe("turn-success");
    expect(attempt?.status).toBe("succeeded");
    expect(typeof attempt?.completed_at).toBe("number");
    expect(streaming.currentRuntimeCredential?.attemptId).toBeUndefined();
  });

  it("resets loaded skill visibility when compaction starts", async () => {
    const streaming = makeStreamingSession();
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const session = makeSession();
    session.runtimeProvider = PROVIDER;
    session.providerSessionId = "provider-before";
    session.runtimeSessionDisplayId = "provider-before";
    session.runtimeSessionParams = {
      sessionId: "provider-before",
      skillVisibility: makeSkillVisibility("loaded"),
    };

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "status",
          status: "compacting",
        },
      ]),
      {
        session,
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      },
    );

    const persisted = getSession(SESSION_KEY)?.runtimeSessionParams?.skillVisibility as RuntimeSkillVisibilitySnapshot;
    expect(persisted.loadedSkills).toEqual([]);
    expect(persisted.skills).toEqual([expect.objectContaining({ id: "trace-skill", state: "stale" })]);
    expect(getRuntimeLiveStateForSession(makeSession())?.loadedSkills).toEqual([]);
    expect(emitted.some((event) => event.data.type === "skill.visibility.reset")).toBe(true);
  });

  it("clears compaction when the provider leaves compacting status", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming);

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "status",
          status: "compacting",
        },
        {
          type: "status",
          status: "thinking",
        },
        {
          type: "turn.complete",
          providerSessionId: "provider-after",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    );

    const statusEvents = listSessionEvents(SESSION_KEY).filter((event) => event.eventType === "runtime.status");
    const compactingValues = statusEvents.map((event) => {
      const payload = event.payloadJson;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
      return payload.compacting;
    });
    expect(compactingValues).toEqual([true, false]);
    expect(streaming.compacting).toBe(false);
    expect(streaming.turnActive).toBe(false);
  });

  it("clears live busy state when the provider emits idle status", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming);

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "status",
          status: "idle",
        },
      ]),
    );

    const live = getRuntimeLiveStateForSession(makeSession());
    expect(live).toMatchObject({
      activity: "idle",
      summary: "runtime idle",
    });
    expect(live?.busySince).toBeUndefined();
    expect(live?.toolName).toBeUndefined();
  });

  it("clears compaction at terminal boundaries even without an idle status", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming);

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "status",
          status: "compacting",
        },
        {
          type: "turn.complete",
          providerSessionId: "provider-after",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    );

    expect(streaming.compacting).toBe(false);
    expect(streaming.turnActive).toBe(false);
  });

  function collectRuntimeStatusCompacting(): Array<unknown> {
    return listSessionEvents(SESSION_KEY)
      .filter((event) => event.eventType === "runtime.status")
      .map((event) => {
        const payload = event.payloadJson;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
        return payload.compacting;
      });
  }

  function attachSpeakingOutputChat(): void {
    const outputChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "compaction-gate@s.whatsapp.net",
      chatType: "dm",
      title: "compaction-gate",
    });
    attachChatToSession({ sessionKey: SESSION_KEY, chatId: outputChat.id, setOutputTarget: true });
  }

  const compactingThenIdle: RuntimeEvent[] = [
    { type: "status", status: "compacting" },
    { type: "status", status: "idle" },
    {
      type: "turn.complete",
      providerSessionId: "provider-after",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];

  it("emits external compaction announcements for a human/channel turn", async () => {
    attachSpeakingOutputChat();
    const streaming = makeStreamingSession({
      agentMode: "active",
      currentTurnProvenance: classifyTurnProvenance({ source }),
    });
    seedAdapterTrace(streaming);
    const attemptId = streaming.currentCrashRecoveryAttemptId!;

    const responses: string[] = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic: string, data: unknown) => {
      if (topic === `ravi.session.${SESSION_NAME}.response` && data && typeof data === "object") {
        const response = (data as { response?: unknown }).response;
        if (typeof response === "string") responses.push(response);
      }
    });

    try {
      await runTraceLoop(streaming, makeRuntimeSession(compactingThenIdle));
    } finally {
      emitSpy.mockRestore();
    }

    expect(responses.some((text) => text.includes("Compactando"))).toBe(true);
    expect(responses.some((text) => text.includes("compactada"))).toBe(true);
    expect(collectRuntimeStatusCompacting()).toEqual([true, false]);
    expect(getRuntimeTurnAttempt(attemptId)).toMatchObject({
      status: "complete",
      materializedOutput: true,
    });
  });

  for (const scenario of [
    { name: "cron", prompt: { _cron: true } },
    { name: "trigger", prompt: { _trigger: true } },
    { name: "session followup", prompt: { _sessionFollowup: true } },
    { name: "heartbeat", prompt: { _heartbeat: true } },
  ] as const) {
    it(`suppresses external compaction announcements for a ${scenario.name} turn while preserving trace observability`, async () => {
      attachSpeakingOutputChat();
      const streaming = makeStreamingSession({
        agentMode: "active",
        currentTurnProvenance: classifyTurnProvenance({
          prompt: scenario.prompt,
          source,
        }),
      });
      seedAdapterTrace(streaming);

      const responses: string[] = [];
      const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic: string, data: unknown) => {
        if (topic === `ravi.session.${SESSION_NAME}.response` && data && typeof data === "object") {
          const response = (data as { response?: unknown }).response;
          if (typeof response === "string") responses.push(response);
        }
      });

      try {
        await runTraceLoop(streaming, makeRuntimeSession(compactingThenIdle));
      } finally {
        emitSpy.mockRestore();
      }

      expect(responses.some((text) => text.includes("Compactando") || text.includes("compactada"))).toBe(false);
      // Internal observability MUST be preserved for automation origins.
      expect(collectRuntimeStatusCompacting()).toEqual([true, false]);
      const statusEvents = listSessionEvents(SESSION_KEY).filter((event) => event.eventType === "runtime.status");
      expect(
        statusEvents.every((event) => {
          const payload = event.payloadJson;
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
          return payload.externalAnnouncementsAllowed === false;
        }),
      ).toBe(true);
    });
  }

  it("marks a skill loaded when a ravi skills show command completes", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming);
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const runtimeSession = makeRuntimeSession([
      {
        type: "tool.started",
        toolUse: {
          id: "tool-skill",
          name: "shell",
          input: { command: "/bin/zsh -lc 'bin/ravi skills show tasks --json'" },
        },
        metadata: { turn: { id: "provider-turn" }, item: { id: "tool-skill", type: "command_execution" } },
      },
      {
        type: "tool.completed",
        toolUseId: "tool-skill",
        toolName: "shell",
        content: JSON.stringify({
          skill: {
            name: "tasks",
            source: "catalog:ravi-system/tasks",
            pluginName: "ravi-system",
            skillFilePath: "skills/tasks/SKILL.md",
            content: "---\nname: tasks\n---\n\n# Tasks\n",
          },
        }),
        metadata: { turn: { id: "provider-turn" }, item: { id: "tool-skill", type: "command_execution" } },
      },
      {
        type: "turn.complete",
        providerSessionId: "provider-after",
        session: {
          displayId: "provider-after",
          params: {
            sessionId: "provider-after",
          },
        },
        usage: { inputTokens: 10, outputTokens: 4 },
      },
    ]);
    runtimeSession.skillVisibility = makeRaviTaskSkillVisibility();

    await runTraceLoop(streaming, runtimeSession, {
      safeEmit: async (topic, data) => {
        emitted.push({ topic, data });
      },
    });

    const persisted = getSession(SESSION_KEY)?.runtimeSessionParams?.skillVisibility as RuntimeSkillVisibilitySnapshot;
    expect(persisted.loadedSkills).toEqual(["ravi-system-tasks"]);
    expect(persisted.skills).toEqual([
      expect.objectContaining({
        id: "ravi-system-tasks",
        state: "loaded",
        confidence: "observed",
        loadedAt: expect.any(Number),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            kind: "tool-call",
            eventType: "ravi.skills.show",
            itemId: "tool-skill",
          }),
        ]),
      }),
    ]);
    expect(getRuntimeLiveStateForSession(makeSession())?.loadedSkills).toEqual(["ravi-system-tasks"]);
    expect(emitted.some((event) => event.data.type === "skill.visibility.loaded")).toBe(true);
  });

  it("keeps skill-gate loaded state when provider turn completion reports only advertised skills", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming);
    const session = makeSession();
    session.runtimeProvider = PROVIDER;
    session.providerSessionId = "provider-before";
    session.runtimeSessionDisplayId = "provider-before";
    session.runtimeSessionParams = {
      sessionId: "provider-before",
      skillVisibility: makeLoadedRaviTaskSkillVisibility(),
    };

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.complete",
          providerSessionId: "provider-after",
          session: {
            displayId: "provider-after",
            params: {
              sessionId: "provider-after",
              skillVisibility: makeRaviTaskSkillVisibility(),
            },
          },
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      ]),
      { session },
    );

    const persisted = getSession(SESSION_KEY)?.runtimeSessionParams?.skillVisibility as RuntimeSkillVisibilitySnapshot;
    expect(persisted.loadedSkills).toEqual(["ravi-system-tasks"]);
    expect(persisted.skills).toEqual([expect.objectContaining({ id: "ravi-system-tasks", state: "loaded" })]);
    expect(getRuntimeLiveStateForSession(makeSession())?.loadedSkills).toEqual(["ravi-system-tasks"]);
  });

  it("keeps externally persisted skill-gate state when in-memory session params are stale", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming);
    const session = makeSession();
    session.runtimeProvider = PROVIDER;
    session.providerSessionId = "provider-before";
    session.runtimeSessionDisplayId = "provider-before";

    updateRuntimeProviderState(SESSION_KEY, PROVIDER, {
      providerSessionId: "provider-before",
      runtimeSessionDisplayId: "provider-before",
      runtimeSessionParams: {
        sessionId: "provider-before",
        skillVisibility: makeLoadedRaviTaskSkillVisibility(),
      },
    });

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.complete",
          providerSessionId: "provider-after",
          session: {
            displayId: "provider-after",
            params: {
              sessionId: "provider-after",
              skillVisibility: makeRaviTaskSkillVisibility(),
            },
          },
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      ]),
      { session },
    );

    const persisted = getSession(SESSION_KEY)?.runtimeSessionParams?.skillVisibility as RuntimeSkillVisibilitySnapshot;
    expect(persisted.loadedSkills).toEqual(["ravi-system-tasks"]);
    expect(persisted.skills).toEqual([expect.objectContaining({ id: "ravi-system-tasks", state: "loaded" })]);
    expect(getRuntimeLiveStateForSession(makeSession())?.loadedSkills).toEqual(["ravi-system-tasks"]);
  });

  it("does not persist raw stream lifecycle events in the trace ledger", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-raw-default");

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "provider.raw",
          rawEvent: { type: "item.started" },
          metadata: { nativeEvent: "item.started", item: { id: "msg-1", type: "agent_message" } },
        },
        {
          type: "assistant.message",
          text: "ok",
          metadata: { nativeEvent: "item.completed", item: { id: "msg-1", type: "agent_message" } },
        },
        {
          type: "turn.complete",
          providerSessionId: "provider-after",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    );

    expect(listSessionEvents(SESSION_KEY).map((event) => event.eventType)).toEqual([
      "adapter.request",
      "assistant.message",
      "turn.complete",
    ]);
  });

  it("releases a mixed assistant/tool raw envelope only after both durable safety markers", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-raw-write-ahead");
    const rawAssistant = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { cmd: "true" } },
          { type: "text", text: "accepted answer" },
        ],
      },
    };
    const rawTerminal = { type: "result", subtype: "success" };
    const order: string[] = [];
    const originalMark = crashRecovery.markTurnAttemptSafety.bind(crashRecovery);
    const markerSpy = spyOn(crashRecovery, "markTurnAttemptSafety").mockImplementation((input) => {
      order.push(input.materializedOutput ? "marker:output" : "marker:started");
      return originalMark(input);
    });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    try {
      await runTraceLoop(
        streaming,
        makeRuntimeSession([
          { type: "provider.raw", rawEvent: rawAssistant },
          {
            type: "tool.started",
            toolUse: { id: "tool-1", name: "Bash", input: { cmd: "true" } },
            rawEvent: rawAssistant,
          },
          { type: "assistant.message", text: "accepted answer", rawEvent: rawAssistant },
          { type: "provider.raw", rawEvent: rawTerminal },
          {
            type: "turn.complete",
            providerSessionId: "provider-after",
            usage: { inputTokens: 1, outputTokens: 1 },
            rawEvent: rawTerminal,
          },
        ]),
        {
          runtimeCapabilities: { ...capabilities, legacyEventTopicSuffix: "claude" },
          safeEmit: async (topic, data) => {
            if (topic.endsWith(".claude") && data.type === "assistant") order.push("emit:raw-assistant");
            emitted.push({ topic, data });
          },
        },
      );
    } finally {
      markerSpy.mockRestore();
    }

    expect(order).toEqual(["marker:started", "marker:output", "emit:raw-assistant"]);
    expect(
      emitted.find((entry) => entry.topic.endsWith(".runtime") && entry.data.type === "assistant.message")?.data,
    ).not.toHaveProperty("rawEvent");
  });

  it("drops a mixed Claude raw envelope when its assistant text is silent", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-raw-mixed-silent");
    const rawAssistant = {
      type: "assistant",
      secretText: "@@SILENT@@",
      message: { content: [{ type: "tool_use", id: "tool-silent", name: "Bash" }] },
    };
    const rawTerminal = { type: "result", subtype: "success", secretText: "must-not-escape" };
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        { type: "provider.raw", rawEvent: rawAssistant },
        {
          type: "tool.started",
          toolUse: { id: "tool-silent", name: "Bash" },
          rawEvent: rawAssistant,
        },
        { type: "assistant.message", text: "@@SILENT@@", rawEvent: rawAssistant },
        { type: "provider.raw", rawEvent: rawTerminal },
        {
          type: "turn.complete",
          providerSessionId: "provider-after",
          usage: { inputTokens: 1, outputTokens: 0 },
          rawEvent: rawTerminal,
        },
      ]),
      {
        runtimeCapabilities: { ...capabilities, legacyEventTopicSuffix: "claude" },
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      },
    );

    expect(emitted.some((entry) => entry.data.secretText !== undefined)).toBe(false);
    expect(emitted.some((entry) => entry.data.type === "provider.raw")).toBe(false);
    expect(emitted.some((entry) => entry.data.type === "assistant.message")).toBe(false);
    expect(emitted.some((entry) => entry.data.type === "silent")).toBe(true);
  });

  it("does not let Pi item lifecycle events release assistant raw content before response policy", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-pi-fallback-raw-silent");
    const rawMessageStart = {
      type: "message_start",
      secretText: "pi-fallback-start-must-not-escape",
      message: { role: "assistant", content: [{ type: "text", text: "@@SILENT@@" }] },
    };
    const rawMessageEnd = {
      type: "message_end",
      secretText: "pi-fallback-end-must-not-escape",
      message: { role: "assistant", content: [{ type: "text", text: "@@SILENT@@" }] },
    };
    const rawTerminal = { type: "agent_end" };
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        { type: "provider.raw", rawEvent: rawMessageStart },
        { type: "item.started", item: { id: "pi-message", type: "assistant" }, rawEvent: rawMessageStart },
        { type: "provider.raw", rawEvent: rawMessageEnd },
        { type: "item.completed", item: { id: "pi-message", type: "assistant" }, rawEvent: rawMessageEnd },
        { type: "assistant.message", text: "@@SILENT@@", rawEvent: rawMessageEnd },
        { type: "provider.raw", rawEvent: rawTerminal },
        {
          type: "turn.complete",
          providerSessionId: "provider-after",
          usage: { inputTokens: 1, outputTokens: 0 },
          rawEvent: rawTerminal,
        },
      ]),
      {
        runtimeCapabilities: { ...capabilities, legacyEventTopicSuffix: "pi" },
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      },
    );

    expect(emitted.some((entry) => entry.data.secretText !== undefined)).toBe(false);
    expect(emitted.some((entry) => entry.data.type === "assistant.message")).toBe(false);
    expect(emitted.some((entry) => entry.data.type === "silent")).toBe(true);
  });

  it("drops Pi tool-only assistant raw content until a real tool fence exists", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-pi-tool-only-raw");
    const rawMessageEnd = {
      type: "message_end",
      secretText: "pi-tool-call-before-fence",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "Bash", arguments: { cmd: "true" } }],
      },
    };
    const rawToolStart = { type: "tool_execution_start", toolName: "Bash", toolCallId: "tool-1" };
    const rawToolEnd = { type: "tool_execution_end", toolName: "Bash", toolCallId: "tool-1" };
    const rawTerminal = { type: "agent_end" };
    const order: string[] = [];
    const originalMark = crashRecovery.markTurnAttemptSafety.bind(crashRecovery);
    const markerSpy = spyOn(crashRecovery, "markTurnAttemptSafety").mockImplementation((input) => {
      if (input.startedTool) order.push("marker:started");
      return originalMark(input);
    });
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    try {
      await runTraceLoop(
        streaming,
        makeRuntimeSession([
          { type: "provider.raw", rawEvent: rawMessageEnd },
          { type: "item.completed", item: { id: "pi-tool-message", type: "assistant" }, rawEvent: rawMessageEnd },
          { type: "provider.raw", rawEvent: rawToolStart },
          {
            type: "tool.started",
            toolUse: { id: "tool-1", name: "Bash", input: { cmd: "true" } },
            rawEvent: rawToolStart,
          },
          { type: "provider.raw", rawEvent: rawToolEnd },
          {
            type: "tool.completed",
            toolUseId: "tool-1",
            toolName: "Bash",
            content: "ok",
            rawEvent: rawToolEnd,
          },
          { type: "provider.raw", rawEvent: rawTerminal },
          {
            type: "turn.complete",
            providerSessionId: "provider-after",
            usage: { inputTokens: 1, outputTokens: 0 },
            rawEvent: rawTerminal,
          },
        ]),
        {
          runtimeCapabilities: { ...capabilities, legacyEventTopicSuffix: "pi" },
          safeEmit: async (topic, data) => {
            if (topic.endsWith(".pi") && data.type === "tool_execution_start") order.push("emit:tool-start");
            emitted.push({ topic, data });
          },
        },
      );
    } finally {
      markerSpy.mockRestore();
    }

    expect(emitted.some((entry) => entry.data.secretText === "pi-tool-call-before-fence")).toBe(false);
    expect(order.indexOf("marker:started")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("emit:tool-start")).toBeGreaterThan(order.indexOf("marker:started"));
  });

  it("does not release a previously fenced raw envelope after ownership is lost", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-raw-ownership-race");
    const rawToolStart = { type: "tool_execution_start", secretText: "must-stay-owned" };
    const rawNext = { type: "tool_execution_end" };
    const ownershipFailure = new Error("attempt ownership lost");
    let lost = false;
    const failedCoordinator = {
      get acceptingDeliveries() {
        return !lost;
      },
      get ownershipFailure() {
        return lost ? ownershipFailure : null;
      },
      getActiveTurnAttempt: (attemptId: string) => crashRecovery.getActiveTurnAttempt(attemptId),
      markTurnAttemptSafety: (input: Parameters<RuntimeCrashRecoveryCoordinator["markTurnAttemptSafety"]>[0]) => {
        const marked = crashRecovery.markTurnAttemptSafety(input);
        lost = true;
        streaming.currentCrashRecoveryAttemptId = undefined;
        streaming.internalAbortReason = "crash_recovery_ownership_lost";
        return marked;
      },
    } as unknown as RuntimeCrashRecoveryCoordinator;
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        { type: "provider.raw", rawEvent: rawToolStart },
        {
          type: "tool.started",
          toolUse: { id: "tool-ownership", name: "Bash", input: { cmd: "true" } },
          rawEvent: rawToolStart,
        },
        { type: "provider.raw", rawEvent: rawNext },
      ]),
      {
        crashRecovery: failedCoordinator,
        runtimeCapabilities: { ...capabilities, legacyEventTopicSuffix: "pi" },
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      },
    );

    expect(emitted.some((entry) => entry.data.secretText === "must-stay-owned")).toBe(false);
  });

  it("drops provider raw envelopes that never correlate to a canonical boundary", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-raw-orphan");
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        { type: "provider.raw", rawEvent: { type: "unknown", secretText: "orphan-one" } },
        { type: "provider.raw", rawEvent: { type: "unknown", secretText: "orphan-two" } },
      ]),
      {
        runtimeCapabilities: { ...capabilities, legacyEventTopicSuffix: "claude" },
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      },
    );

    expect(emitted.some((entry) => entry.data.secretText !== undefined)).toBe(false);
    expect(emitted.some((entry) => entry.data.type === "provider.raw")).toBe(false);
  });

  it("keeps suppressed recoverable failures raw-free on the canonical runtime topic", async () => {
    const streaming = makeStreamingSession({ interrupted: true });
    seedAdapterTrace(streaming, "turn-suppressed-failure-raw");
    const rawFailure = { type: "error", message: "operation was aborted", secretText: "partial assistant" };
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        { type: "provider.raw", rawEvent: rawFailure },
        {
          type: "turn.failed",
          error: "operation was aborted",
          recoverable: true,
          rawEvent: rawFailure,
        },
      ]),
      {
        runtimeCapabilities: { ...capabilities, legacyEventTopicSuffix: "claude" },
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      },
    );

    const interrupted = emitted.find(
      (entry) => entry.topic.endsWith(".runtime") && entry.data.type === "turn.interrupted",
    );
    expect(interrupted?.data).not.toHaveProperty("rawEvent");
    expect(emitted.some((entry) => entry.data.secretText !== undefined)).toBe(false);
  });

  it("persists final assistant output without concatenating commentary", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-final-with-commentary");

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "assistant.message",
          text: "Checking the durable state.",
          metadata: {
            item: {
              id: "commentary-a",
              phase: "commentary",
            },
          },
        },
        {
          type: "assistant.message",
          text: "Final answer only.",
          metadata: {
            item: {
              id: "final-a",
              phase: "final_answer",
            },
          },
        },
        {
          type: "turn.complete",
          providerSessionId: "provider-after",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    );

    expect(
      getRecentHistory(SESSION_NAME)
        .filter(({ role }) => role === "assistant")
        .map(({ content }) => content),
    ).toEqual(["Final answer only."]);
  });

  it("records provider turn interruptions as terminal interrupted turns", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-interrupted");

    await runTraceLoop(streaming, makeRuntimeSession([{ type: "turn.interrupted" }]));

    const terminal = listSessionEvents(SESSION_KEY).find((event) => event.eventType === "turn.interrupted");
    expect(terminal?.status).toBe("interrupted");
    expect(terminal?.payloadJson).toMatchObject({ abort_reason: "provider_interrupted" });
    expect(getSessionTurn("turn-interrupted")?.status).toBe("interrupted");
  });

  it("drops an interrupted physical turn after durable tool activity while preserving its successor", async () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "unsafe tool turn", source, _agentId: AGENT_ID });
    const successor = createQueuedRuntimeUserMessage({ prompt: "safe successor", source, _agentId: AGENT_ID });
    const streaming = makeStreamingSession({
      pendingMessages: [active, successor],
      currentTurnPendingIds: active.pendingId ? [active.pendingId] : [],
    });
    seedAdapterTrace(streaming, "turn-interrupted-after-tool");
    const attemptId = streaming.currentCrashRecoveryAttemptId!;

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "tool.started",
          toolUse: { id: "tool-interrupted", name: "Bash", input: { cmd: "touch unsafe" } },
        },
        { type: "turn.interrupted" },
      ]),
    );

    expect(streaming.pendingMessages.map((message) => message.message.content)).toEqual(["safe successor"]);
    expect(getRuntimeTurnAttempt(attemptId)).toMatchObject({
      status: "interrupted",
      startedTool: true,
      materializedOutput: false,
    });
  });

  it("drops an interrupted physical turn after durable output while preserving its successor", async () => {
    const active = createQueuedRuntimeUserMessage({ prompt: "partially answered turn", source, _agentId: AGENT_ID });
    const successor = createQueuedRuntimeUserMessage({ prompt: "safe successor", source, _agentId: AGENT_ID });
    const streaming = makeStreamingSession({
      pendingMessages: [active, successor],
      currentTurnPendingIds: active.pendingId ? [active.pendingId] : [],
    });
    seedAdapterTrace(streaming, "turn-interrupted-after-output");
    const attemptId = streaming.currentCrashRecoveryAttemptId!;

    await runTraceLoop(
      streaming,
      makeRuntimeSession([{ type: "text.delta", text: "partial result" }, { type: "turn.interrupted" }]),
    );

    expect(streaming.pendingMessages.map((message) => message.message.content)).toEqual(["safe successor"]);
    expect(getRuntimeTurnAttempt(attemptId)).toMatchObject({
      status: "interrupted",
      startedTool: false,
      materializedOutput: true,
    });
  });

  it("replays a pending user turn when the provider stream closes without a terminal event before tools", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "received from slack",
      deliveryBarrier: "after_response",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      currentTurnToolStarted: false,
      toolRunning: false,
    });
    seedAdapterTrace(streaming, "turn-stream-closed-before-tool");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(streaming, makeRuntimeSession([]), {
      stashedMessages,
      restartStashedSession: async (input) => {
        restartRequests.push(input);
      },
    });

    expect(stashedMessages.get(SESSION_NAME)?.map((message) => message.message.content)).toEqual([
      "received from slack",
    ]);
    expect(restartRequests).toEqual([{ sessionName: SESSION_NAME, reason: "runtime_event_loop_closed" }]);

    const terminal = listSessionEvents(SESSION_KEY).find((event) => event.eventType === "turn.interrupted");
    expect(terminal?.status).toBe("aborted");
    expect(terminal?.payloadJson).toMatchObject({
      abort_reason: "runtime_event_loop_closed",
      autoRecovered: true,
    });
    expect(getSessionTurn("turn-stream-closed-before-tool")?.status).toBe("aborted");
  });

  it("reconciles an unsafe ambiguous turn only when the provider advertises support", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "reconcile provider-owned turn",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    queued.clientMessageId = "ravi:provider-reconciliation";
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      toolEffectFence: "provider_event_only",
    });
    seedAdapterTrace(streaming, "turn-provider-reconciliation");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([], {
        ambiguousTurnRecoveryStrategy: "reconcile_by_client_message_id",
      }),
      {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
      },
    );

    expect(stashedMessages.get(SESSION_NAME)).toEqual([
      expect.objectContaining({
        clientMessageId: "ravi:provider-reconciliation",
        replay: true,
        terminalReplayAllowed: false,
      }),
    ]);
    expect(restartRequests).toEqual([{ sessionName: SESSION_NAME, reason: "runtime_event_loop_closed" }]);
  });

  it("does not hand an unsafe ambiguous turn to a provider without reconciliation support", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "do not blindly replay provider-owned turn",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      toolEffectFence: "provider_event_only",
    });
    seedAdapterTrace(streaming, "turn-provider-without-reconciliation");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(streaming, makeRuntimeSession([]), {
      stashedMessages,
      restartStashedSession: async (input) => {
        restartRequests.push(input);
      },
    });

    expect(stashedMessages.get(SESSION_NAME)).toBeUndefined();
    expect(restartRequests).toEqual([]);
  });

  it("does not replay a turn after streamed output was durably materialized", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "do not duplicate partial output",
      deliveryBarrier: "after_response",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      currentTurnToolStarted: false,
      toolRunning: false,
    });
    seedAdapterTrace(streaming, "turn-stream-closed-after-output");
    const attemptId = streaming.currentCrashRecoveryAttemptId!;
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(streaming, makeRuntimeSession([{ type: "text.delta", text: "partial answer" }]), {
      stashedMessages,
      restartStashedSession: async (input) => {
        restartRequests.push(input);
      },
    });

    expect(stashedMessages.get(SESSION_NAME)).toBeUndefined();
    expect(restartRequests).toEqual([]);
    expect(getRuntimeTurnAttempt(attemptId)).toMatchObject({
      status: "aborted",
      materializedOutput: true,
    });
  });

  it("fails before projecting provider output when the durable attempt binding is missing", async () => {
    const streaming = makeStreamingSession();
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    await expect(
      runTraceLoop(streaming, makeRuntimeSession([{ type: "text.delta", text: "must not escape" }]), {
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      }),
    ).rejects.toThrow("Crash recovery attempt binding missing before provider side effect");

    expect(emitted).toEqual([]);
  });

  it("does not persist or project an accepted assistant message before its output marker", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-assistant-marker-failure");
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const markerSpy = spyOn(crashRecovery, "markTurnAttemptSafety").mockImplementation(() => {
      throw new Error("output marker unavailable");
    });

    try {
      await expect(
        runTraceLoop(streaming, makeRuntimeSession([{ type: "assistant.message", text: "must not materialize" }]), {
          safeEmit: async (topic, data) => {
            emitted.push({ topic, data });
          },
        }),
      ).rejects.toThrow("output marker unavailable");
    } finally {
      markerSpy.mockRestore();
    }

    expect(listSessionEvents(SESSION_KEY).some((event) => event.eventType === "assistant.message")).toBe(false);
    expect(emitted.some((entry) => entry.data.type === "assistant.message")).toBe(false);
  });

  it("fails closed when a provider terminal arrives without its durable attempt binding", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-terminal-without-binding");
    const attemptId = streaming.currentCrashRecoveryAttemptId!;
    streaming.currentCrashRecoveryAttemptId = undefined;

    await expect(
      runTraceLoop(
        streaming,
        makeRuntimeSession([
          {
            type: "turn.complete",
            providerSessionId: "provider-terminal-without-binding",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ]),
      ),
    ).rejects.toThrow("Crash recovery attempt binding missing before terminal provider state");

    expect(getRuntimeTurnAttempt(attemptId)).toMatchObject({ status: "running", completedAt: null });
    expect(getSessionTurn("turn-terminal-without-binding")).toMatchObject({ status: "running", completedAt: null });
  });

  it("always closes provider resources after crash recovery ownership is lost", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-ownership-lost");
    let iteratorReturnCalls = 0;
    let handleCloseCalls = 0;
    let emitted = false;
    let delivered = false;
    const iterator: AsyncIterator<RuntimeEvent> & AsyncIterable<RuntimeEvent> = {
      next: async () => {
        if (delivered) return { done: true, value: undefined as never };
        delivered = true;
        return { done: false, value: { type: "text.delta", text: "must stay fenced" } };
      },
      return: async () => {
        iteratorReturnCalls++;
        return { done: true, value: undefined as never };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const runtimeSession: RuntimeSessionHandle = {
      provider: PROVIDER,
      events: iterator,
      interrupt: async () => {},
      close: async () => {
        handleCloseCalls++;
      },
    };
    const ownershipFailure = new Error("lost marker fence");
    const failedCoordinator = {
      acceptingDeliveries: false,
      ownershipFailure,
      markTurnAttemptSafety: () => {
        streaming.currentCrashRecoveryAttemptId = undefined;
        streaming.internalAbortReason = "crash_recovery_ownership_lost";
        streaming.abortController.abort();
        throw ownershipFailure;
      },
    } as unknown as RuntimeCrashRecoveryCoordinator;
    const streamingSessions = new Map([[SESSION_NAME, streaming]]);

    await expect(
      runTraceLoop(streaming, runtimeSession, {
        crashRecovery: failedCoordinator,
        streamingSessions,
        safeEmit: async () => {
          emitted = true;
        },
      }),
    ).rejects.toThrow("lost marker fence");

    expect(emitted).toBe(false);
    expect(streaming.abortController.signal.aborted).toBe(true);
    expect(handleCloseCalls).toBe(1);
    expect(iteratorReturnCalls).toBe(1);
    expect(streamingSessions.has(SESSION_NAME)).toBe(false);
  });

  it("does not fabricate a terminal latch or trace after ownership is already lost", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-terminal-after-ownership-loss");
    const attemptId = streaming.currentCrashRecoveryAttemptId!;
    streaming.currentCrashRecoveryAttemptId = undefined;
    const failedCoordinator = {
      acceptingDeliveries: false,
      ownershipFailure: new Error("lost durable ownership"),
    } as unknown as RuntimeCrashRecoveryCoordinator;
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.complete",
          providerSessionId: "provider-after-loss",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
      {
        crashRecovery: failedCoordinator,
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      },
    );

    expect(emitted).toEqual([]);
    expect(getRuntimeTurnAttempt(attemptId)).toMatchObject({ status: "running", completedAt: null });
    expect(getSessionTurn("turn-terminal-after-ownership-loss")).toMatchObject({
      status: "running",
      completedAt: null,
    });
    expect(listSessionEvents(SESSION_KEY).map((event) => event.eventType)).toEqual(["adapter.request"]);
  });

  it("does not replay a turn after durable tool authorization without a provider tool event", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "do not duplicate authorized tool",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      currentTurnToolStarted: false,
      toolRunning: false,
    });
    seedAdapterTrace(streaming, "turn-stream-closed-after-tool-allow");
    const attemptId = streaming.currentCrashRecoveryAttemptId!;
    crashRecovery.markTurnAttemptSafety({ attemptId, startedTool: true });
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(streaming, makeRuntimeSession([]), {
      stashedMessages,
      restartStashedSession: async (input) => {
        restartRequests.push(input);
      },
    });

    expect(stashedMessages.get(SESSION_NAME)).toBeUndefined();
    expect(restartRequests).toEqual([]);
    expect(getRuntimeTurnAttempt(attemptId)).toMatchObject({
      status: "aborted",
      startedTool: true,
    });
  });

  it("stashes and bounded-restarts pending input after durable turn preparation fails", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "retry durable handoff",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      durableTurnPreparationFailed: true,
    });
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(streaming, makeRuntimeSession([]), {
      stashedMessages,
      restartStashedSession: async (input) => {
        restartRequests.push(input);
      },
    });

    expect(stashedMessages.get(SESSION_NAME)?.map((message) => message.message.content)).toEqual([
      "retry durable handoff",
    ]);
    expect(restartRequests).toEqual([{ sessionName: SESSION_NAME, reason: "runtime_event_loop_closed" }]);
    expect(streaming.durableTurnPreparationFailed).toBe(false);
  });

  it("preserves durable turn input without locally retrying after crash recovery ownership is lost", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "do not retry without ownership",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      durableTurnPreparationFailed: true,
    });
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];
    const rejectedCoordinator = {
      acceptingDeliveries: false,
      ownershipFailure: new Error("lost ownership"),
    } as unknown as RuntimeCrashRecoveryCoordinator;

    await runTraceLoop(streaming, makeRuntimeSession([]), {
      crashRecovery: rejectedCoordinator,
      stashedMessages,
      restartStashedSession: async (input) => {
        restartRequests.push(input);
      },
    });

    expect(stashedMessages.get(SESSION_NAME)?.map((message) => message.message.content)).toEqual([
      "do not retry without ownership",
    ]);
    expect(restartRequests).toEqual([]);
  });

  it("restarts only the successor when a superseded provider turn closes without a terminal event", async () => {
    const superseded = createQueuedRuntimeUserMessage({
      prompt: "superseded work",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const successor = createQueuedRuntimeUserMessage({
      prompt: "new direction",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [superseded, successor],
      currentTurnPendingIds: superseded.pendingId ? [superseded.pendingId] : [],
      currentTurnSuperseded: true,
      currentTurnToolStarted: false,
      toolRunning: false,
      interrupted: true,
    });
    seedAdapterTrace(streaming, "turn-stream-closed-after-supersede");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(streaming, makeRuntimeSession([]), {
      stashedMessages,
      restartStashedSession: async (input) => {
        restartRequests.push(input);
      },
    });

    expect(stashedMessages.get(SESSION_NAME)?.map((message) => message.message.content)).toEqual(["new direction"]);
    expect(restartRequests).toEqual([{ sessionName: SESSION_NAME, reason: "runtime_event_loop_closed" }]);
  });

  it("records exhausted recovery without publishing a user-facing response", async () => {
    const alerts: RuntimeRecoveryExhaustedAlertInput[] = [];
    const runtimeEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const responseTopics: string[] = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic: string) => {
      if (topic.endsWith(".response")) responseTopics.push(topic);
    });
    const dispatcher = new RuntimeSessionDispatcher({
      instanceId: "trace-test",
      maxConcurrentSessions: 10,
      interactiveReservedSessions: 0,
      safeEmit: async (topic, data) => {
        runtimeEvents.push({ topic, data });
      },
      notifyRuntimeRecoveryExhausted: async (input) => {
        alerts.push(input);
      },
      getConfigModel: () => MODEL,
      crashRecovery,
    });
    dispatcher.stashedMessages.set(SESSION_KEY, [
      createQueuedRuntimeUserMessage({
        prompt: "retry this turn",
        source,
        _agentId: AGENT_ID,
        _runtimeProviderId: PROVIDER,
      }),
    ]);

    let starts = 0;
    dispatcher.startStreamingSession = async () => {
      starts++;
    };
    const recovery = dispatcher as unknown as {
      restartStashedSession(sessionName: string, reason: string): Promise<void>;
    };

    try {
      await recovery.restartStashedSession(SESSION_KEY, "runtime_event_loop_closed");
      await recovery.restartStashedSession(SESSION_KEY, "runtime_event_loop_closed");
      await recovery.restartStashedSession(SESSION_KEY, "runtime_event_loop_closed");
    } finally {
      emitSpy.mockRestore();
    }

    const suppression = listSessionEvents(SESSION_KEY).find(
      (event) => event.eventType === "dispatch.restart_suppressed",
    );
    expect(starts).toBe(2);
    expect(responseTopics).toEqual([]);
    expect(dispatcher.stashedMessages.has(SESSION_KEY)).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(runtimeEvents).toHaveLength(1);
    expect(suppression).toMatchObject({
      status: "blocked",
      payloadJson: {
        reason: "runtime_event_loop_closed",
        restartAttempts: 2,
        stashedQueueSize: 1,
        resumeStashedMessages: true,
        userResponseSuppressed: true,
      },
    });
  });

  it("closes the provider handle and event iterator when the host session is aborted", async () => {
    let handleCloseCalls = 0;
    let iteratorReturnCalls = 0;
    let releaseHandleClose!: () => void;
    const handleClosed = new Promise<void>((resolve) => {
      releaseHandleClose = resolve;
    });
    const iterator: AsyncIterator<RuntimeEvent> & AsyncIterable<RuntimeEvent> = {
      next: () => new Promise<IteratorResult<RuntimeEvent>>(() => {}),
      return: async () => {
        iteratorReturnCalls++;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const runtimeSession: RuntimeSessionHandle = {
      provider: PROVIDER,
      events: iterator,
      interrupt: async () => {},
      close: async () => {
        handleCloseCalls++;
        await handleClosed;
      },
    };
    const streaming = makeStreamingSession();

    const loop = runTraceLoop(streaming, runtimeSession);
    await Promise.resolve();
    streaming.abortController.abort();
    for (let attempt = 0; attempt < 20 && iteratorReturnCalls === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(iteratorReturnCalls).toBe(1);
    releaseHandleClose();
    await loop;

    expect(handleCloseCalls).toBe(1);
  });

  it("does not replay an unterminated turn after a tool has started", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "do not replay after side effects",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      currentTurnToolStarted: true,
      toolRunning: false,
    });
    seedAdapterTrace(streaming, "turn-stream-closed-after-tool");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(streaming, makeRuntimeSession([]), {
      stashedMessages,
      restartStashedSession: async (input) => {
        restartRequests.push(input);
      },
    });

    expect(stashedMessages.get(SESSION_NAME)).toBeUndefined();
    expect(restartRequests).toEqual([]);

    const terminal = listSessionEvents(SESSION_KEY).find((event) => event.eventType === "turn.interrupted");
    expect(terminal?.payloadJson).toMatchObject({
      abort_reason: "runtime_event_loop_closed",
      autoRecovered: false,
    });
  });

  it("records failed turns with error details", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-failed");

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.failed",
          error: "model unavailable",
          recoverable: false,
          rawEvent: { type: "error", message: "provider down" },
        },
      ]),
    );

    const terminal = listSessionEvents(SESSION_KEY).find((event) => event.eventType === "turn.failed");
    expect(terminal?.status).toBe("failed");
    expect(terminal?.error).toBe("model unavailable");
    expect(terminal?.payloadJson).toMatchObject({
      recoverable: false,
      rawEvent: { type: "error", message: "provider down" },
    });
    expect(getSessionTurn("turn-failed")?.status).toBe("failed");
  });

  it("keeps raw failure diagnostics internal while sanitizing the external response and live state", async () => {
    attachSpeakingOutputChat();
    const rawError =
      "ENOENT: no such file or directory, scandir '/Users/luis/.cache/ravi/plugins/ravi-system/skills/slack'";
    const streaming = makeStreamingSession({ agentMode: "active" });
    seedAdapterTrace(streaming, "turn-internal-failure");
    const responses: string[] = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic: string, data: unknown) => {
      if (topic === `ravi.session.${SESSION_NAME}.response` && data && typeof data === "object") {
        const response = (data as { response?: unknown }).response;
        if (typeof response === "string") responses.push(response);
      }
    });

    try {
      await runTraceLoop(
        streaming,
        makeRuntimeSession([
          {
            type: "turn.failed",
            error: rawError,
            recoverable: false,
          },
        ]),
      );
    } finally {
      emitSpy.mockRestore();
    }

    expect(responses).toEqual([
      "Error: The agent could not complete this request because of an internal runtime error. Please try again.",
    ]);
    expect(responses.join("\n")).not.toContain("/Users/luis");
    expect(getRuntimeLiveStateForSession(makeSession())?.summary).toBe(
      "The agent could not complete this request because of an internal runtime error. Please try again.",
    );

    const terminal = listSessionEvents(SESSION_KEY).find((event) => event.eventType === "turn.failed");
    expect(terminal?.error).toBe(rawError);
  });

  it("deduplicates user-facing provider session limit failures within the same reset window", () => {
    const now = new Date("2026-06-16T15:56:00-03:00").getTime();
    const scope = "codex:whatsapp:main:120363424772797713@g.us";
    const error = "You've hit your session limit - resets 4:20pm (America/Sao_Paulo)";

    const classified = classifyUserFacingRuntimeLimitFailure(error, now);
    expect(classified?.kind).toBe("session_limit");
    expect(classified?.windowKey).toContain("4:20pm");
    expect(classified?.expiresAt ?? 0).toBeGreaterThan(now);

    expect(shouldSuppressUserFacingRuntimeLimitFailure({ error, scope, now }).suppressed).toBe(false);
    expect(shouldSuppressUserFacingRuntimeLimitFailure({ error, scope, now: now + 1_000 }).suppressed).toBe(true);
    expect(
      shouldSuppressUserFacingRuntimeLimitFailure({
        error: "You've hit your session limit - resets 5:20pm (America/Sao_Paulo)",
        scope,
        now: now + 2_000,
      }).suppressed,
    ).toBe(false);
    expect(
      shouldSuppressUserFacingRuntimeLimitFailure({
        error,
        scope: "codex:whatsapp:main:other-chat",
        now: now + 3_000,
      }).suppressed,
    ).toBe(false);
  });

  it("does not deduplicate ordinary provider failures that mention limits", () => {
    const scope = "codex:whatsapp:main:120363424772797713@g.us";
    const error = "Tool output exceeded the size limit.";

    expect(classifyUserFacingRuntimeLimitFailure(error)).toBeUndefined();
    expect(shouldSuppressUserFacingRuntimeLimitFailure({ error, scope }).suppressed).toBe(false);
    expect(shouldSuppressUserFacingRuntimeLimitFailure({ error, scope }).suppressed).toBe(false);
  });

  it("times out active provider turns that stop emitting runtime events", async () => {
    const previousTimeout = process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS;
    process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS = "1000";
    const queued = createQueuedRuntimeUserMessage({
      prompt: "stuck audit alert",
      deliveryBarrier: "after_task",
      source,
      _agentId: AGENT_ID,
    });
    queued.clientMessageId = "ravi:inactive-turn";
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      lastActivity: Date.now() - 2_000,
      toolEffectFence: "provider_event_only",
    });
    seedAdapterTrace(streaming, "turn-provider-inactive");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const providerLifecycle: string[] = [];

    try {
      await runTraceLoop(
        streaming,
        makeNeverEndingRuntimeSession(providerLifecycle, {
          ambiguousTurnRecoveryStrategy: "reconcile_by_client_message_id",
        }),
        {
          stashedMessages,
          restartStashedSession: async (input) => {
            restartRequests.push(input);
          },
          safeEmit: async (topic, data) => {
            emitted.push({ topic, data });
          },
        },
      );
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS;
      } else {
        process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS = previousTimeout;
      }
    }

    expect(restartRequests).toEqual([{ sessionName: SESSION_NAME, reason: "provider_turn_inactive" }]);
    expect(providerLifecycle).toEqual(["interrupt", "close"]);
    expect(stashedMessages.get(SESSION_NAME)?.map((message) => message.message.content)).toEqual(["stuck audit alert"]);
    expect(stashedMessages.get(SESSION_NAME)?.[0]).toMatchObject({
      clientMessageId: "ravi:inactive-turn",
      replay: true,
      terminalReplayAllowed: false,
    });
    expect(emitted.some((event) => event.data.type === "provider.inactive")).toBe(true);

    const events = listSessionEvents(SESSION_KEY);
    expect(events.some((event) => event.eventType === "session.timeout" && event.status === "timeout")).toBe(true);
    const terminal = events.find((event) => event.eventType === "turn.failed");
    expect(terminal?.status).toBe("timeout");
    expect(terminal?.payloadJson).toMatchObject({
      abort_reason: "provider_turn_inactive",
      autoRecovered: true,
    });
    expect(getSessionTurn("turn-provider-inactive")?.status).toBe("timeout");
  });

  it("does not restart an inactive provider turn after durable output", async () => {
    const previousTimeout = process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS;
    process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS = "1000";
    const queued = createQueuedRuntimeUserMessage({
      prompt: "do not replay timed out output",
      deliveryBarrier: "after_response",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      lastActivity: Date.now() - 2_000,
    });
    seedAdapterTrace(streaming, "turn-provider-inactive-after-output");
    const attemptId = streaming.currentCrashRecoveryAttemptId!;
    crashRecovery.markTurnAttemptSafety({ attemptId, materializedOutput: true });
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    try {
      await runTraceLoop(streaming, makeNeverEndingRuntimeSession(), {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
      });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS;
      } else {
        process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS = previousTimeout;
      }
    }

    expect(stashedMessages.get(SESSION_NAME)).toBeUndefined();
    expect(restartRequests).toEqual([]);
    expect(getRuntimeTurnAttempt(attemptId)).toMatchObject({
      status: "timeout",
      materializedOutput: true,
    });
    const terminal = listSessionEvents(SESSION_KEY).find((event) => event.eventType === "turn.failed");
    expect(terminal?.payloadJson).toMatchObject({ autoRecovered: false });
  });

  it("stashes the current turn and restarts after retryable credential failure before tools", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "retry this credential turn",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      currentRuntimeCredential: seedRuntimeCredentialAttempt("rcred_retry_before_tool"),
    });
    seedAdapterTrace(streaming, "turn-credential-retry");
    const crashRecoveryAttemptId = streaming.currentCrashRecoveryAttemptId!;
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    const before = Date.now();

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.failed",
          error: "rate limited",
          recoverable: true,
          rawEvent: {
            type: "error",
            status: 429,
            headers: {
              "retry-after": "2",
              "x-request-id": "req_credential_retry",
            },
          },
        },
      ]),
      {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      },
    );

    expect(emitted.map((event) => event.data.type)).not.toContain("turn.failed");
    const terminal = listSessionEvents(SESSION_KEY).find((event) => event.eventType === "turn.failed");
    expect(terminal).toMatchObject({
      status: "failed",
      payloadJson: expect.objectContaining({
        abort_reason: "runtime_credential_rate_limited",
        autoRecovered: true,
        credentialRetry: true,
      }),
    });
    expect(stashedMessages.get(SESSION_NAME)?.map((message) => message.message.content)).toEqual([
      "retry this credential turn",
    ]);
    expect(restartRequests).toEqual([
      {
        sessionName: SESSION_NAME,
        reason: "runtime_credential_rate_limited",
      },
    ]);
    const health = getRuntimeCredentialHealth("rcred_retry_before_tool");
    expect(health?.lastRequestId).toBe("req_credential_retry");
    expect(health?.cooldownUntil ?? 0).toBeGreaterThanOrEqual(before + 1_500);
    const credentialAttempt = getDb()
      .prepare("SELECT status, completed_at FROM runtime_credential_attempts WHERE credential_id = ?")
      .get("rcred_retry_before_tool") as { status: string; completed_at: number | null } | undefined;
    expect(credentialAttempt?.status).toBe("failed");
    expect(typeof credentialAttempt?.completed_at).toBe("number");
    const recoveryAttempt = getRuntimeTurnAttempt(crashRecoveryAttemptId);
    expect(recoveryAttempt?.status).toBe("failed");
    expect(getSessionTurn("turn-credential-retry")).toMatchObject({
      status: "failed",
      completedAt: recoveryAttempt?.completedAt,
    });
  });

  it("resets provider state and restarts with a recovery prompt after context window exhaustion", async () => {
    saveMessage(SESSION_NAME, "user", "abre a issue 123 e investiga", "thread-old", {
      agentId: AGENT_ID,
      channel: source.channel,
      accountId: source.accountId,
      chatId: source.chatId,
      sourceMessageId: "wamid-old",
    });
    saveMessage(SESSION_NAME, "assistant", "Vou investigar e editar os specs.", "thread-old", {
      agentId: AGENT_ID,
      channel: source.channel,
      accountId: source.accountId,
      chatId: source.chatId,
    });
    saveMessage(SESSION_NAME, "user", "continua de onde parou", "thread-old", {
      agentId: AGENT_ID,
      channel: source.channel,
      accountId: source.accountId,
      chatId: source.chatId,
      sourceMessageId: "wamid-latest",
    });
    updateRuntimeProviderState(SESSION_KEY, PROVIDER, {
      providerSessionId: "thread-old",
      runtimeSessionDisplayId: "thread-old",
      runtimeSessionParams: { sessionId: "thread-old" },
    });

    const queued = createQueuedRuntimeUserMessage({
      prompt: "continua de onde parou",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
    });
    seedAdapterTrace(streaming, "turn-context-limit");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.failed",
          error:
            "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
          recoverable: false,
          rawEvent: { type: "turn.failed", result: "context window exhausted" },
        },
      ]),
      {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      },
    );

    expect(emitted.map((event) => event.data.type)).not.toContain("turn.failed");
    expect(restartRequests).toEqual([{ sessionName: SESSION_NAME, reason: RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON }]);

    const stashed = stashedMessages.get(SESSION_NAME);
    expect(stashed).toHaveLength(1);
    expect(stashed?.[0]?.message.content).toContain("# Runtime Context Recovery");
    expect(stashed?.[0]?.message.content).toContain("Latest User Request");
    expect(stashed?.[0]?.message.content).toContain("continua de onde parou");
    expect(stashed?.[0]?.message.content).not.toContain("Codex ran out of room");

    const persisted = getSession(SESSION_KEY);
    expect(persisted?.providerSessionId).toBeUndefined();
    expect(persisted?.runtimeProvider).toBeUndefined();
    expect(persisted?.runtimeSessionParams).toBeUndefined();

    const eventTypes = listSessionEvents(SESSION_KEY).map((event) => event.eventType);
    expect(eventTypes).toContain("turn.failed");
    expect(eventTypes).toContain("session.context_window_exhausted");
    expect(getSessionTurn("turn-context-limit")?.status).toBe("failed");
  });

  it("does not auto-replay retryable credential failures after a tool started", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "do not replay after tool",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      currentRuntimeCredential: seedRuntimeCredentialAttempt("rcred_retry_after_tool"),
    });
    seedAdapterTrace(streaming, "turn-credential-no-replay");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "tool.started",
          toolUse: { id: "tool-credential", name: "Bash", input: { cmd: "touch /tmp/replay-risk" } },
        },
        {
          type: "tool.completed",
          toolUseId: "tool-credential",
          toolName: "Bash",
          content: "ok",
        },
        {
          type: "turn.failed",
          error: "rate limited",
          recoverable: true,
          rawEvent: {
            type: "error",
            status: 429,
            headers: {
              "retry-after": "2",
              "x-request-id": "req_after_tool",
            },
          },
        },
      ]),
      {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
      },
    );

    expect(stashedMessages.get(SESSION_NAME)).toBeUndefined();
    expect(restartRequests).toEqual([]);
    expect(getRuntimeCredentialHealth("rcred_retry_after_tool")?.lastRequestId).toBe("req_after_tool");
    const attempt = getDb()
      .prepare("SELECT status, completed_at FROM runtime_credential_attempts WHERE credential_id = ?")
      .get("rcred_retry_after_tool") as { status: string; completed_at: number | null } | undefined;
    expect(attempt?.status).toBe("failed");
    expect(typeof attempt?.completed_at).toBe("number");
  });

  it("does not auto-replay retryable credential failures after durable output", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "do not replay after partial output",
      deliveryBarrier: "after_response",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      currentRuntimeCredential: seedRuntimeCredentialAttempt("rcred_retry_after_output"),
    });
    seedAdapterTrace(streaming, "turn-credential-no-replay-after-output");
    const attemptId = streaming.currentCrashRecoveryAttemptId!;
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        { type: "text.delta", text: "already visible" },
        {
          type: "turn.failed",
          error: "rate limited",
          recoverable: true,
          rawEvent: {
            type: "error",
            status: 429,
            headers: { "retry-after": "2", "x-request-id": "req_after_output" },
          },
        },
      ]),
      {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
      },
    );

    expect(stashedMessages.get(SESSION_NAME)).toBeUndefined();
    expect(restartRequests).toEqual([]);
    expect(getRuntimeTurnAttempt(attemptId)).toMatchObject({
      status: "failed",
      startedTool: false,
      materializedOutput: true,
    });
  });

  it("stashes and restarts after a recoverable interrupt failure", async () => {
    const queued = createQueuedRuntimeUserMessage({
      prompt: "new message while busy",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
    });
    const streaming = makeStreamingSession({
      interrupted: true,
      pendingMessages: [queued],
    });
    seedAdapterTrace(streaming, "turn-recoverable-interrupt");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.failed",
          error: "recoverable interrupt",
          recoverable: true,
          rawEvent: {
            type: "result",
            subtype: "error_during_execution",
            errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
          },
        },
      ]),
      {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
      },
    );

    expect(stashedMessages.get(SESSION_NAME)?.map((message) => message.message.content)).toEqual([
      "new message while busy",
    ]);
    expect(stashedMessages.get(SESSION_NAME)?.[0]?.launchPrompt?.source).toEqual(source);
    expect(restartRequests).toEqual([
      {
        sessionName: SESSION_NAME,
        reason: "recoverable_interrupt_failure",
      },
    ]);
    expect(streaming.done).toBe(true);
  });

  it("does not remove a replacement runtime when the previous event loop exits", async () => {
    const streaming = makeStreamingSession({ turnActive: false });
    const replacement = makeStreamingSession({ turnActive: false });
    const streamingSessions = new Map([[SESSION_NAME, streaming]]);
    const runtimeSession: RuntimeSessionHandle = {
      provider: PROVIDER,
      events: (async function* () {
        streamingSessions.set(SESSION_NAME, replacement);
        yield* [];
      })(),
      interrupt: async () => {},
    };
    streaming.queryHandle = runtimeSession;

    await runTraceLoop(streaming, runtimeSession, { streamingSessions });

    expect(streamingSessions.get(SESSION_NAME)).toBe(replacement);
    expect(replacement.done).toBe(false);
  });
});
