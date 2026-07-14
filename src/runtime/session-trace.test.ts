import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveMessage } from "../db.js";
import { nats } from "../nats.js";
import { attachChatToSession } from "../router/sessions.js";
import { classifyCompactionAnnouncement } from "./compaction-announcement.js";
import {
  getOrCreateSession,
  getSession,
  updateRuntimeProviderState,
  type AgentConfig,
  type SessionEntry,
} from "../router/index.js";
import { dbUpsertChat, getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateTask, dbDispatchTask, dbGetTask } from "../tasks/task-db.js";
import { getSessionTraceBlob, getSessionTurn, listSessionEvents } from "../session-trace/session-trace-db.js";
import { recordAdapterRequestTrace } from "../session-trace/runtime-trace.js";
import {
  bindRuntimeCredentialAttemptTurn,
  createRuntimeCredential,
  getRuntimeCredential,
  getRuntimeCredentialHealth,
  markRuntimeCredentialAttemptStarted,
  reserveRuntimeCredentialAttempt,
} from "./credential-store.js";
import { registerRuntimeCredentialRefreshHook, unregisterRuntimeCredentialRefreshHook } from "./credential-refresh.js";
import { RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON } from "./context-window-recovery.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import type { RuntimeHostStreamingSession, RuntimeMessageTarget, RuntimeUserMessage } from "./host-session.js";
import {
  classifyUserFacingRuntimeLimitFailure,
  resetUserFacingRuntimeLimitSuppressionsForTest,
  runRuntimeEventLoop,
  shouldSuppressUserFacingRuntimeLimitFailure,
} from "./host-event-loop.js";
import { readLearningLoopCadenceState } from "./learning-loop-cadence.js";
import { getRuntimeLiveStateForSession } from "./live-state.js";
import { buildRuntimeStartRequest, resolveRuntimeCredentialUpstreamProvider } from "./runtime-request-builder.js";
import { resolveRuntimeSession } from "./session-resolver.js";
import { startRuntimeSession } from "./session-launcher.js";
import type {
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeProviderId,
  RuntimeSessionHandle,
  RuntimeSkillVisibilitySnapshot,
  SessionRuntimeProvider,
} from "./types.js";
import type { RuntimeTargetPolicy, RuntimeTargetTurnState } from "./target-policy.js";

let stateDir: string | null = null;

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
    ...overrides,
  };
}

function makeRuntimeSession(events: RuntimeEvent[]): RuntimeSessionHandle {
  return {
    provider: PROVIDER,
    events: (async function* () {
      for (const event of events) {
        yield event;
      }
    })(),
    interrupt: async () => {},
  };
}

function makeNeverEndingRuntimeSession(): RuntimeSessionHandle {
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
    interrupt: async () => {},
    close: async () => {
      resolveClose();
    },
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
    ...overrides,
  });
}

