import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  getOrCreateSession,
  getSession,
  updateProviderSession,
  updateSessionRuntimeProviderOverride,
} from "../router/sessions.js";
import { dbUpdateAgent } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { configStore } from "../config-store.js";
import { recordRuntimeTraceEvent } from "../session-trace/runtime-trace.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { resolveRuntimeSession } from "./session-resolver.js";
import { registerRuntimeProvider, unregisterRuntimeProvider } from "./provider-registry.js";
import type { RuntimeCapabilities, SessionRuntimeProvider } from "./types.js";

const SESSION_KEY = "agent:main:dm:resolver";
const SESSION_NAME = "main-dm-resolver";
const FILE_BACKED_PROVIDER = "file-backed-test";

let stateDir: string | null = null;

function createFileBackedProviderCapabilities(): RuntimeCapabilities {
  return {
    runtimeControl: { supported: false, operations: [] },
    dynamicTools: { mode: "none" },
    execution: { mode: "subprocess-rpc" },
    sessionState: { mode: "file-backed", requiresCwdMatch: true },
    usage: { semantics: "terminal-event" },
    tools: {
      permissionMode: "provider-native",
      accessRequirement: "tool_and_executable",
      supportsParallelCalls: false,
    },
    systemPrompt: { mode: "append" },
    terminalEvents: { guarantee: "adapter" },
    skillVisibility: { availability: "none", loadedState: "none" },
    supportsSessionResume: true,
    supportsSessionFork: false,
    supportsPartialText: true,
    supportsToolHooks: false,
    supportsPlugins: false,
    supportsMcpServers: false,
    supportsRemoteSpawn: false,
  };
}

function registerFileBackedProvider(): void {
  registerRuntimeProvider(
    FILE_BACKED_PROVIDER,
    (): SessionRuntimeProvider => ({
      id: FILE_BACKED_PROVIDER,
      getCapabilities: createFileBackedProviderCapabilities,
      startSession: () => ({
        provider: FILE_BACKED_PROVIDER,
        events: (async function* () {})(),
        interrupt: async () => {},
      }),
    }),
  );
}

