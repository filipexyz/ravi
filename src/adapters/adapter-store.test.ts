import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { RESERVED_RAVI_ENV_KEYS, SessionAdapterDefinitionSchema, type SessionAdapterDefinition } from "./types.js";
import {
  ensureSessionAdapterStoreSchema,
  getSessionAdapter,
  listSessionAdapters,
  listSessionAdapterSubscriptions,
  saveSessionAdapter,
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
  beforeEach(() => {
    cleanupAdapterState();
    getOrCreateSession(TEST_SESSION_KEY, "agent-test", "/tmp/agent-test");
  });

  afterEach(() => {
    cleanupAdapterState();
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
      metadata: { event: "smoke.tick" },
    });
    saveSessionAdapterSubscription({
      subscriptionId: TEST_SUBSCRIPTIONS[1]!,
      adapterId: TEST_ADAPTER_ID,
      sessionKey: TEST_SESSION_KEY,
      direction: "to-adapter",
      topic: "ravi.test.adapter.commands",
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
