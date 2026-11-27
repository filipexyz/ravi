import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbCreateAgent, dbGetAgent, dbListAuditLog, dbUpdateAgent } from "./router-db.js";
import { buildAgentRuntimePermissionsDefaults } from "../permissions/agent-default-capabilities-provider.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

let stateDir: string | null = null;

describe("agent write audit", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-agent-write-audit-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("records who wrote and which defaults keys changed", () => {
    dbCreateAgent({ id: "audit-a", cwd: "/tmp/audit-a" });
    dbUpdateAgent("audit-a", { defaults: { tts_voice: "x", stickers: { enabled: true } } });
    dbUpdateAgent("audit-a", { defaults: { tts_voice: "y" } });

    const rows = dbListAuditLog("agent").filter((row) => row.entityId === "audit-a");
    expect(rows.length).toBe(2);
    const latest = rows[0]!;
    expect(latest.action).toBe("agent.updated");
    expect(typeof latest.actor).toBe("string");
    expect(latest.actor.length).toBeGreaterThan(0);
    const detail = latest.oldValue as Record<string, any>;
    expect(detail.defaults).toEqual({ added: [], removed: ["stickers"], changed: ["tts_voice"] });
    expect(detail.previousDefaults).toEqual({ tts_voice: "x", stickers: { enabled: true } });
  });

  it("does not write an audit row for a no-op update", () => {
    dbCreateAgent({ id: "audit-b", cwd: "/tmp/audit-b" });
    dbUpdateAgent("audit-b", { defaults: { tts_voice: "x" } });
    dbUpdateAgent("audit-b", { defaults: { tts_voice: "x" } });
    expect(dbListAuditLog("agent").filter((row) => row.entityId === "audit-b").length).toBe(1);
  });

  it("the permissions path still changes runtimePermissions and keeps other keys", () => {
    dbCreateAgent({ id: "audit-c", cwd: "/tmp/audit-c" });
    dbUpdateAgent("audit-c", { defaults: { tts_voice: "x" } });
    const before = dbGetAgent("audit-c")!;
    const next = buildAgentRuntimePermissionsDefaults(before.defaults, {
      profile: "explicit-only",
      capabilities: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
    });
    dbUpdateAgent("audit-c", { defaults: next });

    const after = dbGetAgent("audit-c")!;
    expect(after.defaults?.tts_voice).toBe("x");
    expect((after.defaults?.runtimePermissions as { profile?: string })?.profile).toBe("explicit-only");
    const latest = dbListAuditLog("agent").filter((row) => row.entityId === "audit-c")[0]!;
    expect((latest.oldValue as Record<string, any>).defaults.added).toEqual(["runtimePermissions"]);
  });
});
