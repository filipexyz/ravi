import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { dbCreateAgent, dbGetAgent, dbUpdateAgent } from "./router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { AGENT_CREATED_TOPIC, setLifecycleEventPublisher } from "../events/lifecycle-events.js";

const TEST_AGENT_IDS = ["test-provider-agent-a", "test-provider-agent-b"];
let stateDir: string | null = null;

function cleanupAgents() {
  try {
    const { getDb } = require("./router-db.js") as { getDb: () => import("bun:sqlite").Database };
    const db = getDb();
    for (const id of TEST_AGENT_IDS) {
      db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    }
  } catch {
    // DB may not be initialized yet
  }
}

describe("Agent provider persistence", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-agent-provider-test-");
    cleanupAgents();
  });

  afterEach(async () => {
    cleanupAgents();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("persists provider on create", () => {
    const created = dbCreateAgent({
      id: "test-provider-agent-a",
      cwd: "/tmp/test-provider-agent-a",
      provider: "codex",
    });

    expect(created.provider).toBe("codex");

    const loaded = dbGetAgent("test-provider-agent-a");
    expect(loaded?.provider).toBe("codex");
  });

  it("updates provider on existing agent", () => {
    dbCreateAgent({
      id: "test-provider-agent-b",
      cwd: "/tmp/test-provider-agent-b",
      provider: "claude",
    });

    const updated = dbUpdateAgent("test-provider-agent-b", { provider: "codex" });
    expect(updated.provider).toBe("codex");

    const loaded = dbGetAgent("test-provider-agent-b");
    expect(loaded?.provider).toBe("codex");
  });

  it("defaults to undefined provider when not set", () => {
    dbCreateAgent({
      id: "test-provider-agent-a",
      cwd: "/tmp/test-provider-agent-a",
    });

    const loaded = dbGetAgent("test-provider-agent-a");
    expect(loaded?.provider).toBeUndefined();
  });

  it("persists remote execution settings", () => {
    dbCreateAgent({
      id: "test-provider-agent-a",
      cwd: "/tmp/test-provider-agent-a",
      remote: "worker:201",
      remoteUser: "ubuntu",
    });

    let loaded = dbGetAgent("test-provider-agent-a");
    expect(loaded?.remote).toBe("worker:201");
    expect(loaded?.remoteUser).toBe("ubuntu");

    dbUpdateAgent("test-provider-agent-a", {
      remote: "10.10.10.201",
      remoteUser: "root",
    });

    loaded = dbGetAgent("test-provider-agent-a");
    expect(loaded?.remote).toBe("10.10.10.201");
    expect(loaded?.remoteUser).toBe("root");
  });

  it("emits ravi.agents.created once after the agent is persisted", () => {
    const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
    setLifecycleEventPublisher(async (topic, data) => {
      emitted.push({ topic, data });
    });
    try {
      dbCreateAgent({ id: "test-provider-agent-a", cwd: "/tmp/secret-agent-cwd", provider: "codex" });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].topic).toBe(AGENT_CREATED_TOPIC);
      expect(emitted[0].data).toMatchObject({
        version: 1,
        eventType: "agent.created",
        agentId: "test-provider-agent-a",
        provider: "codex",
      });
      expect(JSON.stringify(emitted[0].data)).not.toContain("/tmp/secret-agent-cwd");

      expect(() => dbCreateAgent({ id: "test-provider-agent-a", cwd: "/tmp/secret-agent-cwd" })).toThrow(
        "Agent already exists",
      );
      expect(emitted).toHaveLength(1);
    } finally {
      setLifecycleEventPublisher(null);
    }
  });

  it("keeps the agent when the lifecycle publisher fails", () => {
    setLifecycleEventPublisher(async () => {
      throw new Error("nats down");
    });
    try {
      dbCreateAgent({ id: "test-provider-agent-b", cwd: "/tmp/test-provider-agent-b" });
      expect(dbGetAgent("test-provider-agent-b")?.id).toBe("test-provider-agent-b");
    } finally {
      setLifecycleEventPublisher(null);
    }
  });
});
