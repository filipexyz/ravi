import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  getOrCreateSession,
  getSession,
  updateProviderSession,
  updateSessionModelOverride,
  updateSessionRuntimeProviderOverride,
} from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { configStore } from "../config-store.js";
import { dbCreateTask, dbDispatchTask } from "../tasks/task-db.js";
import { buildTaskProfileSnapshot, resolveTaskProfile } from "../tasks/profiles.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { resolveRuntimeSession } from "./session-resolver.js";
import { registerRuntimeProvider, unregisterRuntimeProvider } from "./provider-registry.js";
import type { RuntimeCapabilities, SessionRuntimeProvider } from "./types.js";

const SESSION_KEY = "agent:main:dm:resolver";
const SESSION_NAME = "main-dm-resolver";
const FILE_BACKED_PROVIDER = "file-backed-test";
const CAS_LOSS_PROVIDER = "cas-loss-test";

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

function persistKimiK3Session(): void {
  const cwd = stateDir ?? "/tmp";
  const sessionFile = join(cwd, "kimi-k3-session.json");
  writeFileSync(sessionFile, '{"messages":["old-k3-transcript"]}');
  getOrCreateSession(SESSION_KEY, "main", cwd, { name: SESSION_NAME });
  updateSessionRuntimeProviderOverride(SESSION_KEY, "kimi-code");
  updateProviderSession(getSession(SESSION_KEY)!, "kimi-code", "kimi-k3-locator", {
    runtimeSessionParams: {
      provider: "kimi-code",
      model: "k3",
      sessionFile,
      cwd,
    },
    runtimeSessionDisplayId: "kimi-k3-locator",
  });
}

function resolveKimiThroughRuntimeBoundary(prompt: RuntimeLaunchPrompt, configModel: string) {
  const resolutionInput = {
    sessionName: SESSION_NAME,
    prompt,
    defaultRuntimeProviderId: "codex" as const,
    configModel,
  } satisfies Parameters<typeof resolveRuntimeSession>[0];
  const resolved = resolveRuntimeSession(resolutionInput);
  if (!resolved) {
    throw new Error("expected runtime session resolution");
  }
  return { resolved, runtimeResolution: resolved.runtimeResolution };
}

