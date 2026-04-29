import { describe, expect, it } from "bun:test";

function installChromeStorageMock() {
  const store = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        get(key, callback) {
          const result = {};
          const keys = Array.isArray(key) ? key : [key];
          for (const item of keys) {
            if (typeof item === "string" && store.has(item)) {
              result[item] = store.get(item);
            }
          }
          if (typeof callback === "function") {
            callback(result);
            return undefined;
          }
          return Promise.resolve(result);
        },
        set(items, callback) {
          for (const [key, value] of Object.entries(items ?? {})) {
            store.set(key, value);
          }
          if (typeof callback === "function") {
            callback();
            return undefined;
          }
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener() {},
        removeListener() {},
      },
    },
  };
}

installChromeStorageMock();

const { buildSnapshot } = await import("../../extensions/whatsapp-overlay/lib/compositions.js");

describe("whatsapp overlay extension compositions", () => {
  it("keeps recently idle sessions out of the active sessions list", async () => {
    const now = Date.now();
    const client = {
      sessions: {
        list: async () => ({
          sessions: [
            {
              sessionKey: "agent:dev:main",
              name: "dev",
              agentId: "dev",
              updatedAt: now - 1_000,
              createdAt: now - 10_000,
              live: { activity: "idle", summary: "turn complete", updatedAt: now - 500 },
            },
            {
              sessionKey: "agent:ravimem:main",
              name: "ravimem",
              agentId: "ravimem",
              updatedAt: now - 2_000,
              createdAt: now - 20_000,
              live: { activity: "idle", summary: "turn complete", updatedAt: now - 250 },
            },
            {
              sessionKey: "agent:active:main",
              name: "active-session",
              agentId: "active",
              updatedAt: now - 3_000,
              createdAt: now - 30_000,
              live: { activity: "thinking", summary: "running", updatedAt: now, busySince: now - 1_000 },
            },
          ],
        }),
      },
    };

    const snapshot = await buildSnapshot(client, {});

    expect(snapshot.activeSessions.map((session) => session.sessionName)).toEqual(["active-session"]);
    expect(snapshot.recentSessions.map((session) => session.sessionName)).toContain("dev");
    expect(snapshot.recentSessions.map((session) => session.sessionName)).toContain("ravimem");
  });
});
