import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateRoute, dbListRoutesBySessionName } from "./router-db.js";
import { getOrCreateSession, getSession, renameSessionName, updateSessionDisplayName } from "./sessions.js";

let stateDir: string | null = null;

describe("Session canonical rename", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-session-rename-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("keeps display-only changes out of canonical name and route references", () => {
    const session = getOrCreateSession("agent:main:dm:615153", "main", "/tmp/main", {
      name: "main-dm-615153",
    });
    dbCreateRoute({
      pattern: "5511*",
      accountId: "main",
      agent: "main",
      session: "main-dm-615153",
    });

    updateSessionDisplayName(session.sessionKey, "Luis DM");

    const after = getSession(session.sessionKey);
    expect(after?.name).toBe("main-dm-615153");
    expect(after?.displayName).toBe("Luis DM");
    expect(dbListRoutesBySessionName("main-dm-615153")).toHaveLength(1);
    expect(dbListRoutesBySessionName("Luis DM")).toHaveLength(0);
  });

  it("renames sessions.name and cascades active route session references", () => {
    const session = getOrCreateSession("agent:main:dm:615153", "main", "/tmp/main", {
      name: "main-dm-615153",
      displayName: "Luis DM",
    });
    dbCreateRoute({
      pattern: "5511*",
      accountId: "main",
      agent: "main",
      session: "main-dm-615153",
    });

    const result = renameSessionName(session.sessionKey, "main-dm-luis");

    expect(result.changed).toBe(true);
    expect(result.oldName).toBe("main-dm-615153");
    expect(result.newName).toBe("main-dm-luis");
    expect(result.routeReferencesUpdated).toBe(1);
    expect(result.after.sessionKey).toBe("agent:main:dm:615153");
    expect(getSession(session.sessionKey)?.name).toBe("main-dm-luis");
    expect(getSession(session.sessionKey)?.displayName).toBe("Luis DM");
    expect(dbListRoutesBySessionName("main-dm-615153")).toHaveLength(0);
    expect(dbListRoutesBySessionName("main-dm-luis")).toHaveLength(1);
  });

  it("rejects name collisions without changing either session", () => {
    const source = getOrCreateSession("agent:main:dm:615153", "main", "/tmp/main", {
      name: "main-dm-615153",
    });
    const other = getOrCreateSession("agent:main:main", "main", "/tmp/main", {
      name: "main",
    });

    expect(() => renameSessionName(source.sessionKey, "main")).toThrow("Session name already exists: main");
    expect(getSession(source.sessionKey)?.name).toBe("main-dm-615153");
    expect(getSession(other.sessionKey)?.name).toBe("main");
  });

  it("does not rewrite session_key during canonical rename", () => {
    const session = getOrCreateSession("agent:main:dm:615153", "main", "/tmp/main", {
      name: "main-dm-615153",
    });

    const result = renameSessionName(session.sessionKey, "main-dm-luis");

    expect(result.after.sessionKey).toBe(session.sessionKey);
    expect(getSession("agent:main:dm:615153")?.name).toBe("main-dm-luis");
  });
});
