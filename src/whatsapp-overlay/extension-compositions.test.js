import { beforeEach, describe, expect, it } from "bun:test";

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
  return store;
}

const chromeStorage = installChromeStorageMock();

const { buildSnapshot, buildTasksSnapshot, resolveChatList } = await import(
  "../../extensions/whatsapp-overlay/lib/compositions.js"
);
const { setBindings } = await import("../../extensions/whatsapp-overlay/lib/storage.js");

describe("whatsapp overlay extension compositions", () => {
  beforeEach(() => {
    chromeStorage.clear();
  });

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

  it("resolves chat list rows from the flat content-script entry shape", async () => {
    const now = Date.now();
    await setBindings([
      {
        chatId: "120363424772797713@g.us",
        title: "ravi - dev",
        session: "dev",
        updatedAt: now,
      },
    ]);

    const client = {
      sessions: {
        list: async () => ({
          sessions: [
            {
              sessionKey: "agent:dev:main",
              name: "dev",
              agentId: "dev",
              displayName: "ravi - dev",
              lastTo: "120363424772797713@g.us",
              updatedAt: now,
              createdAt: now - 10_000,
              live: { activity: "idle", summary: "turn complete", updatedAt: now },
            },
          ],
        }),
      },
    };

    const result = await resolveChatList(client, {
      entries: [
        {
          id: "chat-row-1",
          chatId: "120363424772797713@g.us",
          title: "ravi - dev",
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      id: "chat-row-1",
      resolved: true,
      session: {
        sessionName: "dev",
        live: { activity: "idle", summary: "turn complete" },
      },
    });
  });

  it("loads all visible tasks for the workspace and reports status counts", async () => {
    let listOptions = null;
    const now = Date.now();
    const tasks = [
      { id: "task-open", title: "Open", status: "open", priority: "normal", updatedAt: now },
      { id: "task-dispatched", title: "Queued", status: "dispatched", priority: "normal", updatedAt: now - 1 },
      { id: "task-working", title: "Working", status: "in_progress", priority: "normal", updatedAt: now - 2 },
      { id: "task-blocked", title: "Blocked", status: "blocked", priority: "normal", updatedAt: now - 3 },
      { id: "task-done", title: "Done", status: "done", priority: "normal", updatedAt: now - 4 },
      { id: "task-failed", title: "Failed", status: "failed", priority: "normal", updatedAt: now - 5 },
    ];
    const client = {
      tasks: {
        list: async (options) => {
          listOptions = options;
          return { archiveMode: "exclude", limit: null, tasks };
        },
        show: async (taskId) => ({ task: tasks.find((task) => task.id === taskId) }),
      },
      sessions: {
        list: async () => ({ sessions: [] }),
      },
    };

    const snapshot = await buildTasksSnapshot(client, {});

    expect(listOptions).toMatchObject({ last: "all" });
    expect(snapshot.items).toHaveLength(6);
    expect(snapshot.query).toMatchObject({
      last: "all",
      archiveMode: "exclude",
      limit: null,
    });
    expect(snapshot.stats).toMatchObject({
      total: 6,
      open: 1,
      dispatched: 1,
      queued: 1,
      inProgress: 1,
      blocked: 1,
      done: 1,
      failed: 1,
    });
  });
});
