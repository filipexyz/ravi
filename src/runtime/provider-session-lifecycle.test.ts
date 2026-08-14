import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getDb } from "../router/router-db.js";
import { deleteSessionIfUnchanged, getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  cleanupKimiCodeSessionState,
  commitKimiCodeSessionState,
  createKimiCodeSessionId,
  loadKimiCodeSessionState,
} from "./kimi-code-state.js";
import {
  runProviderSessionLifecycleMutation,
  runProviderSessionPersistenceMutation,
} from "./provider-session-lifecycle.js";
import { registerRuntimeProvider, unregisterRuntimeProvider } from "./provider-registry.js";
import type { KimiCodeConversationMessage } from "./kimi-code-turn.js";
import type { RuntimeSessionState } from "./types.js";

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

function temporaryState() {
  const root = mkdtempSync(join(tmpdir(), "ravi-kimi-lifecycle-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  temporaryRoots.add(root);
  return { root, cwd, env: { RAVI_STATE_DIR: join(root, "state"), KIMI_API_KEY: "test-key" } };
}

function nativeMessages(label: string): KimiCodeConversationMessage[] {
  return [
    { role: "user", content: `question-${label}` },
    { role: "assistant", content: `answer-${label}`, reasoning_content: `reasoning-${label}`, tool_calls: [] },
  ];
}

async function committedRevisions() {
  const fixture = temporaryState();
  const first = await commitKimiCodeSessionState({
    sessionId: createKimiCodeSessionId(),
    model: "k3",
    cwd: fixture.cwd,
    lastCommittedTurnId: "turn-1",
    messages: nativeMessages("one"),
    env: fixture.env,
  });
  const second = await commitKimiCodeSessionState({
    sessionId: first.snapshot.sessionId,
    model: "k3",
    cwd: fixture.cwd,
    lastCommittedTurnId: "turn-2",
    messages: nativeMessages("two"),
    previousSnapshot: first.snapshot,
    env: fixture.env,
  });
  return { ...fixture, first, second };
}

const kimiSession: RuntimeSessionState = {
  params: {
    provider: "kimi-code",
    schemaVersion: 1,
    model: "k3",
    sessionId: "00000000-0000-4000-8000-000000000000",
    revision: 1,
    cwd: "C:/workspace",
    workspaceIdentity: { realpath: "C:/workspace", device: "1", inode: "1" },
    sessionFile:
      "C:/state/runtime/kimi-code/sessions/00000000-0000-4000-8000-000000000000/revision-00000001-00000000-0000-4000-8000-000000000000.json",
    lastCommittedTurnId: "turn-1",
  },
  displayId: "kimi-locator",
};

describe("provider session lifecycle", () => {
  it("retires rev1 only after the host durably persists rev2", async () => {
    const fixture = await committedRevisions();
    const firstFile = String(fixture.first.session.params?.sessionFile);
    let persisted = fixture.first.session;

    await runProviderSessionPersistenceMutation({
      previousSession: persisted,
      nextSession: fixture.second.session,
      persist: () => {
        expect(existsSync(firstFile)).toBe(true);
        persisted = fixture.second.session;
      },
      env: fixture.env,
    });

    expect(persisted).toBe(fixture.second.session);
    expect(existsSync(firstFile)).toBe(false);
    await expect(
      loadKimiCodeSessionState({
        session: persisted,
        model: "k3",
        cwd: fixture.cwd,
        env: fixture.env,
      }),
    ).resolves.toEqual(fixture.second.snapshot);
  }, 20_000);

  it("cleans the Kimi locator captured before an exact mutation", async () => {
    const cleaned: RuntimeSessionState[] = [];
    let current: RuntimeSessionState | undefined = kimiSession;

    const changed = await runProviderSessionLifecycleMutation({
      session: kimiSession,
      mutate: () => {
        current = undefined;
        return true;
      },
      cleanupProviderState: async (snapshot) => {
        cleaned.push(snapshot);
      },
    });

    expect(changed).toBe(true);
    expect(current).toBeUndefined();
    expect(cleaned).toEqual([kimiSession]);
  });

  it("does not clean when a compare-and-set mutation lost a locator race", async () => {
    const cleaned: RuntimeSessionState[] = [];

    const changed = await runProviderSessionLifecycleMutation({
      session: kimiSession,
      mutate: () => false,
      cleanupProviderState: async (snapshot) => {
        cleaned.push(snapshot);
      },
    });

    expect(changed).toBe(false);
    expect(cleaned).toEqual([]);
  });

  it("fails closed before mutation when a registered provider locator is invalid", async () => {
    let mutated = false;

    const changed = await runProviderSessionLifecycleMutation({
      session: { ...kimiSession, params: { provider: "kimi-code", schemaVersion: 99 } },
      mutate: () => {
        mutated = true;
        return true;
      },
    });

    expect(changed).toBe(false);
    expect(mutated).toBe(false);
  });

  it("never runs provider cleanup for non-Kimi state", async () => {
    const cleaned: RuntimeSessionState[] = [];
    const changed = await runProviderSessionLifecycleMutation({
      session: { ...kimiSession, params: { provider: "codex" } },
      mutate: () => true,
      cleanupProviderState: async (snapshot) => {
        cleaned.push(snapshot);
      },
    });

    expect(changed).toBe(true);
    expect(cleaned).toEqual([]);
  });

  it("preserves a completed database mutation when cleanup fails", async () => {
    let mutated = false;
    const changed = await runProviderSessionLifecycleMutation({
      session: kimiSession,
      mutate: () => {
        mutated = true;
        return true;
      },
      cleanupProviderState: async () => {
        throw new Error("disk unavailable");
      },
    });

    expect(changed).toBe(true);
    expect(mutated).toBe(true);
  });

  it("reset or delete leaves no historical transcript when no newer locator exists", async () => {
    const fixture = await committedRevisions();
    const sessionDirectory = dirname(String(fixture.second.session.params?.sessionFile));
    let persisted: RuntimeSessionState | undefined = fixture.second.session;

    const changed = await runProviderSessionLifecycleMutation({
      session: persisted,
      mutate: () => {
        persisted = undefined;
        return true;
      },
      cleanupProviderState: (snapshot) => cleanupKimiCodeSessionState(snapshot, fixture.env),
      env: fixture.env,
    });

    expect(changed).toBe(true);
    expect(persisted).toBeUndefined();
    expect(existsSync(sessionDirectory)).toBe(false);
  }, 20_000);

  it("dispatches durable cleanup through a registered synthetic file-backed provider", async () => {
    const providerId = "synthetic-file-backed";
    const stateDir = await createIsolatedRaviState("ravi-synthetic-provider-lifecycle-");
    try {
      registerRuntimeProvider(
        providerId,
        () => ({
          id: providerId,
          getCapabilities: () => ({
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
            supportsPartialText: false,
            supportsToolHooks: false,
            supportsPlugins: false,
            supportsMcpServers: false,
            supportsRemoteSpawn: false,
          }),
          startSession: () => ({
            provider: providerId,
            events: (async function* () {})(),
            interrupt: async () => {},
          }),
        }),
        {
          sessionLifecycle: {
            createDeleteStateCleanup(session) {
              return session.params?.provider === providerId
                ? { operation: "delete_state", locator: session.params }
                : null;
            },
          },
        },
      );
      const entry = getOrCreateSession("synthetic:lifecycle", "main", stateDir);
      const session: RuntimeSessionState = {
        params: {
          ...kimiSession.params,
          provider: providerId,
          sessionFile: join(stateDir, "synthetic-session.json"),
        },
      };

      const changed = await runProviderSessionLifecycleMutation({
        session,
        mutate: () => deleteSessionIfUnchanged(entry),
      });

      expect(changed).toBe(true);
      expect(
        getDb()
          .prepare("SELECT provider, operation, status FROM provider_state_cleanup_tasks")
          .get(),
      ).toEqual({ provider: providerId, operation: "delete_state", status: "published" });
    } finally {
      unregisterRuntimeProvider(providerId);
      await cleanupIsolatedRaviState(stateDir);
    }
  });
});
