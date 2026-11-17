import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { getDb } from "../../router/router-db.js";
import {
  dbCreateTrigger,
  dbGetTrigger,
  dbListTriggers,
  dbUpdateTrigger,
  isOwnerNeutralTriggerUpdate,
  type TriggerUpdate,
} from "../triggers-db.js";

let stateDir: string | null = null;

describe("triggers-db replySession update path", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-triggers-db-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("persists replySession on create", () => {
    const trigger = dbCreateTrigger({
      name: "with-reply",
      agentId: "agent-a",
      topic: "ravi.audit.denied",
      message: "check",
      replySession: "captured-session",
    });

    const reloaded = dbGetTrigger(trigger.id);
    expect(reloaded?.replySession).toBe("captured-session");
  });

  it("updates replySession with a new value", () => {
    const trigger = dbCreateTrigger({
      name: "to-update",
      agentId: "agent-a",
      topic: "ravi.audit.denied",
      message: "check",
      replySession: "old-session",
    });

    dbUpdateTrigger(trigger.id, { replySession: "new-session" });

    const reloaded = dbGetTrigger(trigger.id);
    expect(reloaded?.replySession).toBe("new-session");
  });

  it("clears replySession when null is passed", () => {
    const trigger = dbCreateTrigger({
      name: "to-clear",
      agentId: "agent-a",
      topic: "ravi.audit.denied",
      message: "check",
      replySession: "frozen-session",
    });

    dbUpdateTrigger(trigger.id, { replySession: null });

    const reloaded = dbGetTrigger(trigger.id);
    expect(reloaded?.replySession).toBeUndefined();
  });

  it("leaves replySession untouched when not present in patch", () => {
    const trigger = dbCreateTrigger({
      name: "untouched",
      agentId: "agent-a",
      topic: "ravi.audit.denied",
      message: "check",
      replySession: "stable-session",
    });

    dbUpdateTrigger(trigger.id, { name: "renamed" });

    const reloaded = dbGetTrigger(trigger.id);
    expect(reloaded?.replySession).toBe("stable-session");
    expect(reloaded?.name).toBe("renamed");
  });

  it("persists shell execution fields", () => {
    const trigger = dbCreateTrigger({
      name: "shell-ticket",
      agentId: "agent-a",
      topic: "ravi.inbound.interaction",
      message: "",
      executionType: "shell",
      shellCommand: "bun scripts/ticket-flow.ts",
      shellTimeoutMs: 30_000,
      shellEnvFile: "/tmp/ticket.env",
      onError: "notify-session:ravi-channels",
    });

    const reloaded = dbGetTrigger(trigger.id);
    expect(reloaded?.executionType).toBe("shell");
    expect(reloaded?.shellCommand).toBe("bun scripts/ticket-flow.ts");
    expect(reloaded?.shellTimeoutMs).toBe(30_000);
    expect(reloaded?.shellEnvFile).toBe("/tmp/ticket.env");
    expect(reloaded?.onError).toBe("notify-session:ravi-channels");
  });

  it("clears shell execution fields when returning to agent message mode", () => {
    const trigger = dbCreateTrigger({
      name: "shell-to-agent",
      agentId: "agent-a",
      topic: "ravi.inbound.interaction",
      message: "",
      executionType: "shell",
      shellCommand: "printf ok",
      shellTimeoutMs: 30_000,
      shellEnvFile: "/tmp/ticket.env",
      onError: "notify-session:ravi-channels",
    });

    dbUpdateTrigger(trigger.id, {
      executionType: "agent",
      message: "hello",
      shellCommand: null,
      shellTimeoutMs: null,
      shellEnvFile: null,
      onError: null,
    });

    const reloaded = dbGetTrigger(trigger.id);
    expect(reloaded?.executionType).toBe("agent");
    expect(reloaded?.message).toBe("hello");
    expect(reloaded?.shellCommand).toBeUndefined();
    expect(reloaded?.shellTimeoutMs).toBeUndefined();
    expect(reloaded?.shellEnvFile).toBeUndefined();
    expect(reloaded?.onError).toBeUndefined();
  });
});

describe("triggers-db cooldown and debounce", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-triggers-db-debounce-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("defaults to a 5s cooldown and no debounce", () => {
    const trigger = dbCreateTrigger({ name: "defaults", topic: "x.y", message: "m" });
    expect(trigger.cooldownMs).toBe(5000);
    expect(trigger.debounceMs).toBe(0);
  });

  it("stores a disabled cooldown and a debounce window, and updates them", () => {
    const trigger = dbCreateTrigger({ name: "bus", topic: "x.y", message: "m", cooldownMs: 0, debounceMs: 2000 });
    expect(dbGetTrigger(trigger.id)?.cooldownMs).toBe(0);
    expect(dbGetTrigger(trigger.id)?.debounceMs).toBe(2000);

    dbUpdateTrigger(trigger.id, { debounceMs: 0, cooldownMs: 1000 });
    expect(dbGetTrigger(trigger.id)?.debounceMs).toBe(0);
    expect(dbGetTrigger(trigger.id)?.cooldownMs).toBe(1000);
  });
});

