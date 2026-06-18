import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dbCreateTrigger, dbGetTrigger, dbUpdateTrigger } from "../triggers-db.js";

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
});
