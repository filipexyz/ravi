import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { getDb, getRaviDbPath, hashStoredContextKeys } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { RESERVED_RAVI_ENV_KEYS, SessionAdapterDefinitionSchema, type SessionAdapterDefinition } from "./types.js";
import {
  ensureSessionAdapterStoreSchema,
  getSessionAdapter,
  getSessionAdapterDebugSnapshot,
  listSessionAdapters,
  listSessionAdapterSubscriptions,
  saveSessionAdapter,
  saveSessionAdapterDebugSnapshot,
  saveSessionAdapterSubscription,
  updateSessionAdapterState,
} from "./adapter-db.js";

const TEST_SESSION_KEY = "test:adapter:session";
const TEST_ADAPTER_ID = "smoke-cli";
const TEST_SUBSCRIPTIONS = ["adapter-events", "adapter-commands"];

function cleanupAdapterState() {
  ensureSessionAdapterStoreSchema();
  const db = getDb();
  db.prepare("DELETE FROM session_adapter_subscriptions WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM session_adapter_debug WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM session_adapters WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM sessions WHERE session_key = ?").run(TEST_SESSION_KEY);
}

function buildDefinition(): SessionAdapterDefinition {
  return SessionAdapterDefinitionSchema.parse({
    name: "smoke-cli",
    description: "Minimal adapter contract for the STDIO smoke app",
    lifecycle: {
      install: {
        command: "bun",
        args: ["install"],
        env: {
          allow: ["HOME"],
          set: {
            ADAPTER_MODE: "install",
          },
        },
      },
      start: {
        command: "bun",
        args: ["run", "smoke"],
        env: {
          allow: ["PATH", "HOME"],
          set: {
            ADAPTER_MODE: "runtime",
          },
        },
      },
      stop: {
        command: "bun",
        args: ["run", "stop"],
      },
      restart: {
        command: "bun",
        args: ["run", "restart"],
      },
    },
    bindings: {
      sessionKey: TEST_SESSION_KEY,
      sessionName: "test-adapter-session",
      agentId: "agent-test",
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "group:123",
      },
      context: {
        cliName: "smoke-cli",
        capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
        ttlMs: 60_000,
      },
    },
  });
}

describe("Session adapter store", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-adapter-store-test-");
    cleanupAdapterState();
    getOrCreateSession(TEST_SESSION_KEY, "agent-test", "/tmp/agent-test");
  });

  afterEach(async () => {
    try {
      cleanupAdapterState();
    } finally {
      await cleanupIsolatedRaviState(stateDir);
      stateDir = null;
    }
  });

  it("rejects reserved Ravi identity env vars in adapter definitions", () => {
    for (const reservedKey of RESERVED_RAVI_ENV_KEYS) {
      expect(() =>
        SessionAdapterDefinitionSchema.parse({
          name: "bad-adapter",
          lifecycle: {
            start: {
              command: "bun",
              args: ["run", "bad"],
              env: {
                set: {
                  [reservedKey]: "spoofed",
                },
              },
            },
          },
          bindings: {
            sessionKey: TEST_SESSION_KEY,
            context: {
              cliName: "bad-adapter",
            },
          },
        }),
      ).toThrow(reservedKey);
    }
  });

  it("persists adapter contract and subscriptions in sqlite-backed storage", () => {
    const definition = buildDefinition();
    const created = saveSessionAdapter({
      adapterId: TEST_ADAPTER_ID,
      definition,
    });

    saveSessionAdapterSubscription({
      subscriptionId: TEST_SUBSCRIPTIONS[0]!,
      adapterId: TEST_ADAPTER_ID,
      sessionKey: TEST_SESSION_KEY,
      direction: "from-adapter",
      topic: "ravi.test.adapter.events",
      enabled: true,
      metadata: { event: "smoke.tick" },
    });
    saveSessionAdapterSubscription({
      subscriptionId: TEST_SUBSCRIPTIONS[1]!,
      adapterId: TEST_ADAPTER_ID,
      sessionKey: TEST_SESSION_KEY,
      direction: "to-adapter",
      topic: "ravi.test.adapter.commands",
      enabled: true,
      metadata: { command: "ping" },
    });

    const loaded = getSessionAdapter(TEST_ADAPTER_ID);
    const subscriptions = listSessionAdapterSubscriptions({ adapterId: TEST_ADAPTER_ID });

    expect(created.status).toBe("configured");
    expect(loaded?.definition.bindings.context.cliName).toBe("smoke-cli");
    expect(loaded?.definition.lifecycle.restart?.args).toEqual(["run", "restart"]);
    expect(loaded?.definition.lifecycle.start.env.allow).toEqual(["PATH", "HOME"]);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions.map((sub) => sub.direction).sort()).toEqual(["from-adapter", "to-adapter"]);
  });

  it("never stores the bound context key in a debug snapshot, and scrubs the ones older releases wrote", () => {
    saveSessionAdapter({ adapterId: TEST_ADAPTER_ID, definition: buildDefinition() });
    const key = "rctx_adapterDebugKeyMustNotBeStored01";
    const snapshot = {
      adapterId: TEST_ADAPTER_ID,
      bind: { sessionKey: TEST_SESSION_KEY, contextId: "ctx_adapter_debug", contextKey: key, cliName: "smoke" },
      updatedAt: Date.now(),
    };
    const saved = saveSessionAdapterDebugSnapshot({ adapterId: TEST_ADAPTER_ID, snapshot: snapshot as never });
    expect(JSON.stringify(saved)).not.toContain(key);
    expect((getSessionAdapterDebugSnapshot(TEST_ADAPTER_ID) as { bind: Record<string, unknown> }).bind.contextId).toBe(
      "ctx_adapter_debug",
    );

    // An older release wrote the key into the row; the context-key migration removes it.
    getDb()
      .prepare("UPDATE session_adapter_debug SET snapshot_json = ? WHERE adapter_id = ?")
      .run(JSON.stringify(snapshot), TEST_ADAPTER_ID);
    hashStoredContextKeys(getDb());
    getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const row = getDb()
      .prepare("SELECT snapshot_json FROM session_adapter_debug WHERE adapter_id = ?")
      .get(TEST_ADAPTER_ID) as { snapshot_json: string };
    expect(row.snapshot_json).not.toContain(key);
    expect(JSON.parse(row.snapshot_json).bind.contextId).toBe("ctx_adapter_debug");
    const dbPath = getRaviDbPath();
    for (const path of [dbPath, `${dbPath}-wal`]) {
      if (existsSync(path)) expect(readFileSync(path).includes(key)).toBe(false);
    }
  });

  it("tracks configured, running, stopped, and broken states distinctly", () => {
    saveSessionAdapter({
      adapterId: TEST_ADAPTER_ID,
      definition: buildDefinition(),
    });

    const running = updateSessionAdapterState(TEST_ADAPTER_ID, { status: "running" });
    const stopped = updateSessionAdapterState(TEST_ADAPTER_ID, { status: "stopped" });
    const broken = updateSessionAdapterState(TEST_ADAPTER_ID, {
      status: "broken",
      lastError: "stdout emitted invalid json",
    });

    const adapters = listSessionAdapters({ sessionKey: TEST_SESSION_KEY });

    expect(running.status).toBe("running");
    expect(running.lastStartedAt).toBeNumber();
    expect(stopped.status).toBe("stopped");
    expect(stopped.lastStoppedAt).toBeNumber();
    expect(broken.status).toBe("broken");
    expect(broken.lastError).toContain("invalid json");
    expect(broken.brokenAt).toBeNumber();
    expect(adapters.map((adapter) => adapter.status)).toEqual(["broken"]);
  });
});