describe("runtime session resolver", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-session-resolver-");
    configStore.refresh();
  });

  afterEach(async () => {
    unregisterRuntimeProvider(FILE_BACKED_PROVIDER);
    unregisterRuntimeProvider(CAS_LOSS_PROVIDER);
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("resumes stored provider state for the same runtime provider", () => {
    getOrCreateSession(SESSION_KEY, "main", stateDir ?? "/tmp", { name: SESSION_NAME });
    updateProviderSession(getSession(SESSION_KEY)!, "codex", "provider-existing", {
      runtimeSessionParams: { sessionId: "provider-existing" },
      runtimeSessionDisplayId: "provider-existing",
    });

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      configModel: "global-model",
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

  it("clears stale provider state only for an explicit runtime provider mismatch without a microtask race", async () => {
    getOrCreateSession(SESSION_KEY, "main", stateDir ?? "/tmp", { name: SESSION_NAME });
    updateProviderSession(getSession(SESSION_KEY)!, "codex", "provider-existing");

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      configModel: "global-model",
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
    let cleanupSettled = false;
    const cleanup = resolved?.providerStateCleanup?.then(() => {
      cleanupSettled = true;
    });
    expect(cleanupSettled).toBe(false);
    await cleanup;
    expect(cleanupSettled).toBe(true);
  });

  it("returns no runtime after stale-state cleanup loses ownership", () => {
    getOrCreateSession(SESSION_KEY, "main", stateDir ?? "/tmp", { name: SESSION_NAME });
    expect(updateProviderSession(getSession(SESSION_KEY)!, "codex", "provider-observed").won).toBe(true);
    const observed = getSession(SESSION_KEY)!;
    let advancedOwnership = false;
    registerRuntimeProvider(
      CAS_LOSS_PROVIDER,
      (): SessionRuntimeProvider => {
        advancedOwnership = updateProviderSession(getSession(SESSION_KEY)!, "codex", "provider-current").won;
        return {
          id: CAS_LOSS_PROVIDER,
          getCapabilities: createFileBackedProviderCapabilities,
          startSession: () => ({
            provider: CAS_LOSS_PROVIDER,
            events: (async function* () {})(),
            interrupt: async () => {},
          }),
        };
      },
    );

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      configModel: "global-model",
      prompt: { prompt: "must not launch against stale ownership" },
      defaultRuntimeProviderId: CAS_LOSS_PROVIDER,
    });

    expect(advancedOwnership).toBe(true);
    expect(resolved).toBeNull();
    expect(getSession(SESSION_KEY)).toMatchObject({
      providerSessionId: "provider-current",
      lifecycleGeneration: observed.lifecycleGeneration! + 1,
    });
  });

  it("uses session runtime provider override before agent/default provider", () => {
    getOrCreateSession(SESSION_KEY, "main", stateDir ?? "/tmp", { name: SESSION_NAME });
    updateSessionRuntimeProviderOverride(SESSION_KEY, "claude");

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      configModel: "global-model",
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
    updateProviderSession(getSession(SESSION_KEY)!, FILE_BACKED_PROVIDER, "file-backed-session", {
      runtimeSessionParams: {
        sessionFile,
        cwd,
      },
      runtimeSessionDisplayId: "file-backed-session",
    });

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      configModel: "global-model",
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
    updateProviderSession(getSession(SESSION_KEY)!, FILE_BACKED_PROVIDER, "missing-file-session", {
      runtimeSessionParams: {
        sessionFile: join(cwd, "missing-provider-session.json"),
        cwd,
      },
      runtimeSessionDisplayId: "missing-file-session",
    });

    const resolved = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      configModel: "global-model",
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

  it("keeps matching Kimi model state and clears it through the generic stale path after a model change", () => {
    const cwd = stateDir ?? "/tmp";
    const sessionFile = join(cwd, "kimi-k3-session.json");
    writeFileSync(sessionFile, '{"messages":["old-k3-transcript"]}');
    getOrCreateSession(SESSION_KEY, "main", cwd, { name: SESSION_NAME });
    updateSessionRuntimeProviderOverride(SESSION_KEY, "kimi-code");
    updateSessionModelOverride(SESSION_KEY, "k3");
    updateProviderSession(getSession(SESSION_KEY)!, "kimi-code", "kimi-k3-locator", {
      runtimeSessionParams: {
        provider: "kimi-code",
        model: "k3",
        sessionFile,
        cwd,
      },
      runtimeSessionDisplayId: "kimi-k3-locator",
    });

    const matching = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      configModel: "global-model",
      prompt: { prompt: "continue k3" },
      defaultRuntimeProviderId: "codex",
    });
    expect(matching?.canResumeStoredSession).toBe(true);
    expect(matching?.storedProviderSessionId).toBe("kimi-k3-locator");

    updateSessionModelOverride(SESSION_KEY, "k3-256k");
    const admittedBeforeRestart = getSession(SESSION_KEY)!;
    const changed = resolveRuntimeSession({
      sessionName: SESSION_NAME,
      configModel: "global-model",
      prompt: { prompt: "restart on k3-256k" },
      defaultRuntimeProviderId: "codex",
    });

    expect(changed?.storedProviderSessionId).toBeUndefined();
    expect(changed?.storedRuntimeSessionParams).toBeUndefined();
    expect(changed?.canResumeStoredSession).toBe(false);
    expect(changed?.resumeDecision).toMatchObject({
      requestedRuntimeProvider: "kimi-code",
      providerMatches: true,
      sessionStateValid: false,
      sessionStateInvalidReason: "model_mismatch",
      reason: "session_state_invalid",
      staleCleared: true,
    });
    expect(getSession(SESSION_KEY)).toMatchObject({
      modelOverride: "k3-256k",
      runtimeProviderOverride: "kimi-code",
    });
    expect(getSession(SESSION_KEY)?.runtimeSessionParams).toBeUndefined();
    expect(getSession(SESSION_KEY)?.lifecycleGeneration).toBe(admittedBeforeRestart.lifecycleGeneration! + 1);
    expect(
      updateProviderSession(admittedBeforeRestart, "kimi-code", "synthetic-late-model-terminal", {
        runtimeSessionParams: { provider: "kimi-code", model: "k3-256k", revision: 2 },
      }).won,
    ).toBe(false);
  });

  it("does not apply Kimi model invalidation rules to Claude, Codex, or Pi", () => {
    const cwd = stateDir ?? "/tmp";
    for (const provider of ["claude", "codex", "pi"] as const) {
      const sessionKey = `agent:main:dm:resolver-${provider}`;
      const sessionName = `main-dm-resolver-${provider}`;
      const sessionFile = join(cwd, `${provider}-session.json`);
      writeFileSync(sessionFile, "{}");
      getOrCreateSession(sessionKey, "main", cwd, { name: sessionName });
      updateSessionRuntimeProviderOverride(sessionKey, provider);
      updateSessionModelOverride(sessionKey, "new-model");
      updateProviderSession(getSession(sessionKey)!, provider, `${provider}-locator`, {
        runtimeSessionParams: {
          model: "old-model",
          sessionFile,
          cwd,
        },
        runtimeSessionDisplayId: `${provider}-locator`,
      });

      const resolved = resolveRuntimeSession({
        sessionName,
        configModel: "global-model",
        prompt: { prompt: `continue ${provider}` },
        defaultRuntimeProviderId: "codex",
      });

      expect(resolved?.canResumeStoredSession).toBe(true);
      expect(resolved?.storedProviderSessionId).toBe(`${provider}-locator`);
      expect(resolved?.resumeDecision).toMatchObject({
        sessionStateValid: true,
        staleCleared: false,
      });
    }
  });

  it("does not forward k3 continuity when the real request uses the global k3-256k default", async () => {
    persistKimiK3Session();

    const { resolved, runtimeResolution } = resolveKimiThroughRuntimeBoundary(
      { prompt: "use the global model" },
      "k3-256k",
    );

    expect(runtimeResolution.sources.model).toBe("global_default");
    expect(resolved.model).toBe("k3-256k");
    expect(resolved.storedProviderSessionId).toBeUndefined();
    expect(resolved.storedRuntimeSessionParams).toBeUndefined();
    expect(resolved.resumeDecision).toMatchObject({
      sessionStateInvalidReason: "model_mismatch",
      staleCleared: true,
    });
  });

  it("does not forward k3 continuity when a task override selects k3-256k", async () => {
    persistKimiK3Session();
    const created = dbCreateTask({
      title: "Kimi model continuity",
      instructions: "Use the task model without the old transcript.",
      createdBy: "test",
      runtimeOverride: { model: "k3-256k" },
    });
    dbDispatchTask(created.task.id, {
      agentId: "main",
      sessionName: SESSION_NAME,
      assignedBy: "test",
    });
    const prompt = { prompt: "use the task model", taskBarrierTaskId: created.task.id };

    const { resolved, runtimeResolution } = resolveKimiThroughRuntimeBoundary(prompt, "global-fallback");

    expect(runtimeResolution.sources.model).toBe("task_override");
    expect(resolved.model).toBe("k3-256k");
    expect(resolved.storedProviderSessionId).toBeUndefined();
    expect(resolved.storedRuntimeSessionParams).toBeUndefined();
    expect(resolved.resumeDecision).toMatchObject({
      sessionStateInvalidReason: "model_mismatch",
      staleCleared: true,
    });
  });

  it("does not forward k3 continuity when a task profile defaults to k3-256k", async () => {
    persistKimiK3Session();
    const profileSnapshot = {
      ...buildTaskProfileSnapshot(resolveTaskProfile("default")),
      runtimeDefaults: { model: "k3-256k" },
    };
    const created = dbCreateTask({
      title: "Kimi profile continuity",
      instructions: "Use the profile model without the old transcript.",
      createdBy: "test",
      profileId: profileSnapshot.id,
      profileVersion: profileSnapshot.version,
      profileSource: profileSnapshot.source,
      profileSnapshot,
    });
    dbDispatchTask(created.task.id, {
      agentId: "main",
      sessionName: SESSION_NAME,
      assignedBy: "test",
    });
    const prompt = { prompt: "use the profile model", taskBarrierTaskId: created.task.id };

    const { resolved, runtimeResolution } = resolveKimiThroughRuntimeBoundary(prompt, "global-fallback");

    expect(runtimeResolution.sources.model).toBe("profile_default");
    expect(resolved.model).toBe("k3-256k");
    expect(resolved.storedProviderSessionId).toBeUndefined();
    expect(resolved.storedRuntimeSessionParams).toBeUndefined();
    expect(resolved.resumeDecision).toMatchObject({
      sessionStateInvalidReason: "model_mismatch",
      staleCleared: true,
    });
  });
});
