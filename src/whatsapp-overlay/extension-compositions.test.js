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

const {
  buildCrmSnapshot,
  buildOmniPanelSnapshot,
  buildSnapshot,
  buildTasksSnapshot,
  executeOmniRoute,
  resolveChatList,
} = await import("../../extensions/whatsapp-overlay/lib/compositions.js");
const { setBindings } = await import("../../extensions/whatsapp-overlay/lib/storage.js");
const { RaviClient: ExtensionRaviClient } = await import("../../extensions/whatsapp-overlay/lib/sdk/client.js");

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
      agents: {
        list: async () => ({ agents: [{ id: "dev", name: "Dev" }] }),
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
    expect(result.sessions.map((session) => session.sessionName)).toEqual(["dev"]);
    expect(result.agents.map((agent) => agent.id)).toEqual(["dev"]);
  });

  it("keeps a local agent session binding visible before the runtime session exists", async () => {
    const now = Date.now();
    await setBindings([
      {
        chatId: "120363410237809091@g.us",
        title: "ravi - extension",
        session: "dev-ravi-extension",
        agentId: "dev",
        updatedAt: now,
      },
    ]);

    const client = {
      sessions: {
        list: async () => ({ sessions: [] }),
      },
      agents: {
        list: async () => ({ agents: [{ id: "dev", name: "Dev" }] }),
      },
    };

    const result = await resolveChatList(client, {
      entries: [
        {
          id: "chat-row-1",
          chatId: "120363410237809091@g.us",
          title: "ravi - extension",
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      resolved: true,
      session: {
        sessionName: "dev-ravi-extension",
        agentId: "dev",
        boundChatId: "120363410237809091@g.us",
      },
    });
    expect(result.agents.map((agent) => agent.id)).toEqual(["dev"]);
  });

  it("creates a runtime route when binding a session to a group chat", async () => {
    const calls = [];
    const client = {
      instances: {
        routes: {
          show: async (name, pattern) => {
            calls.push(["show", name, pattern]);
            throw new Error("not found");
          },
          add: async (name, pattern, agent, options) => {
            calls.push(["add", name, pattern, agent, options]);
            return { route: { accountId: name, pattern, agent, session: options.session } };
          },
        },
      },
    };

    const result = await executeOmniRoute(client, {
      action: "bind-existing",
      session: "dev",
      agentId: "dev",
      chatId: "120363410237809091@g.us",
      title: "ravi - extension",
      instance: "main",
      channel: "whatsapp",
    });

    expect(result).toMatchObject({
      ok: true,
      binding: {
        chatId: "120363410237809091@g.us",
        session: "dev",
        agentId: "dev",
        instance: "main",
      },
      runtimeRoute: {
        ok: true,
        action: "created",
        pattern: "group:120363410237809091",
        instance: "main",
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["show", "main", "group:120363410237809091"]);
    expect(calls[1]).toEqual([
      "add",
      "main",
      "group:120363410237809091",
      "dev",
      {
        allowRuntimeMismatch: true,
        asJson: true,
        session: "dev",
        priority: "100",
        channel: "whatsapp",
      },
    ]);
  });

  it("updates the runtime route session when rebinding a chat", async () => {
    const calls = [];
    let route = {
      accountId: "main",
      pattern: "group:120363410237809091",
      agent: "main",
      session: "old-session",
      priority: 0,
      channel: "whatsapp",
    };
    const client = {
      instances: {
        routes: {
          show: async (name, pattern) => {
            calls.push(["show", name, pattern]);
            return { route };
          },
          set: async (name, pattern, key, value, options) => {
            calls.push(["set", name, pattern, key, value, options]);
            route = { ...route, [key]: key === "priority" ? Number(value) : value };
            return { route };
          },
        },
      },
    };

    const result = await executeOmniRoute(client, {
      action: "bind-existing",
      session: "new-session",
      agentId: "dev",
      chatId: "120363410237809091@g.us",
      title: "ravi - extension",
      instance: "main",
      channel: "whatsapp",
    });

    expect(result).toMatchObject({
      ok: true,
      runtimeRoute: {
        ok: true,
        action: "updated",
        pattern: "group:120363410237809091",
        route: {
          agent: "dev",
          session: "new-session",
          priority: 100,
          channel: "whatsapp",
        },
      },
    });
    expect(calls).toContainEqual([
      "set",
      "main",
      "group:120363410237809091",
      "session",
      "new-session",
      { allowRuntimeMismatch: true, asJson: true },
    ]);
  });

  it("honors the editable session name when creating a route-backed session", async () => {
    const calls = [];
    const client = {
      instances: {
        routes: {
          show: async (name, pattern) => {
            calls.push(["show", name, pattern]);
            throw new Error("not found");
          },
          add: async (name, pattern, agent, options) => {
            calls.push(["add", name, pattern, agent, options]);
            return { route: { accountId: name, pattern, agent, session: options.session } };
          },
        },
      },
    };

    const result = await executeOmniRoute(client, {
      action: "create-session",
      sessionName: "custom-session",
      agentId: "dev",
      chatId: "120363410237809091@g.us",
      title: "ravi - extension",
      instance: "main",
      channel: "whatsapp",
    });

    expect(result).toMatchObject({
      ok: true,
      createdSession: true,
      binding: {
        session: "custom-session",
        agentId: "dev",
      },
      snapshot: {
        session: {
          sessionName: "custom-session",
          agentId: "dev",
        },
      },
    });
    expect(calls[1]).toEqual([
      "add",
      "main",
      "group:120363410237809091",
      "dev",
      {
        allowRuntimeMismatch: true,
        asJson: true,
        session: "custom-session",
        priority: "100",
        channel: "whatsapp",
      },
    ]);
  });

  it("supports migrating a chat route to a new agent session", async () => {
    const calls = [];
    let route = {
      accountId: "main",
      pattern: "group:120363410237809091",
      agent: "dev",
      session: "old-session",
      priority: 100,
      channel: "whatsapp",
    };
    const client = {
      instances: {
        routes: {
          show: async (name, pattern) => {
            calls.push(["show", name, pattern]);
            return { route };
          },
          set: async (name, pattern, key, value, options) => {
            calls.push(["set", name, pattern, key, value, options]);
            route = { ...route, [key]: key === "priority" ? Number(value) : value };
            return { route };
          },
        },
      },
    };

    const result = await executeOmniRoute(client, {
      action: "migrate-session",
      fromSession: "old-session",
      session: "support-session",
      agentId: "support",
      chatId: "120363410237809091@g.us",
      title: "ravi - extension",
      instance: "main",
      channel: "whatsapp",
    });

    expect(result).toMatchObject({
      ok: true,
      migratedSession: true,
      fromSession: "old-session",
      binding: {
        session: "support-session",
        agentId: "support",
      },
      runtimeRoute: {
        ok: true,
        action: "updated",
        route: {
          agent: "support",
          session: "support-session",
        },
      },
    });
    expect(calls).toContainEqual([
      "set",
      "main",
      "group:120363410237809091",
      "agent",
      "support",
      { allowRuntimeMismatch: true, asJson: true },
    ]);
  });

  it("loads configured Ravi instances for the overlay profile selector", async () => {
    const client = {
      sessions: {
        list: async () => ({ sessions: [] }),
      },
      agents: {
        list: async () => ({ agents: [] }),
      },
      routes: {
        list: async () => ({ routes: [] }),
      },
      instances: {
        list: async (options) => ({
          options,
          instances: [
            {
              name: "main",
              instanceId: "wa-main",
              channel: "whatsapp",
              enabled: true,
              live: { isConnected: true, profileName: "Luis" },
            },
            {
              name: "ops",
              instanceId: "wa-ops",
              channel: "whatsapp",
              enabled: true,
              live: { isConnected: false, profileName: "Ops" },
            },
          ],
        }),
      },
    };

    const snapshot = await buildOmniPanelSnapshot(client, { instance: "ops" });

    expect(snapshot.instances.map((instance) => instance.id)).toEqual(["main", "ops"]);
    expect(snapshot.instances[0]).toMatchObject({
      id: "main",
      name: "main",
      instanceId: "wa-main",
      profileName: "Luis",
      isConnected: true,
      isActive: true,
    });
    expect(snapshot.preferredInstance).toMatchObject({
      id: "ops",
      profileName: "Ops",
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

  it("builds the CRM workspace from native CRM commands", async () => {
    const calls = [];
    const client = {
      crm: {
        contacts: async (options) => {
          calls.push(["contacts", options]);
          return {
            total: 2,
            contacts: [
              {
                contactId: "contact_1",
                displayName: "Luis Filipe",
                lifecycle: "active",
                relationshipHealth: "healthy",
                priority: "high",
                nextActionSummary: "Enviar proposta",
              },
              {
                contactId: "contact_2",
                displayName: "Acme",
                lifecycle: "lead",
                relationshipHealth: "at_risk",
                priority: "normal",
              },
            ],
          };
        },
        next: async (options) => {
          calls.push(["next", options]);
          return {
            total: 1,
            actions: [
              {
                taskId: "crm_task_1",
                title: "Enviar proposta",
                priority: "urgent",
                dueAt: "2026-05-10T10:00:00.000Z",
                contactName: "Luis Filipe",
              },
            ],
          };
        },
        board: async () => {
          calls.push(["board"]);
          return {
            total: 1,
            opportunities: [
              {
                opportunityId: "crm_opp_1",
                title: "Piloto CRM",
                stageKey: "qualified",
                stageName: "Qualified",
                valueCents: 250000,
                currency: "BRL",
              },
            ],
          };
        },
      },
    };

    const snapshot = await buildCrmSnapshot(client, { limit: "50", owner: "agent:main" });

    expect(calls).toEqual([
      ["contacts", { limit: "50", owner: "agent:main" }],
      ["next", { limit: "50", owner: "agent:main" }],
      ["board"],
    ]);
    expect(snapshot).toMatchObject({
      ok: true,
      query: { limit: "50", owner: "agent:main" },
      totals: { contacts: 2, actions: 1, opportunities: 1 },
      stats: {
        totalContacts: 2,
        nextActions: 1,
        openOpportunities: 1,
        contactsByLifecycle: { active: 1, lead: 1 },
        actionsByPriority: { urgent: 1 },
        opportunitiesByStage: { qualified: 1 },
      },
    });
    expect(snapshot.contacts[0].contactId).toBe("contact_1");
    expect(snapshot.actions[0].taskId).toBe("crm_task_1");
    expect(snapshot.opportunities[0].opportunityId).toBe("crm_opp_1");
  });

  it("keeps the vendored extension SDK aligned with the CRM namespace", async () => {
    const calls = [];
    const client = new ExtensionRaviClient({
      call: async (input) => {
        calls.push(input);
        if (input.command === "contacts") return { total: 0, contacts: [] };
        if (input.command === "next") return { total: 0, actions: [] };
        if (input.command === "board") return { total: 0, opportunities: [] };
        throw new Error(`unexpected command: ${input.command}`);
      },
    });

    expect(typeof client.crm.contacts).toBe("function");
    expect(typeof client.crm.next).toBe("function");
    expect(typeof client.crm.board).toBe("function");

    await buildCrmSnapshot(client, { limit: "10" });

    expect(calls).toEqual([
      { groupSegments: ["crm"], command: "contacts", body: { limit: "10" } },
      { groupSegments: ["crm"], command: "next", body: { limit: "10" } },
      { groupSegments: ["crm"], command: "board", body: {} },
    ]);
  });
});
