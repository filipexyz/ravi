import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbCreateAgent, dbGetInstance, dbUpsertInstance } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { saveConnectedInstance } from "./instances.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-instances-connect-test-");
  dbCreateAgent({ id: "agent-a", cwd: stateDir });
  dbCreateAgent({ id: "agent-b", cwd: stateDir });
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("instances connect persistence", () => {
  it("keeps a closed instance closed and preserves its settings", () => {
    dbUpsertInstance({
      name: "locked",
      channel: "whatsapp",
      agent: "agent-a",
      dmPolicy: "closed",
      groupPolicy: "closed",
      contactIntakeMode: "pending",
      dmScope: "per-peer",
      enabled: false,
      defaults: { model: "x" },
      defaultContactTags: ["vip"],
    });

    const saved = saveConnectedInstance({
      name: "locked",
      instanceId: "omni-1",
      channel: "whatsapp",
      agent: "agent-b",
      existing: dbGetInstance("locked"),
    });

    expect(saved).toMatchObject({
      instanceId: "omni-1",
      agent: "agent-b",
      dmPolicy: "closed",
      groupPolicy: "closed",
      contactIntakeMode: "pending",
      dmScope: "per-peer",
      enabled: false,
      defaults: { model: "x" },
      defaultContactTags: ["vip"],
    });
  });

  it("keeps the agent when connect is not given one", () => {
    dbUpsertInstance({ name: "kept", channel: "whatsapp", agent: "agent-a", dmPolicy: "pairing" });
    const saved = saveConnectedInstance({
      name: "kept",
      instanceId: "omni-2",
      channel: "whatsapp",
      existing: dbGetInstance("kept"),
    });
    expect(saved.agent).toBe("agent-a");
    expect(saved.dmPolicy).toBe("pairing");
  });

  it("creates a new instance with the schema defaults", () => {
    const saved = saveConnectedInstance({
      name: "fresh",
      instanceId: "omni-3",
      channel: "whatsapp",
      agent: "agent-a",
      existing: null,
    });
    expect(saved).toMatchObject({ instanceId: "omni-3", agent: "agent-a", dmPolicy: "open", enabled: true });
  });
});
