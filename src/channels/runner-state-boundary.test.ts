import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { closeAllRaviDbs } from "../db/close-all.js";
import { initializeRuntimeState } from "../db/runtime-state.js";
import { initializeStateSchema, STATE_SCHEMA_VERSION } from "../db/schema-owner.js";
import { isSchemaConsumer } from "../db/state-boundary.js";
import * as nats from "../nats.js";
import { closeRouterDb, getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { channelOutputSinks } from "./backend.js";
import { createNativeChannelDriverHostLease } from "./native/host.js";
import { ChannelRunner, startChannelOutboundReceiptPruner } from "./runner.js";
import { channelRuntimeEventSinks } from "./runtime-events.js";

let stateDir: string;
let previousCredentialsPath: string | undefined;
const networkReached = new Error("fixture NATS boundary reached");

beforeAll(async () => {
  previousCredentialsPath = process.env.RAVI_CREDENTIALS_DB_PATH;
  delete process.env.RAVI_CREDENTIALS_DB_PATH;
  stateDir = await createIsolatedRaviState("ravi-runner-consumer-");
  await initializeRuntimeState();
  closeAllRaviDbs();
});

afterEach(() => {
  mock.restore();
  closeAllRaviDbs();
  process.env.RAVI_STATE_DIR = stateDir;
  delete process.env.RAVI_CREDENTIALS_DB_PATH;
});

afterAll(async () => {
  closeAllRaviDbs();
  await cleanupIsolatedRaviState(stateDir);
  if (previousCredentialsPath === undefined) delete process.env.RAVI_CREDENTIALS_DB_PATH;
  else process.env.RAVI_CREDENTIALS_DB_PATH = previousCredentialsPath;
});

describe("programmatic channel runner state boundary", () => {
  it("rejects a prepared option path when the actual stores select missing state before NATS", async () => {
    const missing = join(stateDir, "missing-process-state");
    process.env.RAVI_STATE_DIR = missing;
    const connect = spyOn(nats, "connectNats").mockRejectedValue(networkReached);
    await expect(new ChannelRunner({ env: { ...process.env, RAVI_STATE_DIR: stateDir } }).start()).rejects.toThrow(
      "STATE_PATH_MISMATCH",
    );
    expect(connect).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
  });

  it("rejects a missing option path instead of preflighting a different directory", async () => {
    const missing = join(stateDir, "missing-option-state");
    const connect = spyOn(nats, "connectNats").mockRejectedValue(networkReached);
    await expect(new ChannelRunner({ env: { ...process.env, RAVI_STATE_DIR: missing } }).start()).rejects.toThrow(
      "STATE_PATH_MISMATCH",
    );
    expect(connect).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
  });

  it("rejects a credential database override that differs from the stores before NATS", async () => {
    const missing = join(stateDir, "wrong-credentials.db");
    const connect = spyOn(nats, "connectNats").mockRejectedValue(networkReached);
    await expect(
      new ChannelRunner({ env: { ...process.env, RAVI_CREDENTIALS_DB_PATH: missing } }).start(),
    ).rejects.toThrow("STATE_PATH_MISMATCH");
    expect(connect).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
  });

  it("accepts symlink-equivalent paths and keeps startup async continuations in consumer scope", async () => {
    const alias = join(stateDir, "state-alias");
    symlinkSync(stateDir, alias, "dir");
    const connect = spyOn(nats, "connectNats").mockImplementation(async () => {
      await Promise.resolve();
      expect(isSchemaConsumer()).toBe(true);
      throw networkReached;
    });
    expect(isSchemaConsumer()).toBe(false);
    await expect(new ChannelRunner({ env: { ...process.env, RAVI_STATE_DIR: alias } }).start()).rejects.toThrow(
      networkReached.message,
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(isSchemaConsumer()).toBe(false);
  });

  it("reads status through a newly opened consumer handle without re-running schema writes", () => {
    const db = getDb();
    db.exec(`CREATE TRIGGER runner_no_marker_rewrite BEFORE DELETE ON state_schema_versions
      BEGIN SELECT RAISE(ABORT, 'runner attempted schema initialization'); END`);
    closeRouterDb();
    try {
      const status = new ChannelRunner().status();
      expect(status.outbound.publishOutbox?.lastError).toBeUndefined();
      expect(status.outbound.publishOutbox?.pendingCount).toBe(0);
      expect(isSchemaConsumer()).toBe(false);
    } finally {
      closeRouterDb();
      const cleanup = new Database(join(stateDir, "ravi.db"));
      cleanup.exec("DROP TRIGGER runner_no_marker_rewrite");
      cleanup.close();
    }
  });

  it("re-enters consumer scope when an injected scheduler invokes retained work outside startup", () => {
    let tick: (() => void) | undefined;
    const roles: boolean[] = [];
    const stop = startChannelOutboundReceiptPruner({
      setInterval(callback) {
        tick = callback;
        return { unref() {} } as ReturnType<typeof setInterval>;
      },
      clearInterval() {},
      store: {
        pruneExpired: () => {
          roles.push(isSchemaConsumer());
          return 0;
        },
      },
      publishOutboxStore: {
        prunePublished: () => {
          roles.push(isSchemaConsumer());
          return 0;
        },
      },
    });
    expect(isSchemaConsumer()).toBe(false);
    tick!();
    stop();
    expect(roles).toEqual([true, true]);
    expect(isSchemaConsumer()).toBe(false);
  });

  it("keeps externally invoked native sinks in consumer scope without demoting their caller", async () => {
    const lease = createNativeChannelDriverHostLease({
      channel: { name: "runner-boundary", provider: "example" },
      provider: "example",
    });
    const roles: boolean[] = [];
    const target = { channelKind: "example", connectionId: "runner-boundary", conversationId: "chat" };
    const binding = {
      channelInstanceId: "runner-boundary",
      chatId: "chat",
      messageId: "message",
      agentId: "agent",
      sessionId: "session",
      turnId: "turn",
    };
    lease.host.registerOutputSink(target, {
      async emit() {
        roles.push(isSchemaConsumer());
      },
    });
    lease.host.registerRuntimeEventSink(target, {
      async emit() {
        roles.push(isSchemaConsumer());
      },
    });
    try {
      expect(isSchemaConsumer()).toBe(false);
      await channelOutputSinks.emit({
        protocol: "ravi.channel.backend",
        schemaVersion: 1,
        outputId: "runner-output",
        correlationId: "correlation",
        binding,
        target,
        kind: "assistant_message",
        content: [{ type: "text", text: "done" }],
        emittedAt: "2026-11-07T12:00:00.000Z",
      });
      await channelRuntimeEventSinks.emit(target, {
        protocol: "ravi.channel.runtime-events",
        schemaVersion: 1,
        eventId: "runner-event",
        kind: "turn.state_changed",
        sequence: 0,
        correlation: { correlationId: "correlation", ingressRequestId: "request", binding },
        occurredAt: "2026-11-07T12:00:00.000Z",
        payload: { state: "running" },
      });
      expect(roles).toEqual([true, true]);
      expect(isSchemaConsumer()).toBe(false);
    } finally {
      lease.dispose();
    }
  });
});

describe("consumer schema validation with shared handles", () => {
  const consumer = { argv: ["bun", "fixture", "channels", "run"] };

  it.each([null, "old-release"])("revalidates a previously owner-initialized handle with marker %s", (version) => {
    const db = new Database(":memory:");
    try {
      initializeStateSchema(db, "runner-fixture", () => db.exec("CREATE TABLE sentinel (id INTEGER)"));
      if (version === null) db.query("DELETE FROM state_schema_versions WHERE component = ?").run("runner-fixture");
      else db.query("UPDATE state_schema_versions SET version = ? WHERE component = ?").run(version, "runner-fixture");
      expect(() => initializeStateSchema(db, "runner-fixture", () => {}, consumer)).toThrow("STATE_SCHEMA_NOT_READY");
    } finally {
      db.close();
    }
  });

  it("does not mark an owner callback initialized merely because a consumer validated readiness", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE state_schema_versions (component TEXT PRIMARY KEY, version TEXT NOT NULL)");
      db.query("INSERT INTO state_schema_versions VALUES (?, ?)").run("runner-fixture", STATE_SCHEMA_VERSION);
      const migrate = mock(() => db.exec("CREATE TABLE owner_sentinel (id INTEGER)"));
      initializeStateSchema(db, "runner-fixture", migrate, consumer);
      expect(migrate).not.toHaveBeenCalled();
      initializeStateSchema(db, "runner-fixture", migrate);
      expect(migrate).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
