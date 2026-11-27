import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  dbCreateAgent,
  dbGetAgent,
  dbListAuditLog,
  dbPatchAgentDefaults,
  dbRebaseAgentDefaults,
  dbUpdateAgent,
} from "./router-db.js";
import { buildAgentRuntimePermissionsDefaults } from "../permissions/agent-default-capabilities-provider.js";
import { runWithContext } from "../cli/context.js";
import { withConsoleInvocation, type ConsoleInvocation } from "../sdk/gateway/console-context.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

let stateDir: string | null = null;

function latestAudit(agentId: string) {
  return dbListAuditLog("agent").filter((row) => row.entityId === agentId)[0]!;
}

describe("agent write audit", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-agent-write-audit-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("records which defaults keys changed and only their old values", () => {
    dbCreateAgent({ id: "audit-a", cwd: "/tmp/audit-a" });
    dbUpdateAgent("audit-a", { defaults: { tts_voice: "x", stickers: { enabled: true }, tts_lang: "pt-br" } });
    dbUpdateAgent("audit-a", { defaults: { tts_voice: "y", tts_lang: "pt-br" } });

    const rows = dbListAuditLog("agent").filter((row) => row.entityId === "audit-a");
    expect(rows.length).toBe(2);
    const latest = rows[0]!;
    expect(latest.action).toBe("agent.updated");
    const detail = latest.oldValue as Record<string, any>;
    expect(detail.defaults).toEqual({ added: [], removed: ["stickers"], changed: ["tts_voice"] });
    // N4: never the whole previous object; unchanged tts_lang is not copied.
    expect(detail.previous).toEqual({ tts_voice: "x", stickers: { enabled: true } });
    expect(detail.previousDefaults).toBeUndefined();
  });

  it("redacts the old value of a secret-looking key", () => {
    dbCreateAgent({ id: "audit-s", cwd: "/tmp/audit-s" });
    dbUpdateAgent("audit-s", { defaults: { elevenlabs_api_key: "sk-old", tts_voice: "x" } });
    dbUpdateAgent("audit-s", { defaults: { elevenlabs_api_key: "sk-new", tts_voice: "x" } });
    const detail = latestAudit("audit-s").oldValue as Record<string, any>;
    expect(detail.previous).toEqual({ elevenlabs_api_key: "[redacted]" });
    expect(JSON.stringify(detail)).not.toContain("sk-old");
  });

  it("names the runtime context as the actor when the write runs inside one (gateway path)", () => {
    dbCreateAgent({ id: "audit-ctx", cwd: "/tmp/audit-ctx" });
    runWithContext({ contextId: "ctx_test_overlay", agentId: "main", sessionName: "main", transport: "gateway" }, () =>
      dbUpdateAgent("audit-ctx", { defaults: { tts_voice: "x" } }),
    );
    const actor = latestAudit("audit-ctx").actor;
    expect(actor).toContain("context=ctx_test_overlay");
    expect(actor).toContain("agent=main");
    expect(actor).toContain("transport=gateway");
    expect(actor).not.toContain("user=");
  });

  it("names the Console subject as the actor for a Console invocation", () => {
    dbCreateAgent({ id: "audit-console", cwd: "/tmp/audit-console" });
    const invocation = { grant: { sub: "user_console_1" } } as unknown as ConsoleInvocation;
    withConsoleInvocation(invocation, () => dbUpdateAgent("audit-console", { defaults: { tts_voice: "x" } }));
    expect(latestAudit("audit-console").actor).toBe("console:user_console_1");
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
    expect((latestAudit("audit-c").oldValue as Record<string, any>).defaults.added).toEqual(["runtimePermissions"]);
  });
});

describe("dbPatchAgentDefaults", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-agent-defaults-patch-db-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("merges against the row as stored at write time, not a stale copy", () => {
    dbCreateAgent({ id: "patch-a", cwd: "/tmp/patch-a" });
    dbUpdateAgent("patch-a", {
      defaults: { runtimePermissions: { profile: "full-access" }, tts_voice: "x" },
    });
    // A second writer lands a key after the first caller read the agent.
    dbUpdateAgent("patch-a", {
      defaults: { runtimePermissions: { profile: "full-access" }, tts_voice: "x", stickers: { enabled: true } },
    });

    dbPatchAgentDefaults("patch-a", { tts_voice: "y", tts_lang: null });

    expect(dbGetAgent("patch-a")?.defaults).toEqual({
      runtimePermissions: { profile: "full-access" },
      tts_voice: "y",
      stickers: { enabled: true },
    });
  });

  it("refuses a runtimePermissions change and leaves the row untouched", () => {
    dbCreateAgent({ id: "patch-b", cwd: "/tmp/patch-b" });
    dbUpdateAgent("patch-b", { defaults: { runtimePermissions: { profile: "full-access" } } });
    expect(() => dbPatchAgentDefaults("patch-b", { runtimePermissions: { profile: "none" } })).toThrow(
      /cannot change runtimePermissions/,
    );
    expect(dbGetAgent("patch-b")?.defaults).toEqual({ runtimePermissions: { profile: "full-access" } });
  });

  it("fails for an unknown agent", () => {
    expect(() => dbPatchAgentDefaults("patch-missing", { tts_voice: "y" })).toThrow(/Agent not found/);
  });
});