describe("runtime session resolver", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-session-resolver-");
    configStore.refresh();
    const agent = configStore.getConfig().agents.main;
    if (agent) {
      agent.defaults = {
        ...(agent.defaults ?? {}),
        runtimePermissions: {
          profile: "full-access",
          capabilities: [{ permission: "use", objectType: "runtime.target", objectId: "*" }],
        },
      };
      dbUpdateAgent(agent.id, { defaults: agent.defaults });
    }
  });

  afterEach(async () => {
    unregisterRuntimeProvider(FILE_BACKED_PROVIDER);
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("resumes stored provider state for the same runtime provider", () => {
    getOrCreateSession(SESSION_KEY, "main", stateDir ?? "/tmp", { name: SESSION_NAME });
    updateProviderSession(SESSION_KEY, "codex", "provider-existing", {
      runtimeSessionParams: { sessionId: "provider-existing" },
      runtimeSessionDisplayId: "provider-existing",
    });

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: { prompt: "Qual o melhor pro nosso cenário?" },
      defaultRuntimeProviderId: "codex",
    });

    expect(resolved?.storedProviderSessionId).toBe("provider-existing");
    expect(resolved?.canResumeStoredSession).toBe(true);
    expect(resolved?.resumeDecision).toMatchObject({
      hadStoredProviderSessionId: true,
      requestedRuntimeProvider: "codex",
      supportsSessionResume: true,
      providerMatches: true,
      canResume: true,
      reason: "resuming",
      staleCleared: false,
    });
  });

  it("clears stale provider state only for an explicit runtime provider mismatch", () => {
    getOrCreateSession(SESSION_KEY, "main", stateDir ?? "/tmp", { name: SESSION_NAME });
    updateProviderSession(SESSION_KEY, "codex", "provider-existing");

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: { prompt: "fresh start" },
      defaultRuntimeProviderId: "claude",
    });

    expect(resolved?.storedProviderSessionId).toBeUndefined();
    expect(resolved?.canResumeStoredSession).toBe(false);
    expect(resolved?.resumeDecision).toMatchObject({
      hadStoredProviderSessionId: true,
      requestedRuntimeProvider: "claude",
      providerMatches: false,
      canResume: false,
      reason: "provider_mismatch",
      staleCleared: true,
    });
    expect(getSession(SESSION_KEY)?.providerSessionId).toBeUndefined();
  });

  it("uses session runtime provider override before agent/default provider", () => {
    getOrCreateSession(SESSION_KEY, "main", stateDir ?? "/tmp", { name: SESSION_NAME });
    updateSessionRuntimeProviderOverride(SESSION_KEY, "claude");

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: { prompt: "use session provider override" },
      defaultRuntimeProviderId: "codex",
    });

    expect(resolved?.runtimeProviderId).toBe("claude");
    expect(resolved?.resumeDecision).toMatchObject({
      requestedRuntimeProvider: "claude",
      reason: "missing_provider_session",
    });
  });

  it("resumes file-backed provider state only when the file exists and cwd matches", () => {
    registerFileBackedProvider();
    const cwd = stateDir ?? "/tmp";
    const sessionFile = join(cwd, "provider-session.json");
    writeFileSync(sessionFile, "{}");

    getOrCreateSession(SESSION_KEY, "main", cwd, { name: SESSION_NAME });
    updateProviderSession(SESSION_KEY, FILE_BACKED_PROVIDER, "file-backed-session", {
      runtimeSessionParams: {
        sessionFile,
        cwd,
      },
      runtimeSessionDisplayId: "file-backed-session",
    });

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: { prompt: "resume file-backed provider" },
      defaultRuntimeProviderId: FILE_BACKED_PROVIDER,
    });

    expect(resolved?.storedProviderSessionId).toBe("file-backed-session");
    expect(resolved?.canResumeStoredSession).toBe(true);
    expect(resolved?.resumeDecision).toMatchObject({
      providerMatches: true,
      sessionStateValid: true,
      canResume: true,
      reason: "resuming",
      staleCleared: false,
    });
  });

  it("clears stale file-backed provider state when the session file is missing", () => {
    registerFileBackedProvider();
    const cwd = stateDir ?? "/tmp";

    getOrCreateSession(SESSION_KEY, "main", cwd, { name: SESSION_NAME });
    updateProviderSession(SESSION_KEY, FILE_BACKED_PROVIDER, "missing-file-session", {
      runtimeSessionParams: {
        sessionFile: join(cwd, "missing-provider-session.json"),
        cwd,
      },
      runtimeSessionDisplayId: "missing-file-session",
    });

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: { prompt: "do not resume stale file" },
      defaultRuntimeProviderId: FILE_BACKED_PROVIDER,
    });

    expect(resolved?.storedProviderSessionId).toBeUndefined();
    expect(resolved?.canResumeStoredSession).toBe(false);
    expect(resolved?.resumeDecision).toMatchObject({
      providerMatches: true,
      sessionStateValid: false,
      sessionStateInvalidReason: "session_file_missing",
      canResume: false,
      reason: "session_state_invalid",
      staleCleared: true,
    });
    expect(getSession(SESSION_KEY)?.providerSessionId).toBeUndefined();
  });

  it("selects the next registered target from the replay envelope", () => {
    const policy = {
      id: "ordered-failover",
      strategy: "ordered" as const,
      maxAttemptsPerTarget: 1,
      targets: [
        { id: "primary", runtimeProvider: "codex", model: "primary-model" },
        { id: "secondary", runtimeProvider: "claude", model: "secondary-model" },
      ],
    };
    const first = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: { prompt: "try primary", _runtimeTargetPolicy: policy },
      defaultRuntimeProviderId: "codex",
    });
    expect(first?.runtimeProviderId).toBe("codex");
    expect(first?.runtimeTarget?.id).toBe("primary");

    const state = first?.runtimeTargetState;
    expect(state).toBeDefined();
    if (!state) return;
    const attempt = state.attempts[0];
    if (attempt) {
      attempt.completedAt = Date.now();
      attempt.outcome = "recoverable_failure";
    }
    const second = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: {
        prompt: "try secondary",
        _runtimeTargetPolicy: policy,
        _runtimeTargetState: state,
      },
      defaultRuntimeProviderId: "codex",
    });
    expect(second?.runtimeProviderId).toBe("claude");
    expect(second?.runtimeTarget?.id).toBe("secondary");
    expect(second?.runtimeTargetState?.attempts.map((item) => item.targetId)).toEqual(["primary", "secondary"]);
  });

  it("uses the same credential eligibility as runtime targets explain", () => {
    const policy = {
      id: "credential-eligibility",
      strategy: "ordered" as const,
      maxAttemptsPerTarget: 1,
      targets: [
        {
          id: "managed-primary",
          runtimeProvider: "codex",
          model: "primary-model",
          credentialRequirements: {
            requireManaged: true,
            credentialIds: ["missing-managed-credential"],
          },
        },
        { id: "fallback", runtimeProvider: "claude", model: "fallback-model" },
      ],
    };

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: { prompt: "skip the unavailable credential", _runtimeTargetPolicy: policy },
      defaultRuntimeProviderId: "codex",
    });

    expect(resolved?.runtimeProviderId).toBe("claude");
    expect(resolved?.runtimeTarget?.id).toBe("fallback");
    expect(resolved?.runtimeTargetRejected).toContainEqual(
      expect.objectContaining({ targetId: "managed-primary", reason: "credential_unavailable" }),
    );
    expect(resolved?.runtimeTargetState?.attempts.map((item) => item.targetId)).toEqual(["fallback"]);
  });

  it("preserves policy source and provenance across replay attempts", () => {
    const agent = configStore.getConfig().agents.main;
    if (!agent) throw new Error("default test agent missing");
    const policy = {
      id: "provenance-policy",
      strategy: "ordered" as const,
      maxAttemptsPerTarget: 1,
      targets: [
        { id: "primary", runtimeProvider: "codex", model: "primary-model" },
        { id: "secondary", runtimeProvider: "claude", model: "secondary-model" },
      ],
    };
    agent.defaults = { ...(agent.defaults ?? {}), runtimeTargetPolicy: policy };
    dbUpdateAgent(agent.id, { defaults: agent.defaults });

    const first = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: { prompt: "try configured policy" },
      defaultRuntimeProviderId: "codex",
    });
    expect(first?.runtimeTargetPolicySource).toBe("agent_default");
    expect(first?.runtimeTargetPolicyProvenance).toBe("agent:main.defaults.runtimeTargetPolicy");

    const state = first?.runtimeTargetState;
    if (!state) throw new Error("runtime target state missing");
    const attempt = state.attempts[0];
    if (!attempt) throw new Error("runtime target attempt missing");
    attempt.completedAt = Date.now();
    attempt.outcome = "recoverable_failure";

    const replayed = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: {
        prompt: "replay configured policy",
        _runtimeTargetPolicy: policy,
        _runtimeTargetPolicyResolution: {
          source: first?.runtimeTargetPolicySource ?? "none",
          provenance: first?.runtimeTargetPolicyProvenance ?? null,
        },
        _runtimeTargetState: state,
      },
      defaultRuntimeProviderId: "codex",
    });
    expect(replayed?.runtimeTarget?.id).toBe("secondary");
    expect(replayed?.runtimeTargetPolicySource).toBe("agent_default");
    expect(replayed?.runtimeTargetPolicyProvenance).toBe("agent:main.defaults.runtimeTargetPolicy");
  });

  it("reconstructs failover after daemon restart and does not repeat the failed target", () => {
    const policy = {
      id: "restart-policy",
      strategy: "ordered" as const,
      maxAttemptsPerTarget: 1,
      targets: [
        { id: "primary", runtimeProvider: "codex", model: "primary-model" },
        { id: "secondary", runtimeProvider: "claude", model: "secondary-model" },
      ],
    };
    getOrCreateSession(SESSION_KEY, "main", stateDir ?? "/tmp", { name: SESSION_NAME });
    recordRuntimeTraceEvent({
      sessionKey: SESSION_KEY,
      sessionName: SESSION_NAME,
      agentId: "main",
      eventType: "runtime.start",
      eventGroup: "runtime",
      status: "starting",
      payloadJson: {
        runtimeTargetPolicyId: policy.id,
        runtimeTargetId: "primary",
        logicalTurnId: "turn-before-restart",
      },
    });
    recordRuntimeTraceEvent({
      sessionKey: SESSION_KEY,
      sessionName: SESSION_NAME,
      agentId: "main",
      eventType: "runtime.target.switch_requested",
      eventGroup: "runtime",
      status: "recovering",
      payloadJson: { policyId: policy.id, targetId: "primary", logicalTurnId: "turn-before-restart" },
    });

    const resumed = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: { prompt: "resume after restart", _runtimeTargetPolicy: policy, _resumeStashedMessages: true },
      defaultRuntimeProviderId: "codex",
    });
    expect(resumed?.runtimeTarget?.id).toBe("secondary");
    expect(resumed?.runtimeTargetState?.attempts.map((attempt) => attempt.targetId)).toEqual(["primary", "secondary"]);
  });

  it("hydrates the replay envelope before throwing reconstructed target exhaustion", () => {
    const policy = {
      id: "restart-exhausted-policy",
      strategy: "ordered" as const,
      maxAttemptsPerTarget: 1,
      targets: [
        { id: "primary", runtimeProvider: "codex", model: "primary-model" },
        { id: "secondary", runtimeProvider: "claude", model: "secondary-model" },
      ],
    };
    getOrCreateSession(SESSION_KEY, "main", stateDir ?? "/tmp", { name: SESSION_NAME });
    for (const targetId of ["primary", "secondary"]) {
      recordRuntimeTraceEvent({
        sessionKey: SESSION_KEY,
        sessionName: SESSION_NAME,
        agentId: "main",
        eventType: "runtime.start",
        eventGroup: "runtime",
        status: "starting",
        payloadJson: {
          runtimeTargetPolicyId: policy.id,
          runtimeTargetId: targetId,
          logicalTurnId: "turn-exhausted-before-restart",
        },
      });
      recordRuntimeTraceEvent({
        sessionKey: SESSION_KEY,
        sessionName: SESSION_NAME,
        agentId: "main",
        eventType: "runtime.target.switch_requested",
        eventGroup: "runtime",
        status: "recovering",
        payloadJson: {
          policyId: policy.id,
          targetId,
          logicalTurnId: "turn-exhausted-before-restart",
        },
      });
    }
    const prompt: RuntimeLaunchPrompt = {
      prompt: "resume an already exhausted turn",
      _runtimeTargetPolicy: policy,
      _resumeStashedMessages: true,
    };

    expect(() =>
      resolveRuntimeSession({
        sessionName: SESSION_NAME,
        prompt,
        defaultRuntimeProviderId: "codex",
      }),
    ).toThrow("is exhausted");
    expect(prompt._runtimeTargetState).toMatchObject({
      logicalTurnId: "turn-exhausted-before-restart",
      attempts: [{ targetId: "primary" }, { targetId: "secondary" }],
    });
    expect(prompt._runtimeTargetPolicyResolution).toEqual({
      source: "session_override",
      provenance: "session.runtimeTargetPolicy",
    });
  });

  it("prefers a stashed prompt turn envelope over an older reconstructed side-effect turn", () => {
    const policy = {
      id: "stashed-followup-policy",
      strategy: "ordered" as const,
      maxAttemptsPerTarget: 1,
      targets: [
        { id: "primary", runtimeProvider: "codex", model: "primary-model" },
        { id: "secondary", runtimeProvider: "claude", model: "secondary-model" },
      ],
    };
    getOrCreateSession(SESSION_KEY, "main", stateDir ?? "/tmp", { name: SESSION_NAME });
    recordRuntimeTraceEvent({
      sessionKey: SESSION_KEY,
      sessionName: SESSION_NAME,
      agentId: "main",
      eventType: "runtime.start",
      eventGroup: "runtime",
      status: "starting",
      payloadJson: {
        runtimeTargetPolicyId: policy.id,
        runtimeTargetId: "primary",
        logicalTurnId: "old-tool-turn",
      },
    });
    recordRuntimeTraceEvent({
      sessionKey: SESSION_KEY,
      sessionName: SESSION_NAME,
      agentId: "main",
      eventType: "tool.start",
      eventGroup: "tool",
      status: "running",
      payloadJson: {
        policyId: policy.id,
        targetId: "primary",
        logicalTurnId: "old-tool-turn",
      },
    });
    const promptState = {
      logicalTurnId: "new-followup-turn",
      attempts: [],
      credentialRecoveries: {},
      sideEffectBoundaryCrossed: false,
      terminal: false,
    };

    const resumed = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      prompt: {
        prompt: "resume only the fresh follow-up",
        _runtimeTargetPolicy: policy,
        _runtimeTargetState: promptState,
        _resumeStashedMessages: true,
      },
      defaultRuntimeProviderId: "codex",
    });

    expect(resumed?.runtimeTarget?.id).toBe("primary");
    expect(resumed?.runtimeTargetState?.logicalTurnId).toBe("new-followup-turn");
    expect(resumed?.runtimeTargetState?.attempts).toEqual([
      expect.objectContaining({ targetId: "primary", attempt: 1 }),
    ]);
  });
});
