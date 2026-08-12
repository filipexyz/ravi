import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "./router-db.js";
import {
  clearProviderSession,
  getOrCreateSession,
  getSession,
  updateProviderSession,
  updateRuntimeProviderState,
} from "./sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

const TEST_SESSION_KEYS = ["test:runtime-provider:a", "test:runtime-provider:b", "test:runtime-provider:c"];
let stateDir: string | null = null;

function cleanupSessions() {
  const db = getDb();
  for (const key of TEST_SESSION_KEYS) {
    db.prepare("DELETE FROM sessions WHERE session_key = ?").run(key);
  }
}

describe("Session provider state", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-session-provider-state-");
    cleanupSessions();
  });

  afterEach(async () => {
    cleanupSessions();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("persists runtime provider alongside provider session id", () => {
    const admitted = getOrCreateSession(TEST_SESSION_KEYS[0]!, "agent-a", "/tmp/agent-a");
    expect(
      updateProviderSession(admitted, "codex", "resp_123", {
        runtimeSessionParams: { sessionId: "resp_123", cwd: "/tmp/agent-a" },
        runtimeSessionDisplayId: "resp_123",
      }),
    ).toEqual({ won: true, lifecycleGeneration: admitted.lifecycleGeneration! });

    const session = getSession(TEST_SESSION_KEYS[0]!);
    expect(session?.runtimeProvider).toBe("codex");
    expect(session?.runtimeSessionParams).toEqual({ sessionId: "resp_123", cwd: "/tmp/agent-a" });
    expect(session?.runtimeSessionDisplayId).toBe("resp_123");
    expect(session?.providerSessionId).toBe("resp_123");
  });

  it("persists runtime provider even before a provider session id exists", () => {
    const admitted = getOrCreateSession(TEST_SESSION_KEYS[0]!, "agent-a", "/tmp/agent-a");
    updateRuntimeProviderState(admitted, "codex");

    const session = getSession(TEST_SESSION_KEYS[0]!);
    expect(session?.runtimeProvider).toBe("codex");
    expect(session?.providerSessionId).toBeUndefined();
  });

  it("does not clear an existing provider session id when only refreshing runtime provider metadata", () => {
    const admitted = getOrCreateSession(TEST_SESSION_KEYS[0]!, "agent-a", "/tmp/agent-a");
    expect(
      updateProviderSession(admitted, "codex", "resp_existing", {
        runtimeSessionParams: { sessionId: "resp_existing" },
        runtimeSessionDisplayId: "resp_existing",
      }).won,
    ).toBe(true);

    updateRuntimeProviderState(getSession(TEST_SESSION_KEYS[0]!)!, "codex");

    const session = getSession(TEST_SESSION_KEYS[0]!);
    expect(session?.runtimeProvider).toBe("codex");
    expect(session?.runtimeSessionParams).toEqual({ sessionId: "resp_existing" });
    expect(session?.runtimeSessionDisplayId).toBe("resp_existing");
    expect(session?.providerSessionId).toBe("resp_existing");
  });

  it("clears provider session state explicitly", () => {
    const admitted = getOrCreateSession(TEST_SESSION_KEYS[1]!, "agent-b", "/tmp/agent-b");
    expect(updateProviderSession(admitted, "claude", "synthetic-clear-locator").won).toBe(true);
    const owned = getSession(TEST_SESSION_KEYS[1]!)!;

    expect(clearProviderSession(owned)).toBe(true);

    const session = getSession(TEST_SESSION_KEYS[1]!);
    expect(session?.runtimeProvider).toBeUndefined();
    expect(session?.providerSessionId).toBeUndefined();
    expect(session?.lifecycleGeneration).toBe(owned.lifecycleGeneration! + 1);
    expect(clearProviderSession(owned)).toBe(false);
  });

  it("drops stale provider session state when the owning agent changes", () => {
    const admitted = getOrCreateSession(TEST_SESSION_KEYS[2]!, "agent-a", "/tmp/agent-a");
    expect(updateProviderSession(admitted, "claude", "synthetic-redirect-locator").won).toBe(true);
    const beforeRedirect = getSession(TEST_SESSION_KEYS[2]!)!;

    const moved = getOrCreateSession(TEST_SESSION_KEYS[2]!, "agent-b", "/tmp/agent-b");

    expect(moved.runtimeProvider).toBeUndefined();
    expect(moved.providerSessionId).toBeUndefined();
    expect(moved.lifecycleGeneration).toBe(beforeRedirect.lifecycleGeneration! + 1);
  });

  it("rejects provider persistence after a winning reset without restoring its locator", () => {
    const admitted = getOrCreateSession("test:runtime-provider:terminal-reset", "agent-a", "/tmp/agent-a", {
      runtimeProvider: "kimi-code",
      providerSessionId: "synthetic-prior-locator",
      runtimeSessionParams: { provider: "kimi-code", revision: 1 },
    });

    expect(clearProviderSession(admitted)).toBe(true);
    expect(
      updateProviderSession(admitted, "kimi-code", "synthetic-late-locator", {
        runtimeSessionParams: { provider: "kimi-code", revision: 2 },
      }),
    ).toEqual({ won: false, lifecycleGeneration: admitted.lifecycleGeneration! + 1 });
    expect(getSession(admitted.sessionKey)).toMatchObject({
      lifecycleGeneration: admitted.lifecycleGeneration! + 1,
      providerSessionId: undefined,
      runtimeSessionParams: undefined,
    });
  });

  it("rejects a same-epoch callback whose expected prior locator was superseded", () => {
    const admitted = getOrCreateSession("test:runtime-provider:lineage-cas", "agent-a", "/tmp/agent-a", {
      runtimeProvider: "kimi-code",
      providerSessionId: "synthetic-revision-1",
      runtimeSessionParams: { provider: "kimi-code", revision: 1 },
    });

    expect(
      updateProviderSession(admitted, "kimi-code", "synthetic-revision-2", {
        runtimeSessionParams: { provider: "kimi-code", revision: 2 },
      }).won,
    ).toBe(true);
    expect(
      updateProviderSession(admitted, "kimi-code", "synthetic-stale-revision", {
        runtimeSessionParams: { provider: "kimi-code", revision: 99 },
      }),
    ).toEqual({ won: false, lifecycleGeneration: admitted.lifecycleGeneration! });
    expect(getSession(admitted.sessionKey)?.providerSessionId).toBe("synthetic-revision-2");
  });
});