describe("dbRebaseAgentDefaults (writers that build a whole object from an earlier read)", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-agent-defaults-rebase-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("keeps a patch committed between the permissions writer's read and its write", () => {
    dbCreateAgent({ id: "rebase-a", cwd: "/tmp/rebase-a" });
    dbUpdateAgent("rebase-a", { defaults: { tts_voice: "x" } });

    // The permissions command reads the agent...
    const staleBase = dbGetAgent("rebase-a")!.defaults ?? {};
    const built = buildAgentRuntimePermissionsDefaults(staleBase, { profile: "bootstrap" });
    // ...another writer lands a patch before the permissions write...
    dbPatchAgentDefaults("rebase-a", { tts_voice: "y", stickers: { enabled: true } });
    // ...and the permissions write must not undo it.
    dbRebaseAgentDefaults("rebase-a", staleBase, built);

    const after = dbGetAgent("rebase-a")!.defaults!;
    expect(after.tts_voice).toBe("y");
    expect(after.stickers).toEqual({ enabled: true });
    expect((after.runtimePermissions as { profile?: string })?.profile).toBe("bootstrap");
  });

  it("removes a key the writer removed and clears to null when nothing is left", () => {
    dbCreateAgent({ id: "rebase-b", cwd: "/tmp/rebase-b" });
    dbUpdateAgent("rebase-b", { defaults: { modelBroker: { brokerId: "b" } } });
    const base = dbGetAgent("rebase-b")!.defaults ?? {};
    dbRebaseAgentDefaults("rebase-b", base, null);
    expect(dbGetAgent("rebase-b")!.defaults ?? null).toBeNull();
  });
});

describe("dbRebaseAgentDefaults deep merge and in-transaction guard", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-agent-defaults-deep-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("two permission writers granting different capabilities from the same read both land", () => {
    dbCreateAgent({ id: "deep-a", cwd: "/tmp/deep-a" });
    const git = { permission: "execute", objectType: "executable", objectId: "git" } as const;
    dbUpdateAgent("deep-a", { defaults: { runtimePermissions: { profile: "explicit-only", capabilities: [git] } } });
    const read = dbGetAgent("deep-a")!.defaults ?? {};

    const gh = { permission: "execute", objectType: "executable", objectId: "gh" } as const;
    const jq = { permission: "execute", objectType: "executable", objectId: "jq" } as const;
    dbRebaseAgentDefaults(
      "deep-a",
      read,
      buildAgentRuntimePermissionsDefaults(read, { profile: "explicit-only", capabilities: [git, gh] }),
    );
    dbRebaseAgentDefaults(
      "deep-a",
      read,
      buildAgentRuntimePermissionsDefaults(read, { profile: "explicit-only", capabilities: [git, jq] }),
    );

    const caps = (dbGetAgent("deep-a")!.defaults?.runtimePermissions as { capabilities?: Array<{ objectId: string }> })
      ?.capabilities;
    expect(caps?.map((cap) => cap.objectId).sort()).toEqual(["gh", "git", "jq"]);
  });

  it("redacts secret-looking keys nested under a neutral top-level key", () => {
    dbCreateAgent({ id: "deep-c", cwd: "/tmp/deep-c" });
    dbUpdateAgent("deep-c", { defaults: { provider: { name: "el", apiKey: "sk-old" } } });
    dbUpdateAgent("deep-c", { defaults: { provider: { name: "el", apiKey: "sk-new" } } });
    const detail = latestAudit("deep-c").oldValue as Record<string, any>;
    expect(detail.previous).toEqual({ provider: { name: "el", apiKey: "[redacted]" } });
    expect(JSON.stringify(detail)).not.toContain("sk-old");
  });
});
