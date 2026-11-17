import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateRoute, dbListRoutesBySessionName } from "./router-db.js";
import {
  getOrCreateSession,
  getSession,
  renameSessionName,
  resolveSession,
  updateSessionDisplayName,
} from "./sessions.js";

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

  it("refuses a name that equals another session's key or is key-shaped", () => {
    const owner = getOrCreateSession("agent:main:dm:5511900000001", "main", "/tmp/main", { name: "owner-dm" });
    const renamer = getOrCreateSession("agent:crm:main", "crm", "/tmp/crm", { name: "crm" });

    expect(() => renameSessionName(renamer.sessionKey, owner.sessionKey)).toThrow("collides with a session key");
    expect(() => renameSessionName(renamer.sessionKey, "agent:main:cron:job-1")).toThrow("reserved for session keys");
    expect(resolveSession(owner.sessionKey)?.sessionKey).toBe(owner.sessionKey);
    expect(getSession(renamer.sessionKey)?.name).toBe("crm");
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
