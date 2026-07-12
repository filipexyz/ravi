import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getOrCreateSession, getSession, updateSessionEffortOverride } from "./sessions.js";

let stateDir: string | null = null;

describe("sessions store", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-sessions-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("persists effort overrides while preserving default fallback semantics", () => {
    const session = getOrCreateSession("agent:dev:effort", "dev", "/tmp/dev");

    expect(session.effortOverride).toBeUndefined();
    expect(getSession(session.sessionKey)?.effortOverride).toBeUndefined();

    updateSessionEffortOverride(session.sessionKey, "high");
    expect(getSession(session.sessionKey)?.effortOverride).toBe("high");

    updateSessionEffortOverride(session.sessionKey, null);
    expect(getSession(session.sessionKey)?.effortOverride).toBeUndefined();
  });

  it("stores an initial effort override when creating a session", () => {
    const session = getOrCreateSession("agent:dev:initial-effort", "dev", "/tmp/dev", {
      effortOverride: "medium",
    });

    expect(session.effortOverride).toBe("medium");
    expect(getSession(session.sessionKey)?.effortOverride).toBe("medium");
  });
});