describe("runtime session trace instrumentation", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-trace-test-");
    getOrCreateSession(SESSION_KEY, AGENT_ID, stateDir ?? "/tmp", { name: SESSION_NAME });
    resetUserFacingRuntimeLimitSuppressionsForTest();
  });

  afterEach(async () => {
    unregisterRuntimeCredentialRefreshHook(PROVIDER);
    resetUserFacingRuntimeLimitSuppressionsForTest();
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
    });

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
      }),
    ).rejects.toThrow("No managed runtime credential could be resolved");
  });

  it("propagates a bound task profile into credential selection and rejects a mismatch", async () => {
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
      taskProfileAllowlist: ["default"],
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

    const task = dbCreateTask({
      title: "Credential task profile propagation",
      instructions: "Bind the default task profile to the runtime session.",
      profileId: "default",
      createdBy: "test",
    });
    dbDispatchTask(task.task.id, {
      agentId: AGENT_ID,
      sessionName: SESSION_NAME,
      assignedBy: "test",
    });
    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: {
        prompt: "hello codex profile",
        _agentId: AGENT_ID,
        taskBarrierTaskId: task.task.id,
      },
      defaultRuntimeProviderId: "codex",
    });
    expect(resolved?.taskProfileId).toBe("default");

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
        taskProfileId: resolved?.taskProfileId,
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

      const mismatchedStreaming = makeStreamingSession({
        pendingMessages: [createQueuedRuntimeUserMessage({ prompt: "mismatch", deliveryBarrier: "after_tool" })],
      });
      await expect(
        buildRuntimeStartRequest({
          runId: "run-build-codex-profile-mismatch",
          sessionName: SESSION_NAME,
          prompt: { prompt: "mismatch", source, deliveryBarrier: "after_tool" },
          session: makeSession(),
          agent: makeAgent({ provider: "codex" }),
          runtimeProviderId: "codex",
          runtimeProvider: provider,
          runtimeCapabilities: capabilities,
          sessionCwd: stateDir ?? "/tmp",
          dbSessionKey: SESSION_KEY,
          model: "gpt-5",
          taskProfileId: "other-profile",
          runtimeResolution: {
            options: { model: "gpt-5" },
            sources: { model: "agent_default", effort: null, thinking: null },
            hasTaskRuntimeContext: true,
          },
          storedRuntimeSessionParams: undefined,
          canResumeStoredSession: false,
          resolvedSource: source,
          streamingSession: mismatchedStreaming,
          stashedMessages: new Map(),
          defaultRuntimeProviderId: "claude",
        }),
      ).rejects.toThrow("No managed runtime credential could be resolved");
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
      currentTurnCompactionAnnouncement: classifyCompactionAnnouncement({ source }),
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

    expect(responses.some((text) => text.includes("Compactando"))).toBe(true);
    expect(responses.some((text) => text.includes("compactada"))).toBe(true);
    expect(collectRuntimeStatusCompacting()).toEqual([true, false]);
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
        currentTurnCompactionAnnouncement: classifyCompactionAnnouncement({
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

  it("records provider turn interruptions as terminal interrupted turns", async () => {
    const streaming = makeStreamingSession();
    seedAdapterTrace(streaming, "turn-interrupted");

    await runTraceLoop(streaming, makeRuntimeSession([{ type: "turn.interrupted" }]));

    const terminal = listSessionEvents(SESSION_KEY).find((event) => event.eventType === "turn.interrupted");
    expect(terminal?.status).toBe("interrupted");
    expect(terminal?.payloadJson).toMatchObject({ abort_reason: "provider_interrupted" });
    expect(getSessionTurn("turn-interrupted")?.status).toBe("interrupted");
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

  it("switches runtime targets, replays exactly the current turn before tools, and ticks cadence once", async () => {
    const policy: RuntimeTargetPolicy = {
      id: "provider-failover",
      strategy: "ordered",
      maxAttemptsPerTarget: 1,
      targets: [
        { id: "primary", runtimeProvider: PROVIDER, model: MODEL },
        { id: "secondary", runtimeProvider: "trace-secondary", model: "trace-secondary-model" },
      ],
    };
    const state: RuntimeTargetTurnState = {
      logicalTurnId: "logical-turn-1",
      attempts: [{ targetId: "primary", attempt: 1, startedAt: Date.now() }],
      sideEffectBoundaryCrossed: false,
      terminal: false,
    };
    const queued = createQueuedRuntimeUserMessage({
      prompt: "replay on secondary",
      source,
      _agentId: AGENT_ID,
      _runtimeTargetPolicy: policy,
      _runtimeTargetState: state,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      runtimeTargetPolicy: policy,
      runtimeTarget: policy.targets[0],
      runtimeTargetState: state,
    });
    seedAdapterTrace(streaming, "turn-target-switch");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([{ type: "turn.failed", error: "provider unavailable", recoverable: true }]),
      {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
      },
    );

    expect(restartRequests).toEqual([{ sessionName: SESSION_NAME, reason: "runtime_target_switch" }]);
    expect(stashedMessages.get(SESSION_NAME)?.[0]?.launchPrompt?._runtimeTargetState?.attempts[0]?.outcome).toBe(
      "recoverable_failure",
    );
    expect(listSessionEvents(SESSION_KEY).some((event) => event.eventType === "runtime.target.switch_requested")).toBe(
      true,
    );
    expect(getSessionTurn("turn-target-switch")?.status).toBe("aborted");

    state.attempts.push({ targetId: "secondary", attempt: 1, startedAt: Date.now() });
    const secondaryStreaming = makeStreamingSession({
      runtimeTargetPolicy: policy,
      runtimeTarget: policy.targets[1],
      runtimeTargetState: state,
    });
    seedAdapterTrace(secondaryStreaming, "turn-target-switch-secondary");

    await runTraceLoop(
      secondaryStreaming,
      makeRuntimeSession([
        {
          type: "turn.complete",
          providerSessionId: "secondary-session",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    );

    expect(state.terminal).toBe(true);
    expect(readLearningLoopCadenceState(getSession(SESSION_KEY)?.runtimeSessionParams)?.terminalTurnCount).toBe(1);
  });

  it("blocks target replay after any tool starts", async () => {
    const policy: RuntimeTargetPolicy = {
      id: "safe-failover",
      strategy: "ordered",
      maxAttemptsPerTarget: 1,
      targets: [
        { id: "primary", runtimeProvider: PROVIDER, model: MODEL },
        { id: "secondary", runtimeProvider: "trace-secondary", model: "trace-secondary-model" },
      ],
    };
    const state: RuntimeTargetTurnState = {
      logicalTurnId: "logical-turn-side-effect",
      attempts: [{ targetId: "primary", attempt: 1, startedAt: Date.now() }],
      sideEffectBoundaryCrossed: false,
      terminal: false,
    };
    const streaming = makeStreamingSession({
      currentTurnToolStarted: true,
      runtimeTargetPolicy: policy,
      runtimeTarget: policy.targets[0],
      runtimeTargetState: state,
    });
    seedAdapterTrace(streaming, "turn-target-side-effect");
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([{ type: "turn.failed", error: "provider unavailable", recoverable: true }]),
      {
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
      },
    );

    expect(restartRequests).toEqual([]);
    expect(state.sideEffectBoundaryCrossed).toBe(true);
    expect(state.terminal).toBe(true);
    expect(listSessionEvents(SESSION_KEY).some((event) => event.eventType === "runtime.target.replay_blocked")).toBe(
      true,
    );
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
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      lastActivity: Date.now() - 2_000,
    });
    seedAdapterTrace(streaming, "turn-provider-inactive");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];

    try {
      await runTraceLoop(streaming, makeNeverEndingRuntimeSession(), {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
        safeEmit: async (topic, data) => {
          emitted.push({ topic, data });
        },
      });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS;
      } else {
        process.env.RAVI_RUNTIME_TURN_INACTIVITY_MS = previousTimeout;
      }
    }

    expect(restartRequests).toEqual([{ sessionName: SESSION_NAME, reason: "provider_turn_inactive" }]);
    expect(stashedMessages.get(SESSION_NAME)?.map((message) => message.message.content)).toEqual(["stuck audit alert"]);
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
    expect(listSessionEvents(SESSION_KEY).some((event) => event.eventType === "turn.failed")).toBe(false);
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
    const attempt = getDb()
      .prepare("SELECT status, completed_at FROM runtime_credential_attempts WHERE credential_id = ?")
      .get("rcred_retry_before_tool") as { status: string; completed_at: number | null } | undefined;
    expect(attempt?.status).toBe("failed");
    expect(typeof attempt?.completed_at).toBe("number");
  });

  it("switches targets when managed credential refresh fails without retrying the same target", async () => {
    const policy: RuntimeTargetPolicy = {
      id: "credential-refresh-failover",
      strategy: "ordered",
      maxAttemptsPerTarget: 1,
      maxCredentialRecoveryAttemptsPerTarget: 1,
      targets: [
        { id: "primary", runtimeProvider: PROVIDER, model: MODEL },
        { id: "secondary", runtimeProvider: "trace-secondary", model: "trace-secondary-model" },
      ],
    };
    const state: RuntimeTargetTurnState = {
      logicalTurnId: "logical-credential-refresh-failure",
      attempts: [{ targetId: "primary", attempt: 1, startedAt: Date.now() }],
      credentialRecoveries: {},
      sideEffectBoundaryCrossed: false,
      terminal: false,
    };
    const queued = createQueuedRuntimeUserMessage({
      prompt: "fail over after credential refresh failure",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
      _runtimeTargetPolicy: policy,
      _runtimeTargetState: state,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      currentRuntimeCredential: seedRuntimeCredentialAttempt("rcred_refresh_failure"),
      runtimeTargetPolicy: policy,
      runtimeTarget: policy.targets[0],
      runtimeTargetState: state,
    });
    seedAdapterTrace(streaming, "turn-credential-refresh-failure");
    registerRuntimeCredentialRefreshHook(PROVIDER, async () => {
      throw new Error("sensitive upstream refresh detail");
    });
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.failed",
          error: "rate limited",
          recoverable: true,
          rawEvent: { type: "error", status: 429, headers: { "retry-after": "2" } },
        },
      ]),
      {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
      },
    );

    expect(restartRequests).toEqual([{ sessionName: SESSION_NAME, reason: "runtime_target_switch" }]);
    expect(state.credentialRecoveries).toEqual({ primary: 1 });
    expect(state.attempts).toMatchObject([
      { targetId: "primary", outcome: "recoverable_failure", failureKind: "credential" },
    ]);
    expect(stashedMessages.get(SESSION_NAME)).toHaveLength(1);
    const recovery = listSessionEvents(SESSION_KEY).find(
      (event) => event.eventType === "runtime.target.credential_recovery" && event.status === "failed",
    );
    expect(recovery?.error).toBe("runtime credential refresh failed");
    expect(recovery?.error).not.toContain("sensitive upstream refresh detail");
  });

  it("defers a task-bound quota block until authorized target failover finishes", async () => {
    const task = dbCreateTask({
      title: "Quota-bound target task",
      instructions: "Fail closed when provider quota is exhausted",
      createdBy: "test",
      createdByAgentId: AGENT_ID,
      createdBySessionName: SESSION_NAME,
    }).task;
    const policy: RuntimeTargetPolicy = {
      id: "task-quota-fail-closed",
      strategy: "ordered",
      maxAttemptsPerTarget: 1,
      maxCredentialRecoveryAttemptsPerTarget: 0,
      targets: [
        { id: "primary", runtimeProvider: PROVIDER, model: MODEL },
        { id: "secondary", runtimeProvider: "trace-secondary", model: "trace-secondary-model" },
      ],
    };
    const state: RuntimeTargetTurnState = {
      logicalTurnId: "logical-task-quota",
      attempts: [{ targetId: "primary", attempt: 1, startedAt: Date.now() }],
      credentialRecoveries: {},
      sideEffectBoundaryCrossed: false,
      terminal: false,
    };
    const queued = createQueuedRuntimeUserMessage({
      prompt: "stop when the task quota is exhausted",
      deliveryBarrier: "after_tool",
      source,
      taskBarrierTaskId: task.id,
      _agentId: AGENT_ID,
      _runtimeTargetPolicy: policy,
      _runtimeTargetState: state,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      currentTaskBarrierTaskId: task.id,
      currentRuntimeCredential: seedRuntimeCredentialAttempt("rcred_task_quota"),
      runtimeTargetPolicy: policy,
      runtimeTarget: policy.targets[0],
      runtimeTargetState: state,
    });
    seedAdapterTrace(streaming, "turn-task-quota");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.failed",
          error: "provider quota exhausted for this account",
          recoverable: true,
          rawEvent: { type: "error", status: 429, headers: { "retry-after": "3600" } },
        },
      ]),
      {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
      },
    );

    expect(dbGetTask(task.id)?.status).toBe("open");
    expect(restartRequests).toEqual([{ sessionName: SESSION_NAME, reason: "runtime_target_switch" }]);
    expect(stashedMessages.get(SESSION_NAME)).toHaveLength(1);
    expect(state).toMatchObject({
      terminal: false,
      attempts: [{ targetId: "primary", outcome: "recoverable_failure", failureKind: "credential" }],
      pendingTaskQuota: { taskId: task.id, error: "provider quota exhausted for this account" },
    });

    state.attempts.push({ targetId: "secondary", attempt: 1, startedAt: Date.now() });
    const secondaryStreaming = makeStreamingSession({
      currentTaskBarrierTaskId: task.id,
      runtimeTargetPolicy: policy,
      runtimeTarget: policy.targets[1],
      runtimeTargetState: state,
    });
    seedAdapterTrace(secondaryStreaming, "turn-task-quota-secondary");
    await runTraceLoop(
      secondaryStreaming,
      makeRuntimeSession([
        {
          type: "turn.complete",
          providerSessionId: "secondary-session",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    );

    expect(dbGetTask(task.id)?.status).toBe("open");
    expect(state).toMatchObject({
      terminal: true,
      attempts: [
        { targetId: "primary", outcome: "recoverable_failure" },
        { targetId: "secondary", outcome: "success" },
      ],
    });
    expect(state.pendingTaskQuota).toBeUndefined();
  });

  it("blocks a deferred task-bound quota when runtime target selection is exhausted", async () => {
    const task = dbCreateTask({
      title: "Exhausted quota-bound target task",
      instructions: "Converge after target policy exhaustion",
      createdBy: "test",
      createdByAgentId: AGENT_ID,
      createdBySessionName: SESSION_NAME,
    }).task;
    const policy: RuntimeTargetPolicy = {
      id: "task-quota-exhausted",
      strategy: "ordered",
      maxAttemptsPerTarget: 1,
      targets: [{ id: "primary", runtimeProvider: PROVIDER, model: MODEL }],
    };
    const state: RuntimeTargetTurnState = {
      logicalTurnId: "logical-task-quota-exhausted",
      attempts: [
        {
          targetId: "primary",
          attempt: 1,
          startedAt: Date.now() - 1,
          completedAt: Date.now(),
          outcome: "recoverable_failure",
          failureKind: "credential",
        },
      ],
      credentialRecoveries: {},
      pendingTaskQuota: { taskId: task.id, error: "provider quota exhausted after all targets" },
      sideEffectBoundaryCrossed: false,
      terminal: false,
    };
    const queued = createQueuedRuntimeUserMessage({
      prompt: "resume exhausted quota turn",
      source,
      taskBarrierTaskId: task.id,
      _agentId: AGENT_ID,
      _runtimeTargetPolicy: policy,
      _runtimeTargetState: state,
    });
    const stashedMessages = new Map<string, RuntimeUserMessage[]>([[SESSION_NAME, [queued]]]);
    const runtimeEvents: Array<Record<string, unknown>> = [];

    await startRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: {
        prompt: "resume exhausted quota turn",
        source,
        taskBarrierTaskId: task.id,
        _agentId: AGENT_ID,
        _resumeStashedMessages: true,
        _runtimeTargetPolicy: policy,
        _runtimeTargetState: state,
      },
      configModel: MODEL,
      instanceId: "test",
      streamingSessions: new Map(),
      stashedMessages,
      safeEmit: async (_topic, data) => {
        runtimeEvents.push(data);
      },
      drainPendingStarts: () => {},
      runtimeResolution: { ok: false, error: new Error(`Runtime target policy '${policy.id}' is exhausted.`) },
    });

    expect(dbGetTask(task.id)?.status).toBe("blocked");
    expect(state.terminal).toBe(true);
    expect(stashedMessages.get(SESSION_NAME)).toBeUndefined();
    expect(runtimeEvents).toEqual([expect.objectContaining({ type: "turn.failed", recoverable: false })]);
    expect(readLearningLoopCadenceState(getSession(SESSION_KEY)?.runtimeSessionParams)?.terminalTurnCount).toBe(1);
  });

  it("does not let credential heuristics override an explicit non-replayable failure scope", async () => {
    const policy: RuntimeTargetPolicy = {
      id: "explicit-request-scope",
      strategy: "ordered",
      maxAttemptsPerTarget: 1,
      targets: [
        { id: "primary", runtimeProvider: PROVIDER, model: MODEL },
        { id: "secondary", runtimeProvider: "trace-secondary", model: "trace-secondary-model" },
      ],
    };
    const state: RuntimeTargetTurnState = {
      logicalTurnId: "logical-explicit-request-scope",
      attempts: [{ targetId: "primary", attempt: 1, startedAt: Date.now() }],
      credentialRecoveries: {},
      sideEffectBoundaryCrossed: false,
      terminal: false,
    };
    const queued = createQueuedRuntimeUserMessage({
      prompt: "do not replay an invalid request",
      deliveryBarrier: "after_tool",
      source,
      _agentId: AGENT_ID,
      _runtimeTargetPolicy: policy,
      _runtimeTargetState: state,
    });
    const streaming = makeStreamingSession({
      pendingMessages: [queued],
      currentTurnPendingIds: queued.pendingId ? [queued.pendingId] : [],
      currentRuntimeCredential: seedRuntimeCredentialAttempt("rcred_explicit_request_scope"),
      runtimeTargetPolicy: policy,
      runtimeTarget: policy.targets[0],
      runtimeTargetState: state,
    });
    seedAdapterTrace(streaming, "turn-explicit-request-scope");
    const stashedMessages = new Map<string, RuntimeUserMessage[]>();
    const restartRequests: Array<{ sessionName: string; reason: string }> = [];

    await runTraceLoop(
      streaming,
      makeRuntimeSession([
        {
          type: "turn.failed",
          error: "authentication-shaped invalid request",
          recoverable: true,
          rawEvent: { type: "error", status: 401 },
          metadata: { failureScope: "request" },
        },
      ]),
      {
        stashedMessages,
        restartStashedSession: async (input) => {
          restartRequests.push(input);
        },
      },
    );

    expect(restartRequests).toEqual([]);
    expect(stashedMessages.get(SESSION_NAME)).toBeUndefined();
    expect(state).toMatchObject({
      terminal: true,
      credentialRecoveries: {},
      attempts: [{ targetId: "primary", outcome: "terminal_failure", failureKind: "request" }],
    });
    expect(getRuntimeCredential("rcred_explicit_request_scope")?.status).toBe("healthy");
    expect(getRuntimeCredentialHealth("rcred_explicit_request_scope")).toMatchObject({
      consecutiveFailures: 0,
      requestCount: 0,
    });
    const credentialAttempt = getDb()
      .prepare("SELECT status, classifier_kind FROM runtime_credential_attempts WHERE credential_id = ?")
      .get("rcred_explicit_request_scope") as { status: string; classifier_kind: string | null } | undefined;
    expect(credentialAttempt).toEqual({ status: "failed", classifier_kind: null });
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
});
