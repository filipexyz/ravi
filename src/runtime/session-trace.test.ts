import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getOrCreateSession,
  getSession,
  updateRuntimeProviderState,
  type AgentConfig,
  type SessionEntry,
} from "../router/index.js";
import { getDb } from "../router/router-db.js";
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
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import type { RuntimeHostStreamingSession, RuntimeMessageTarget, RuntimeUserMessage } from "./host-session.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import { getRuntimeLiveStateForSession } from "./live-state.js";
import { buildRuntimeStartRequest, resolveRuntimeCredentialUpstreamProvider } from "./runtime-request-builder.js";
import type {
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeProviderId,
  RuntimeSessionHandle,
  RuntimeSkillVisibilitySnapshot,
  SessionRuntimeProvider,
} from "./types.js";

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
    getOrCreateSession(SESSION_KEY, AGENT_ID, stateDir ?? "/tmp");
  });

  afterEach(async () => {
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
      ]),
    );

    expect(listSessionEvents(SESSION_KEY).map((event) => event.eventType)).toEqual([
      "adapter.request",
      "assistant.message",
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
      },
    );

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
