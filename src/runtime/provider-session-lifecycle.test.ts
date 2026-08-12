import { describe, expect, it } from "bun:test";
import { runProviderSessionLifecycleMutation } from "./provider-session-lifecycle.js";
import type { RuntimeSessionState } from "./types.js";

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
  it("cleans the Kimi locator captured before an exact mutation", async () => {
    const cleaned: RuntimeSessionState[] = [];
    let current: RuntimeSessionState | undefined = kimiSession;

    const changed = await runProviderSessionLifecycleMutation({
      session: kimiSession,
      mutate: () => {
        current = undefined;
        return true;
      },
      cleanupKimi: async (snapshot) => {
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
      cleanupKimi: async (snapshot) => {
        cleaned.push(snapshot);
      },
    });

    expect(changed).toBe(false);
    expect(cleaned).toEqual([]);
  });

  it("never runs provider cleanup for non-Kimi state", async () => {
    const cleaned: RuntimeSessionState[] = [];
    const changed = await runProviderSessionLifecycleMutation({
      session: { ...kimiSession, params: { provider: "codex" } },
      mutate: () => true,
      cleanupKimi: async (snapshot) => {
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
      cleanupKimi: async () => {
        throw new Error("disk unavailable");
      },
    });

    expect(changed).toBe(true);
    expect(mutated).toBe(true);
  });
});
