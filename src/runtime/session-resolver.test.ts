import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getOrCreateSession, getSession, updateProviderSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { configStore } from "../config-store.js";
import { resolveRuntimeSession } from "./session-resolver.js";

const SESSION_KEY = "agent:main:dm:resolver";
const SESSION_NAME = "main-dm-resolver";

let stateDir: string | null = null;

describe("runtime session resolver", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-session-resolver-");
    configStore.refresh();
  });

  afterEach(async () => {
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
});
