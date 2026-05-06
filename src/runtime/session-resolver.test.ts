import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { getOrCreateSession, getSession, updateProviderSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { configStore } from "../config-store.js";
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
});
