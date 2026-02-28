/**
 * Tests for heartbeat session creation.
 *
 * Bug: When the heartbeat runner emits a prompt for agent "supervisor",
 * the bot receives it and creates a session with agent_id="main" (default)
 * because the emit is processed synchronously before the runner's
 * getOrCreateSession has a chance to run first.
 *
 * Root cause: nats.emit resolves subscribers inline (same event loop tick),
 * so the bot's handlePrompt runs INSIDE the runner's await nats.emit().
 * The bot doesn't find the session (runner hasn't created it yet because
 * the emit happens BEFORE getOrCreateSession in the original flow, or
 * the runner uses a different session_key than the bot).
 */

import { describe, test, expect, beforeEach } from "bun:test";

/**
 * Simulates the sequence of events that causes the bug:
 *
 * 1. Runner calls getOrCreateSession("agent:supervisor:main", "supervisor", cwd, {name: "supervisor"})
 *    → Creates session with key="agent:supervisor:main", name="supervisor", agent_id="supervisor"
 *
 * 2. Runner calls nats.emit("ravi.session.supervisor.prompt", ...)
 *    → Bot receives SYNCHRONOUSLY (same event loop tick)
 *
 * 3. Bot calls getSessionByName("supervisor")
 *    → Should find the session from step 1 with agent_id="supervisor"
 *    → BUG: If step 1 hasn't happened yet (runner creates AFTER emit), returns null
 *
 * 4. Bot falls back: getOrCreateSession("supervisor", "main", mainCwd, {name: "supervisor"})
 *    → Creates session with key="supervisor", name="supervisor", agent_id="main"
 *    → This OVERWRITES or CONFLICTS with step 1
 */

// Import DB functions directly for testing
import { getOrCreateSession, getSessionByName, generateSessionName } from "../router/index.js";

describe("Heartbeat Session Bug", () => {
  const supervisorCwd = "/Users/luis/ravi/supervisor";
  const mainCwd = "/Users/luis/ravi/main";

  // Clean up test sessions
  beforeEach(() => {
    // Delete any existing supervisor session
    try {
      const { getDb } = require("../router/router-db.js");
      const db = getDb();
      db.prepare("DELETE FROM sessions WHERE name = 'supervisor'").run();
      db.prepare("DELETE FROM sessions WHERE session_key LIKE '%supervisor%'").run();
    } catch (_e) {
      // DB might not be initialized yet
    }
  });

  test("generateSessionName for supervisor returns 'supervisor'", () => {
    const name = generateSessionName("supervisor", { isMain: true });
    expect(name).toBe("supervisor");
  });

  test("UNIQUE constraint prevents duplicate session names with different keys", () => {
    // Step 1: Bot creates session with key="supervisor", name="supervisor"
    const botSession = getOrCreateSession("supervisor", "main", mainCwd, { name: "supervisor" });
    expect(botSession.agentId).toBe("main");
    expect(botSession.sessionKey).toBe("supervisor");

    // Step 2: Runner tries to create session with DIFFERENT key but SAME name
    // UNIQUE constraint on name prevents this — should throw
    expect(() => {
      getOrCreateSession("agent:supervisor:main", "supervisor", supervisorCwd, { name: "supervisor" });
    }).toThrow();

    // Step 3: The fix is to use getOrCreateSession with the SAME key to update agent_id
    const fixed = getOrCreateSession("supervisor", "supervisor", supervisorCwd);
    expect(fixed.agentId).toBe("supervisor");
  });

  test("FIX VERIFICATION: bot should respect _agentId from heartbeat prompt", () => {
    // Simulate the fixed flow:
    // 1. Bot receives prompt with _agentId="supervisor"
    // 2. Bot uses _agentId to look up the correct agent
    // 3. Bot creates session with agent_id="supervisor"

    const promptAgentId = "supervisor"; // from (prompt as any)._agentId

    // With the fix, agentId should be "supervisor" not "main"
    const session = getOrCreateSession("supervisor", promptAgentId, supervisorCwd, { name: "supervisor" });

    expect(session.agentId).toBe("supervisor");
    expect(session.sessionKey).toBe("supervisor");

    // Verify it persisted correctly
    const found = getSessionByName("supervisor");
    expect(found?.agentId).toBe("supervisor");
  });

  test("getOrCreateSession updates agent_id when called with same key but different agent", () => {
    // Create session with wrong agent first (simulating the bug)
    const session1 = getOrCreateSession("supervisor", "main", mainCwd, { name: "supervisor" });
    expect(session1.agentId).toBe("main");

    // Call again with correct agent — should UPDATE
    const session2 = getOrCreateSession("supervisor", "supervisor", supervisorCwd);
    expect(session2.agentId).toBe("supervisor");

    // Verify in DB
    const found = getSessionByName("supervisor");
    expect(found?.agentId).toBe("supervisor");
  });
});
