import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { closeRouterDb, getDb } from "./router-db.js";
import {
  closeSessionStore,
  deleteSessionIfUnchanged,
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

  it("upgrades cleanup-task schema idempotently without cascading session deletion", () => {
    const admitted = getOrCreateSession("synthetic:cleanup-owner", "agent-a", "/tmp/agent-a");
    const db = getDb();
    const columns = db.prepare("PRAGMA table_info(provider_state_cleanup_tasks)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "idempotency_key",
      "schema_version",
      "provider",
      "operation",
      "locator_json",
      "successor_locator_json",
      "status",
      "owner_attempt_id",
      "owner_session_key",
      "owner_boot_epoch",
      "attempt_count",
      "next_attempt_at",
      "lease_id",
      "leased_until",
      "last_error_code",
      "created_at",
      "updated_at",
    ]);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("idx_provider_state_cleanup_ready"),
    ).not.toBeNull();
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("idx_provider_state_cleanup_lease"),
    ).not.toBeNull();
    expect(() =>
      db
        .prepare(
          `INSERT INTO provider_state_cleanup_tasks (
          id, idempotency_key, schema_version, provider, operation, locator_json,
          status, created_at, updated_at
        ) VALUES (?, ?, 2, ?, 'delete_state', ?, 'published', ?, ?)`,
        )
        .run("cleanup-invalid-version", "idem-invalid-version", "kimi-code", "{}", 100, 100),
    ).toThrow();

    db.prepare(
      `INSERT INTO provider_state_cleanup_tasks (
        id, idempotency_key, schema_version, provider, operation, locator_json,
        status, created_at, updated_at
      ) VALUES (?, ?, 1, ?, 'delete_state', ?, 'published', ?, ?)`,
    ).run("cleanup-1", "idem-1", "kimi-code", "{}", 100, 100);
    expect(deleteSessionIfUnchanged(admitted)).toBe(true);
    expect(db.prepare("SELECT id FROM provider_state_cleanup_tasks WHERE id = ?").get("cleanup-1")).toEqual({
      id: "cleanup-1",
    });

    closeSessionStore();
    closeRouterDb();
    expect(getDb().prepare("SELECT id FROM provider_state_cleanup_tasks WHERE id = ?").get("cleanup-1")).toEqual({
      id: "cleanup-1",
    });
  });
});
