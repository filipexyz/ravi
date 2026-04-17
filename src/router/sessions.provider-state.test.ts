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
    getOrCreateSession(TEST_SESSION_KEYS[0]!, "agent-a", "/tmp/agent-a");
    updateProviderSession(TEST_SESSION_KEYS[0]!, "codex", "resp_123", {
      runtimeSessionParams: { sessionId: "resp_123", cwd: "/tmp/agent-a" },
      runtimeSessionDisplayId: "resp_123",
    });

    const session = getSession(TEST_SESSION_KEYS[0]!);
    expect(session?.runtimeProvider).toBe("codex");
    expect(session?.runtimeSessionParams).toEqual({ sessionId: "resp_123", cwd: "/tmp/agent-a" });
    expect(session?.runtimeSessionDisplayId).toBe("resp_123");
    expect(session?.providerSessionId).toBe("resp_123");
  });

  it("persists runtime provider even before a provider session id exists", () => {
    getOrCreateSession(TEST_SESSION_KEYS[0]!, "agent-a", "/tmp/agent-a");
    updateRuntimeProviderState(TEST_SESSION_KEYS[0]!, "codex");

    const session = getSession(TEST_SESSION_KEYS[0]!);
    expect(session?.runtimeProvider).toBe("codex");
    expect(session?.providerSessionId).toBeUndefined();
  });

  it("clears provider session state explicitly", () => {
    getOrCreateSession(TEST_SESSION_KEYS[1]!, "agent-b", "/tmp/agent-b");
    updateProviderSession(TEST_SESSION_KEYS[1]!, "claude", "claude-session-1");

    clearProviderSession(TEST_SESSION_KEYS[1]!);

    const session = getSession(TEST_SESSION_KEYS[1]!);
    expect(session?.runtimeProvider).toBeUndefined();
    expect(session?.providerSessionId).toBeUndefined();
  });

  it("drops stale provider session state when the owning agent changes", () => {
    getOrCreateSession(TEST_SESSION_KEYS[2]!, "agent-a", "/tmp/agent-a");
    updateProviderSession(TEST_SESSION_KEYS[2]!, "claude", "claude-session-2");

    const moved = getOrCreateSession(TEST_SESSION_KEYS[2]!, "agent-b", "/tmp/agent-b");

    expect(moved.runtimeProvider).toBeUndefined();
    expect(moved.providerSessionId).toBeUndefined();
  });
});