describe("triggers-db owner", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-triggers-db-owner-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const base = { name: "owned", agentId: "agent-a", topic: "ravi.console.inbox.item", message: "check" };
  const ownerOf = (id: string) => dbGetTrigger(id)?.ownerPrincipal;

  it("persists the owner given on create, and none when none is given", () => {
    const owned = dbCreateTrigger({ ...base, ownerPrincipal: "operator" });
    const byContact = dbCreateTrigger({ ...base, ownerPrincipal: "contact:c_ana" });
    const ownerless = dbCreateTrigger(base);
    const blank = dbCreateTrigger({ ...base, ownerPrincipal: "   " });
    // An unattributable turn owns nothing.
    const unknown = dbCreateTrigger({ ...base, ownerPrincipal: "unknown" });

    expect(ownerOf(owned.id)).toBe("operator");
    expect(ownerOf(byContact.id)).toBe("contact:c_ana");
    expect(ownerOf(ownerless.id)).toBeUndefined();
    expect(ownerOf(blank.id)).toBeUndefined();
    expect(ownerOf(unknown.id)).toBeUndefined();
    expect(dbListTriggers().find((trigger) => trigger.id === byContact.id)?.ownerPrincipal).toBe("contact:c_ana");
  });

  it("keeps the owner through changes that only pace the trigger or turn it off", () => {
    const trigger = dbCreateTrigger({ ...base, ownerPrincipal: "operator" });

    dbUpdateTrigger(trigger.id, { cooldownMs: 1000 });
    dbUpdateTrigger(trigger.id, { shellTimeoutMs: 30_000 });
    dbUpdateTrigger(trigger.id, { enabled: false });
    dbUpdateTrigger(trigger.id, { cooldownMs: 2000, name: undefined });

    expect(dbGetTrigger(trigger.id)).toMatchObject({ ownerPrincipal: "operator", enabled: false, cooldownMs: 2000 });
    expect(isOwnerNeutralTriggerUpdate({ cooldownMs: 1 })).toBe(true);
    expect(isOwnerNeutralTriggerUpdate({ enabled: false })).toBe(true);
    expect(isOwnerNeutralTriggerUpdate({ enabled: true })).toBe(false);
    expect(isOwnerNeutralTriggerUpdate({ debounceMs: 2000 })).toBe(false);
  });

  it("takes the owner away on any other change the owner did not make", () => {
    const patches: TriggerUpdate[] = [
      { name: "renamed" },
      { message: "another prompt" },
      { topic: "ravi.other" },
      { filter: 'data.kind == "x"' },
      { agentId: "agent-b" },
      { accountId: "acc" },
      { session: "elsewhere" },
      { replySession: "chat" },
      { replySource: { channel: "whatsapp", accountId: "acc", chatId: "chat" } },
      { executionType: "shell", shellCommand: "true" },
      { debounceMs: 2000 },
      { enabled: true },
    ];
    for (const patch of patches) {
      // Named by nobody (a programmatic writer), and by someone who is not the owner.
      const unnamed = dbCreateTrigger({ ...base, ownerPrincipal: "operator" });
      dbUpdateTrigger(unnamed.id, patch);
      expect(ownerOf(unnamed.id)).toBeUndefined();

      const foreign = dbCreateTrigger({ ...base, ownerPrincipal: "operator" });
      dbUpdateTrigger(foreign.id, patch, { keepOwnerFor: "contact:c_ana" });
      expect(ownerOf(foreign.id)).toBeUndefined();
    }
  });

  it("keeps the owner when the owner makes the change", () => {
    const trigger = dbCreateTrigger({ ...base, ownerPrincipal: "contact:c_ana" });

    dbUpdateTrigger(trigger.id, { message: "mine again", enabled: true }, { keepOwnerFor: "contact:c_ana" });

    expect(dbGetTrigger(trigger.id)).toMatchObject({ message: "mine again", ownerPrincipal: "contact:c_ana" });
  });

  it("never gives a trigger an owner, whoever asks", () => {
    const ownerless = dbCreateTrigger(base);
    dbUpdateTrigger(ownerless.id, { message: "rewritten" }, { keepOwnerFor: "operator" });
    expect(ownerOf(ownerless.id)).toBeUndefined();

    const cleared = dbCreateTrigger({ ...base, ownerPrincipal: "contact:c_ana" });
    dbUpdateTrigger(cleared.id, { filter: 'data.kind == "x"' }, { keepOwnerFor: "operator" });
    dbUpdateTrigger(cleared.id, { message: "rewritten" }, { keepOwnerFor: "operator" });
    expect(ownerOf(cleared.id)).toBeUndefined();

    // `unknown` is not an owner to keep.
    dbUpdateTrigger(ownerless.id, { message: "again" }, { keepOwnerFor: "unknown" });
    expect(ownerOf(ownerless.id)).toBeUndefined();
  });

  it("leaves the owner alone when the patch writes nothing", () => {
    const trigger = dbCreateTrigger({ ...base, ownerPrincipal: "operator" });
    dbUpdateTrigger(trigger.id, { agentId: undefined, accountId: undefined });
    expect(ownerOf(trigger.id)).toBe("operator");
  });

  it("reads a row written before owners were recorded as ownerless", () => {
    getDb()
      .prepare(
        "INSERT INTO triggers (id, name, topic, message, session, enabled, cooldown_ms, fire_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 5000, 0, 1, 1)",
      )
      .run("legacy01", "legacy", "ravi.console.inbox.item", "check", "main");

    const legacy = dbGetTrigger("legacy01");
    expect(legacy).toMatchObject({ id: "legacy01", enabled: true });
    expect(legacy?.ownerPrincipal).toBeUndefined();
  });
});
