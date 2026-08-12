import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCleanupExpiredSessions, getDb } from "./router-db.js";
import { getOrCreateSession, getSession, setSessionEphemeral } from "./sessions.js";

let stateDir: string | null = null;

describe("expired session lifecycle boundary", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-expired-session-lifecycle-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("counts only exact deletion winners supplied by the durable boundary", () => {
    const session = getOrCreateSession("session:expired-cas", "agent-a", stateDir ?? "/tmp");
    setSessionEphemeral(session.sessionKey, 1);
    const now = Date.now() + 10;

    expect(dbCleanupExpiredSessions(undefined, now, () => false)).toBe(0);
    expect(getSession(session.sessionKey)).not.toBeNull();

    expect(
      dbCleanupExpiredSessions(undefined, now, (candidate, cutoff) =>
        getDb()
          .prepare(
            `DELETE FROM sessions WHERE session_key = ? AND lifecycle_generation = ?
             AND ephemeral = 1 AND expires_at IS NOT NULL AND expires_at <= ?`,
          )
          .run(candidate.sessionKey, candidate.lifecycleGeneration, cutoff).changes === 1,
      ),
    ).toBe(1);
    expect(getSession(session.sessionKey)).toBeNull();
  });
});
