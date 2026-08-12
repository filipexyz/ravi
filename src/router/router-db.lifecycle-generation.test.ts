import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { closeRouterDb, getDb } from "./router-db.js";
import {
  closeSessionStore,
  getOrCreateSession,
  getSession,
  resetSessionIfUnchanged,
  updateTokens,
} from "./sessions.js";

let stateDir: string | null = null;

describe("session lifecycle-generation migration", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-lifecycle-generation-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("drops the legacy after-update trigger so metadata is stable while lifecycle CAS advances once", () => {
    const admitted = getOrCreateSession("synthetic:legacy-trigger", "agent-a", "/tmp/agent-a");
    const db = getDb();
    db.exec("DROP TRIGGER IF EXISTS sessions_lifecycle_generation_after_update");
    db.exec(`CREATE TRIGGER sessions_lifecycle_generation_after_update
      AFTER UPDATE ON sessions FOR EACH ROW WHEN NEW.lifecycle_generation = OLD.lifecycle_generation
      BEGIN UPDATE sessions SET lifecycle_generation = lifecycle_generation + 1 WHERE session_key = NEW.session_key; END`);

    closeSessionStore();
    closeRouterDb();
    const reopened = getDb();

    expect(
      reopened
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get("sessions_lifecycle_generation_after_update"),
    ).toBeNull();

    updateTokens(admitted.sessionKey, 3, 5, 8);
    expect(getSession(admitted.sessionKey)?.lifecycleGeneration).toBe(admitted.lifecycleGeneration);

    expect(resetSessionIfUnchanged(admitted)).toBe(true);
    expect(getSession(admitted.sessionKey)?.lifecycleGeneration).toBe(admitted.lifecycleGeneration! + 1);
  });
});
