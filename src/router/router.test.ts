import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent, dbCreateContext, dbListContexts, dbPruneContexts, getDb } from "./router-db.js";
import { getOrCreateSession } from "./sessions.js";

let stateDir: string | null = null;

const DAY = 24 * 60 * 60 * 1000;

function createContext(input: {
  id: string;
  agentId?: string;
  sessionKey?: string;
  kind?: "agent-runtime" | "turn-runtime" | "child-task" | "tool-call";
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
}) {
  dbCreateContext({
    contextId: input.id,
    contextKey: `key-${input.id}`,
    kind: input.kind ?? "turn-runtime",
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    capabilities: [],
    createdAt: input.createdAt,
    ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
    ...(input.revokedAt != null ? { revokedAt: input.revokedAt } : {}),
  });
}

describe("router context queries", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-context-query-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("lists contexts with SQL-backed filters and excludes inactive contexts by default", () => {
    const now = Date.now();
    dbCreateAgent({ id: "agent-a", cwd: "/tmp/ravi-agent-a" });
    dbCreateAgent({ id: "agent-b", cwd: "/tmp/ravi-agent-b" });
    getOrCreateSession("agent:agent-a:main", "agent-a", "/tmp/ravi-agent-a", { name: "agent-a-main" });
    getOrCreateSession("agent:agent-b:main", "agent-b", "/tmp/ravi-agent-b", { name: "agent-b-main" });

    createContext({
      id: "matching-live",
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      kind: "turn-runtime",
      createdAt: now - 3 * DAY,
      expiresAt: now + DAY,
    });
    createContext({
      id: "matching-expired",
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      kind: "turn-runtime",
      createdAt: now - 2 * DAY,
      expiresAt: now - DAY,
    });
    createContext({
      id: "other-agent",
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
      kind: "turn-runtime",
      createdAt: now - DAY,
      expiresAt: now + DAY,
    });
    createContext({
      id: "other-kind",
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      kind: "child-task",
      createdAt: now,
      expiresAt: now + DAY,
    });

    expect(
      dbListContexts({
        agentId: "agent-a",
        sessionKey: "agent:agent-a:main",
        kind: "turn-runtime",
      }).map((context) => context.contextId),
    ).toEqual(["matching-live"]);

    expect(
      dbListContexts({
        agentId: "agent-a",
        sessionKey: "agent:agent-a:main",
        kind: "turn-runtime",
        includeInactive: true,
      }).map((context) => context.contextId),
    ).toEqual(["matching-expired", "matching-live"]);
  });

  it("prunes inactive contexts in the database while preserving active contexts", () => {
    const now = Date.now();
    createContext({ id: "active", createdAt: now - 30 * DAY, expiresAt: now + DAY });
    createContext({ id: "expired-old", createdAt: now - 30 * DAY, expiresAt: now - 10 * DAY });
    createContext({ id: "revoked-old", createdAt: now - 30 * DAY, revokedAt: now - 10 * DAY });
    createContext({ id: "expired-recent", createdAt: now - DAY, expiresAt: now - 1000 });

    expect(dbPruneContexts({ olderThanMs: 7 * DAY })).toEqual({ matched: 2, pruned: 0 });
    expect(dbPruneContexts({ apply: true, olderThanMs: 7 * DAY })).toEqual({ matched: 2, pruned: 2 });

    expect(
      dbListContexts({ includeInactive: true })
        .map((context) => context.contextId)
        .sort(),
    ).toEqual(["active", "expired-recent"]);
  });

  it("creates trace indexes and shell trigger columns during schema bootstrap", () => {
    const db = getDb();
    const sessionEventIndexes = new Set(
      (db.prepare("PRAGMA index_list(session_events)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const contextIndexes = new Set(
      (db.prepare("PRAGMA index_list(contexts)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const triggerColumns = new Set(
      (db.prepare("PRAGMA table_info(triggers)").all() as Array<{ name: string }>).map((row) => row.name),
    );

    expect(sessionEventIndexes).toContain("idx_session_events_key_time_seq_id");
    expect(sessionEventIndexes).toContain("idx_session_events_visible_key_time_seq_id");
    expect(sessionEventIndexes).toContain("idx_session_events_key_type_id");
    expect(sessionEventIndexes).toContain("idx_session_events_rollup_turns_cover");
    expect(contextIndexes).toContain("idx_contexts_kind_created");
    expect(triggerColumns).toContain("execution_type");
    expect(triggerColumns).toContain("shell_command");
    expect(triggerColumns).toContain("shell_timeout_ms");
    expect(triggerColumns).toContain("shell_env_file");
    expect(triggerColumns).toContain("on_error");
  });
});
