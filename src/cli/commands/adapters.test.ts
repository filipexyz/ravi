import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { dbCreateAgent, getDb } from "../../router/router-db.js";
import { getOrCreateSession, updateSessionName } from "../../router/sessions.js";
import {
  ensureSessionAdapterStoreSchema,
  saveSessionAdapter,
  saveSessionAdapterDebugSnapshot,
  type SessionAdapterDebugSnapshot,
  type SessionAdapterDefinition,
} from "../../adapters/index.js";
import { SessionAdapterDefinitionSchema } from "../../adapters/index.js";

const TEST_AGENT_ID = "adapter-debug-agent";
const TEST_SESSION_KEY = "adapter-debug-session-key";
const TEST_SESSION_NAME = "adapter-debug-session";
const TEST_ADAPTER_ID = "adapter-debug";

function cleanupAdapterState(): void {
  ensureSessionAdapterStoreSchema();
  const db = getDb();
  db.prepare("DELETE FROM session_adapter_debug WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM session_adapter_subscriptions WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM session_adapters WHERE adapter_id = ?").run(TEST_ADAPTER_ID);
  db.prepare("DELETE FROM contexts WHERE session_key = ?").run(TEST_SESSION_KEY);
  db.prepare("DELETE FROM sessions WHERE session_key = ?").run(TEST_SESSION_KEY);
  db.prepare("DELETE FROM agents WHERE id = ?").run(TEST_AGENT_ID);
}

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

const { AdapterCommands } = await import("./adapters.js");

function buildDefinition(): SessionAdapterDefinition {
  return SessionAdapterDefinitionSchema.parse({
    name: "adapter-debug",
    lifecycle: {
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
    },
    bindings: {
      sessionKey: TEST_SESSION_KEY,
      sessionName: TEST_SESSION_NAME,
      agentId: TEST_AGENT_ID,
      context: {
        cliName: "adapter-debug",
        kind: "cli-runtime",
        capabilities: [],
      },
    },
  });
}

function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    lines,
    restore() {
      console.log = original;
    },
  };
}

