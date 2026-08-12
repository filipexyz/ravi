import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "./router-db.js";
import {
  clearProviderSession,
  getOrCreateSession,
  getSession,
  redirectSessionIfUnchanged,
  updateProviderSession,
  updateRuntimeProviderState,
  updateSdkSessionId,
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

  it("redirects ownership and enqueues the old locator in one transaction", () => {
    const admitted = getOrCreateSession(TEST_SESSION_KEYS[2]!, "agent-a", "/tmp/agent-a");
    expect(
      updateProviderSession(admitted, "kimi-code", "00000000-0000-4000-8000-00000000000c", {
        runtimeSessionDisplayId: "00000000-0000-4000-8000-00000000000c",
        runtimeSessionParams: {
          schemaVersion: 1,
          provider: "kimi-code",
          model: "k3",
          sessionId: "00000000-0000-4000-8000-00000000000c",
          revision: 1,
          cwd: "/workspace/project",
          workspaceIdentity: { realpath: "/workspace/project", device: "1", inode: "2" },
          sessionFile: "/private/kimi/c/revision-1.json",
          lastCommittedTurnId: "turn-1",
        },
      }).won,
    ).toBe(true);
    const beforeRedirect = getSession(TEST_SESSION_KEYS[2]!)!;

    const redirect = redirectSessionIfUnchanged(beforeRedirect, "agent-b", "/tmp/agent-b");
    const moved = redirect.session;

    expect(redirect.won).toBe(true);
    expect(moved?.agentId).toBe("agent-b");
    expect(moved?.runtimeProvider).toBeUndefined();
    expect(moved?.providerSessionId).toBeUndefined();
    expect(moved?.lifecycleGeneration).toBe(beforeRedirect.lifecycleGeneration! + 1);
    expect(
      getDb().prepare("SELECT operation, status FROM provider_state_cleanup_tasks").all(),
    ).toEqual([{ operation: "delete_state", status: "published" }]);
  });

  it("does not redirect or enqueue cleanup after ownership changes", () => {
    const admitted = getOrCreateSession(TEST_SESSION_KEYS[2]!, "agent-a", "/tmp/agent-a");
    getDb()
      .prepare("UPDATE sessions SET lifecycle_generation = lifecycle_generation + 1 WHERE session_key = ?")
      .run(admitted.sessionKey);

    const redirect = redirectSessionIfUnchanged(admitted, "agent-b", "/tmp/agent-b");

    expect(redirect.won).toBe(false);
    expect(redirect.session?.agentId).toBe("agent-a");
    expect(
      (getDb().prepare("SELECT COUNT(*) AS count FROM provider_state_cleanup_tasks").get() as { count: number }).count,
    ).toBe(0);
  });

  it("treats a canonical workspace change as a lifecycle redirect", () => {
    const admitted = getOrCreateSession("test:runtime-provider:workspace-redirect", "agent-a", "/workspace/old");

    const redirect = redirectSessionIfUnchanged(admitted, "agent-a", "/workspace/new");

    expect(redirect).toMatchObject({
      won: true,
      session: {
        agentId: "agent-a",
        agentCwd: "/workspace/new",
        lifecycleGeneration: admitted.lifecycleGeneration! + 1,
      },
    });
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

  it("rejects key-only locator persistence instead of reacquiring ownership after reset", () => {
    const admitted = getOrCreateSession("test:runtime-provider:key-only", "agent-a", "/tmp/agent-a", {
      runtimeProvider: "kimi-code",
      providerSessionId: "synthetic-admitted-locator",
      runtimeSessionParams: { provider: "kimi-code", revision: 1 },
    });
    expect(clearProviderSession(admitted)).toBe(true);

    const unsafeKeyOnlyCall = updateProviderSession as unknown as (
      sessionKey: string,
      runtimeProvider: "kimi-code",
      providerSessionId: string,
    ) => { won: boolean };
    expect(unsafeKeyOnlyCall(admitted.sessionKey, "kimi-code", "synthetic-late-locator").won).toBe(false);
    expect(getSession(admitted.sessionKey)?.providerSessionId).toBeUndefined();
  });

  it("fences ordinary runtime-provider metadata with the admitted ownership snapshot", () => {
    const admitted = getOrCreateSession("test:runtime-provider:metadata-cas", "agent-a", "/tmp/agent-a", {
      runtimeProvider: "kimi-code",
      providerSessionId: "synthetic-metadata-locator",
      runtimeSessionParams: { provider: "kimi-code", revision: 1 },
    });
    expect(clearProviderSession(admitted)).toBe(true);

    expect(updateRuntimeProviderState(admitted, "claude")).toEqual({
      won: false,
      lifecycleGeneration: admitted.lifecycleGeneration! + 1,
    });
    expect(getSession(admitted.sessionKey)?.runtimeProvider).toBeUndefined();
  });

  it("fences the SDK locator compatibility boundary with admitted ownership", () => {
    const admitted = getOrCreateSession("test:runtime-provider:sdk-cas", "agent-a", "/tmp/agent-a");
    expect(clearProviderSession(admitted)).toBe(true);

    const unsafeKeyOnlyCall = updateSdkSessionId as unknown as (
      sessionKey: string,
      providerSessionId: string,
    ) => { won: boolean; lifecycleGeneration: number | null };
    expect(unsafeKeyOnlyCall(admitted.sessionKey, "synthetic-stale-sdk-locator")).toEqual({
      won: false,
      lifecycleGeneration: null,
    });
    expect(getSession(admitted.sessionKey)?.providerSessionId).toBeUndefined();
  });
});
