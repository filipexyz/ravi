import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { dbCreateAgent, dbGetAgent, dbUpdateAgent } from "./router-db.js";

const TEST_AGENT_IDS = ["test-provider-agent-a", "test-provider-agent-b"];

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
  beforeEach(() => {
    cleanupAgents();
  });

  afterEach(() => {
    cleanupAgents();
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
});