describe("AdapterCommands", () => {
  beforeEach(() => {
    cleanupAdapterState();
    dbCreateAgent({ id: TEST_AGENT_ID, cwd: "/tmp/adapter-debug-agent" });
    getOrCreateSession(TEST_SESSION_KEY, TEST_AGENT_ID, "/tmp/adapter-debug-agent", { name: TEST_SESSION_NAME });
    updateSessionName(TEST_SESSION_KEY, TEST_SESSION_NAME);
  });

  afterEach(() => {
    cleanupAdapterState();
  });

  it("lists health, bind, and last event details from persisted debug snapshots in --json mode", () => {
    saveSessionAdapter({
      adapterId: TEST_ADAPTER_ID,
      definition: buildDefinition(),
      status: "running",
    });
    saveSessionAdapterDebugSnapshot({
      adapterId: TEST_ADAPTER_ID,
      snapshot: {
        adapterId: TEST_ADAPTER_ID,
        adapterName: "adapter-debug",
        transport: "stdio-json",
        sessionKey: TEST_SESSION_KEY,
        sessionName: TEST_SESSION_NAME,
        status: "running",
        bind: {
          sessionKey: TEST_SESSION_KEY,
          sessionName: TEST_SESSION_NAME,
          agentId: TEST_AGENT_ID,
          contextId: "ctx_123",
          contextKey: "rctx_123",
          cliName: "adapter-debug",
        },
        health: {
          state: "running",
          pid: 4242,
          startedAt: 1000,
          stoppedAt: null,
          lastEventAt: 1200,
          lastExitCode: null,
          lastSignal: null,
          lastError: null,
          lastProtocolError: null,
          pendingCommands: 0,
          stderrTail: "",
        },
        lastEvent: {
          topic: `ravi.session.${TEST_SESSION_NAME}.adapter.event`,
          type: "event",
          event: "ready",
          payload: { smoke: true },
          publishedAt: 1100,
        },
        updatedAt: 1300,
      } satisfies SessionAdapterDebugSnapshot,
    });

    const capture = captureConsole();
    try {
      new AdapterCommands().list(TEST_SESSION_KEY, undefined, true);
    } finally {
      capture.restore();
    }

    const payload = JSON.parse(capture.lines.join("\n")) as {
      count: number;
      adapters: Array<{
        diagnosticState: string;
        bind: { bound: boolean; contextKey?: string };
        health: { state: string };
        lastEvent: { event: string };
      }>;
    };

    expect(payload.count).toBe(1);
    expect(payload.adapters[0]?.diagnosticState).toBe("live");
    expect(payload.adapters[0]?.bind.bound).toBe(true);
    expect("contextKey" in (payload.adapters[0]?.bind ?? {})).toBe(false);
    expect(payload.adapters[0]?.health.state).toBe("running");
    expect(payload.adapters[0]?.lastEvent.event).toBe("ready");
  });

  it("lists adapters in a human-readable summary by default", () => {
    saveSessionAdapter({
      adapterId: TEST_ADAPTER_ID,
      definition: buildDefinition(),
      status: "running",
    });
    saveSessionAdapterDebugSnapshot({
      adapterId: TEST_ADAPTER_ID,
      snapshot: {
        adapterId: TEST_ADAPTER_ID,
        adapterName: "adapter-debug",
        transport: "stdio-json",
        sessionKey: TEST_SESSION_KEY,
        sessionName: TEST_SESSION_NAME,
        status: "running",
        bind: {
          sessionKey: TEST_SESSION_KEY,
          sessionName: TEST_SESSION_NAME,
          agentId: TEST_AGENT_ID,
          contextId: "ctx_123",
          contextKey: "rctx_123",
          cliName: "adapter-debug",
        },
        health: {
          state: "running",
          pid: 4242,
          startedAt: 1000,
          stoppedAt: null,
          lastEventAt: 1200,
          lastExitCode: null,
          lastSignal: null,
          lastError: null,
          lastProtocolError: null,
          pendingCommands: 0,
          stderrTail: "",
        },
        lastEvent: {
          topic: `ravi.session.${TEST_SESSION_NAME}.adapter.event`,
          type: "event",
          event: "ready",
          payload: { smoke: true },
          publishedAt: 1100,
        },
        updatedAt: 1300,
      } satisfies SessionAdapterDebugSnapshot,
    });

    const capture = captureConsole();
    try {
      new AdapterCommands().list(TEST_SESSION_KEY);
    } finally {
      capture.restore();
    }

    const output = capture.lines.join("\n");
    expect(output).toContain("Adapters (1)");
    expect(output).toContain("- adapter-debug :: live :: running :: stdio-json");
    expect(output).toContain("lastEvent=ready");
    expect(output).not.toContain("rctx_123");
  });

  it("shows protocol-invalid explicitly when the persisted snapshot has a protocol failure in --json mode", () => {
    saveSessionAdapter({
      adapterId: TEST_ADAPTER_ID,
      definition: buildDefinition(),
      status: "broken",
      lastError: "stdout emitted invalid json",
    });
    saveSessionAdapterDebugSnapshot({
      adapterId: TEST_ADAPTER_ID,
      snapshot: {
        adapterId: TEST_ADAPTER_ID,
        adapterName: "adapter-debug",
        transport: "stdio-json",
        sessionKey: TEST_SESSION_KEY,
        sessionName: TEST_SESSION_NAME,
        status: "broken",
        bind: {
          sessionKey: TEST_SESSION_KEY,
          sessionName: TEST_SESSION_NAME,
          agentId: TEST_AGENT_ID,
          contextId: "ctx_123",
          contextKey: "rctx_123",
          cliName: "adapter-debug",
        },
        health: {
          state: "broken",
          pid: 4242,
          startedAt: 1000,
          stoppedAt: 1200,
          lastEventAt: 1100,
          lastExitCode: 1,
          lastSignal: null,
          lastError: "stdout emitted invalid json",
          lastProtocolError: {
            message: "Stdout protocol violation: event: Required",
            kind: "stdio-protocol-error",
            line: '{"type":"event"}',
            reason: "Stdout protocol violation: event: Required",
          },
          pendingCommands: 0,
          stderrTail: "",
        },
        lastProtocolError: {
          message: "Stdout protocol violation: event: Required",
          kind: "stdio-protocol-error",
          line: '{"type":"event"}',
          reason: "Stdout protocol violation: event: Required",
          publishedAt: 1100,
        },
        updatedAt: 1300,
      } satisfies SessionAdapterDebugSnapshot,
    });

    const capture = captureConsole();
    try {
      new AdapterCommands().show(TEST_ADAPTER_ID, true);
    } finally {
      capture.restore();
    }

    const payload = JSON.parse(capture.lines.join("\n")) as {
      diagnosticState: string;
      lastProtocolError: { reason: string };
    };

    expect(payload.diagnosticState).toBe("protocol-invalid");
    expect(payload.lastProtocolError.reason).toContain("protocol");
  });

  it("shows a human-readable adapter inspection by default", () => {
    saveSessionAdapter({
      adapterId: TEST_ADAPTER_ID,
      definition: buildDefinition(),
      status: "broken",
      lastError: "stdout emitted invalid json",
    });
    saveSessionAdapterDebugSnapshot({
      adapterId: TEST_ADAPTER_ID,
      snapshot: {
        adapterId: TEST_ADAPTER_ID,
        adapterName: "adapter-debug",
        transport: "stdio-json",
        sessionKey: TEST_SESSION_KEY,
        sessionName: TEST_SESSION_NAME,
        status: "broken",
        bind: {
          sessionKey: TEST_SESSION_KEY,
          sessionName: TEST_SESSION_NAME,
          agentId: TEST_AGENT_ID,
          contextId: "ctx_123",
          contextKey: "rctx_123",
          cliName: "adapter-debug",
        },
        health: {
          state: "broken",
          pid: 4242,
          startedAt: 1000,
          stoppedAt: 1200,
          lastEventAt: 1100,
          lastExitCode: 1,
          lastSignal: null,
          lastError: "stdout emitted invalid json",
          lastProtocolError: {
            message: "Stdout protocol violation: event: Required",
            kind: "stdio-protocol-error",
            line: '{"type":"event"}',
            reason: "Stdout protocol violation: event: Required",
          },
          pendingCommands: 0,
          stderrTail: "",
        },
        lastProtocolError: {
          message: "Stdout protocol violation: event: Required",
          kind: "stdio-protocol-error",
          line: '{"type":"event"}',
          reason: "Stdout protocol violation: event: Required",
          publishedAt: 1100,
        },
        updatedAt: 1300,
      } satisfies SessionAdapterDebugSnapshot,
    });

    const capture = captureConsole();
    try {
      new AdapterCommands().show(TEST_ADAPTER_ID);
    } finally {
      capture.restore();
    }

    const output = capture.lines.join("\n");
    expect(output).toContain("Adapter: adapter-debug");
    expect(output).toContain("Protocol Error");
    expect(output).toContain("stdio-protocol-error");
    expect(output).not.toContain("rctx_123");
  });
});
