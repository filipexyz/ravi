import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { getOrCreateSession, updateProviderSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { resolveRuntimeSessionContinuity } from "./runtime-session-continuity.js";

const PARENT_SESSION_KEY = "agent:test:whatsapp:group:runtime-continuity";
const THREAD_SESSION_KEY = `${PARENT_SESSION_KEY}:thread:child`;
const ALIAS_PARENT_SESSION_KEY = "ravi-hil";
const ALIAS_THREAD_SESSION_KEY = `${ALIAS_PARENT_SESSION_KEY}:thread:1713000000.000100`;

let stateDir: string | null = null;

function cleanupSessions() {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE session_key IN (?, ?, ?, ?)").run(
    PARENT_SESSION_KEY,
    THREAD_SESSION_KEY,
    ALIAS_PARENT_SESSION_KEY,
    ALIAS_THREAD_SESSION_KEY,
  );
}

describe("runtime session continuity", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-session-continuity-");
    cleanupSessions();
  });

  afterEach(async () => {
    cleanupSessions();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("forks a thread from the parent when stale stored state is not resumable", () => {
    getOrCreateSession(PARENT_SESSION_KEY, "agent-a", "/tmp/agent-a");
    updateProviderSession(PARENT_SESSION_KEY, "codex", "parent-provider-session");

    const continuity = resolveRuntimeSessionContinuity({
      dbSessionKey: THREAD_SESSION_KEY,
      runtimeProviderId: "codex",
      supportsSessionFork: true,
      supportsSessionResume: true,
      storedProviderSessionId: "stale-child-provider-session",
      canResumeStoredSession: false,
      defaultRuntimeProviderId: "claude",
    });

    expect(continuity).toEqual({
      forkFromProviderSessionId: "parent-provider-session",
      resumeProviderSessionId: "parent-provider-session",
    });
  });

  it("prefers resumable stored state over parent fork", () => {
    getOrCreateSession(PARENT_SESSION_KEY, "agent-a", "/tmp/agent-a");
    updateProviderSession(PARENT_SESSION_KEY, "codex", "parent-provider-session");

    const continuity = resolveRuntimeSessionContinuity({
      dbSessionKey: THREAD_SESSION_KEY,
      runtimeProviderId: "codex",
      supportsSessionFork: true,
      supportsSessionResume: true,
      storedProviderSessionId: "child-provider-session",
      canResumeStoredSession: true,
      defaultRuntimeProviderId: "claude",
    });

    expect(continuity).toEqual({
      resumeProviderSessionId: "child-provider-session",
    });
  });

  it("never resumes or forks old context during a skill policy reconstruction", () => {
    getOrCreateSession(PARENT_SESSION_KEY, "agent-a", "/tmp/agent-a");
    updateProviderSession(PARENT_SESSION_KEY, "codex", "parent-with-revoked-skills");

    const options = {
      dbSessionKey: THREAD_SESSION_KEY,
      runtimeProviderId: "codex",
      supportsSessionFork: true,
      supportsSessionResume: true,
      storedProviderSessionId: "child-with-revoked-skills",
      canResumeStoredSession: true,
      defaultRuntimeProviderId: "claude",
      contextRebuildReason: "skill-policy-change",
    } satisfies Parameters<typeof resolveRuntimeSessionContinuity>[0];

    expect(resolveRuntimeSessionContinuity(options)).toEqual({});
    expect(resolveRuntimeSessionContinuity({ ...options, canResumeStoredSession: false })).toEqual({});
  });

  it("forks from a forced route parent session key", () => {
    getOrCreateSession(ALIAS_PARENT_SESSION_KEY, "ravi-hil", "/tmp/ravi-hil", { name: "ravi-hil" });
    updateProviderSession(ALIAS_PARENT_SESSION_KEY, "codex", "parent-provider-session");

    const continuity = resolveRuntimeSessionContinuity({
      dbSessionKey: ALIAS_THREAD_SESSION_KEY,
      runtimeProviderId: "codex",
      supportsSessionFork: true,
      supportsSessionResume: true,
      storedProviderSessionId: undefined,
      canResumeStoredSession: false,
      defaultRuntimeProviderId: "codex",
    });

    expect(continuity).toEqual({
      forkFromProviderSessionId: "parent-provider-session",
      resumeProviderSessionId: "parent-provider-session",
    });
  });
});
