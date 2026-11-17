import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { openStateDatabase } from "../../db/state-boundary.js";
import { getDb, getRaviDbPath } from "../../router/router-db.js";
import {
  bumpSessionRuntimeProviderConfigRevision,
  getOrCreateSession,
  resolveSession,
  updateSessionEffortOverride,
  updateSessionModelOverride,
  updateSessionRuntimeProviderOverride,
} from "../../router/sessions.js";
import { createClaudeRuntimeProvider } from "../../runtime/claude-provider.js";
import { registerRuntimeProvider } from "../../runtime/provider-registry.js";
import type { RuntimeEvent, SessionRuntimeProvider } from "../../runtime/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

const actualScopeModule = await import("../../permissions/scope.js");
mock.module("../../permissions/scope.js", () => ({
  ...actualScopeModule,
  getScopeContext: () => undefined,
  isScopeEnforced: () => false,
  canAccessSession: () => true,
  canAccessResource: () => true,
  canModifySession: () => true,
  filterAccessibleSessions: <T>(_: unknown, sessions: T[]) => sessions,
}));

const { SessionCommands } = await import("./sessions.js");

const SESSION_KEY = "agent:main:update-failure";
const SESSION_NAME = "update-failure";

let stateDir: string | null = null;
/** Runs inside the probe, after the update committed and before the rollback. */
let duringProbe: (() => void) | null = null;
/** A second connection that holds the write lock while a restore is attempted. */
let lockHolder: Database | null = null;

/** A provider whose probe turn fails, so every test below goes through the real rollback path. */
function failingProbeProvider(): SessionRuntimeProvider {
  return {
    id: "claude",
    getCapabilities: () => {
      throw new Error("not used by the probe");
    },
    startSession: () => {
      duringProbe?.();
      return {
        provider: "claude",
        events: (async function* () {
          yield { type: "turn.failed", error: "model not found: sonnet-9" } as unknown as RuntimeEvent;
        })(),
        interrupt: async () => {},
      };
    },
  };
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sessions-update-failure-");
  registerRuntimeProvider("claude", failingProbeProvider);
  duringProbe = null;
  getOrCreateSession(SESSION_KEY, "main", "/tmp/main", { name: SESSION_NAME });
  updateSessionRuntimeProviderOverride(SESSION_KEY, "claude");
  updateSessionModelOverride(SESSION_KEY, "haiku");
  updateSessionEffortOverride(SESSION_KEY, "high");
});

afterEach(async () => {
  registerRuntimeProvider("claude", createClaudeRuntimeProvider);
  lockHolder?.exec("ROLLBACK");
  lockHolder?.close();
  lockHolder = null;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

afterAll(() => mock.restore());

/** Run `sessions update --json --model sonnet --effort low` and return the failure envelope. */
async function runFailingUpdate(): Promise<{
  thrown: unknown;
  error: Record<string, unknown> & { runtimeUpdate?: Record<string, unknown> };
}> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  let thrown: unknown;
  try {
    await new SessionCommands().update(SESSION_NAME, undefined, "sonnet", "low", undefined, undefined, undefined, true);
  } catch (error) {
    thrown = error;
  } finally {
    console.log = originalLog;
  }
  const stdout = lines.join("\n");
  const start = Math.max(stdout.lastIndexOf('{\n  "success"'), stdout.lastIndexOf('{"success"'));
  expect(start).toBeGreaterThanOrEqual(0);
  const envelope = JSON.parse(stdout.slice(start)) as { success: boolean; error: Record<string, unknown> };
  expect(envelope.success).toBe(false);
  return { thrown, error: envelope.error as never };
}

/**
 * Makes the conditional restore throw like a storage failure, whether or not its
 * WHERE would have matched: another connection holds the write lock and the
 * wait is zero, so the UPDATE fails with "database is locked" before it can
 * check ownership. Reads keep working (WAL), as they do after a real lock error.
 */
function breakRestore(): void {
  getDb().exec("PRAGMA busy_timeout = 0");
  lockHolder = openStateDatabase(getRaviDbPath());
  lockHolder.exec("BEGIN IMMEDIATE");
}

const BEFORE = {
  runtimeProviderOverride: "claude",
  modelOverride: "haiku",
  effortOverride: "high",
  thinkingLevel: null,
};

describe("sessions update RUNTIME_PROBE_FAILED envelope", () => {
  it("restores the previous configuration and reports it in the envelope", async () => {
    const { thrown, error } = await runFailingUpdate();

    expect(thrown).toMatchObject({ name: "ContractError", code: "RUNTIME_PROBE_FAILED" });
    expect(error.code).toBe("RUNTIME_PROBE_FAILED");
    expect(error.runtimeUpdate).toEqual({
      rolledBack: true,
      superseded: false,
      storedStateKnown: true,
      before: BEFORE,
      stored: BEFORE,
    });
    expect(String(error.suggestedAction)).toContain("Pick a model/provider this installation can run");
    expect(resolveSession(SESSION_KEY)).toMatchObject({ modelOverride: "haiku", effortOverride: "high" });
  });

  it("carries the previous values and a probe-free restore command when the restore fails and the update is still stored", async () => {
    duringProbe = breakRestore;

    const { error } = await runFailingUpdate();

    expect(error.runtimeUpdate).toMatchObject({
      rolledBack: false,
      superseded: false,
      storedStateKnown: true,
      before: BEFORE,
      stored: {
        runtimeProviderOverride: "claude",
        modelOverride: "sonnet",
        effortOverride: "low",
        thinkingLevel: null,
      },
    });
    expect(String(error.runtimeUpdate?.rollbackError)).toContain("database is locked");
    // The message keeps the probe's failure next to the restore's.
    expect(String(error.message)).toContain("model not found: sonnet-9");
    expect(String(error.message)).toContain("STILL persisted");
    // Recovery is self-contained and does not probe again.
    expect(String(error.suggestedAction)).toContain(
      `ravi sessions update ${SESSION_NAME} --model haiku --effort high --skip-probe`,
    );
    expect(String(error.suggestedAction)).toContain(`ravi sessions info ${SESSION_NAME} --json`);
    expect(String(error.suggestedAction)).not.toContain("sessions show");
    // Check before restoring: a newer update may have landed since the report.
    expect(String(error.suggestedAction)).toMatch(/^Check first: ravi sessions info update-failure --json/);
    // The unproven configuration really is what is stored.
    expect(resolveSession(SESSION_KEY)).toMatchObject({ modelOverride: "sonnet", effortOverride: "low" });
  });

  it("reports the newer update, and no restore to run, when the restore fails after a concurrent update landed", async () => {
    duringProbe = () => {
      // Update B commits while A's probe runs; then A's conditional restore throws.
      updateSessionModelOverride(SESSION_KEY, "opus");
      updateSessionEffortOverride(SESSION_KEY, "medium");
      bumpSessionRuntimeProviderConfigRevision(SESSION_KEY);
      breakRestore();
    };

    const { error } = await runFailingUpdate();

    expect(error.runtimeUpdate).toMatchObject({
      rolledBack: false,
      superseded: true,
      storedStateKnown: true,
      before: BEFORE,
      stored: {
        runtimeProviderOverride: "claude",
        modelOverride: "opus",
        effortOverride: "medium",
        thinkingLevel: null,
      },
    });
    expect(String(error.runtimeUpdate?.rollbackError)).toContain("database is locked");
    // A's obsolete values are not offered as the thing to put back over B's.
    expect(String(error.message)).toContain("a newer update owns");
    expect(String(error.suggestedAction)).toContain("Nothing to restore");
    expect(String(error.suggestedAction)).not.toContain("--skip-probe");
    expect(resolveSession(SESSION_KEY)).toMatchObject({ modelOverride: "opus", effortOverride: "medium" });
  });

  it("says nothing is left to restore when the restore threw after committing the previous values", async () => {
    duringProbe = () => {
      // The restore's UPDATE committed (previous values stored, revision up) and
      // the call still failed: reproduced by writing that state, then locking.
      updateSessionModelOverride(SESSION_KEY, "haiku");
      updateSessionEffortOverride(SESSION_KEY, "high");
      bumpSessionRuntimeProviderConfigRevision(SESSION_KEY);
      breakRestore();
    };

    const { error } = await runFailingUpdate();

    expect(error.runtimeUpdate).toMatchObject({
      rolledBack: false,
      superseded: false,
      storedStateKnown: true,
      before: BEFORE,
      stored: BEFORE,
    });
    // Not "a newer update owns it": the stored values are the previous ones.
    expect(String(error.message)).not.toContain("a newer update owns");
    expect(String(error.message)).toContain("already equals the previous runtime config");
    expect(String(error.suggestedAction)).toContain("Nothing to restore");
    expect(String(error.suggestedAction)).not.toContain("--skip-probe");
    expect(resolveSession(SESSION_KEY)).toMatchObject({ modelOverride: "haiku", effortOverride: "high" });
  });

  it("builds no restore command from a legacy id outside the accepted format, and keeps the flags", async () => {
    updateSessionModelOverride(SESSION_KEY, "claude-sonnet[1m]");
    duringProbe = breakRestore;

    const { error } = await runFailingUpdate();

    // The snapshot is reported as null; the flags still reach the envelope.
    expect(error.runtimeUpdate).toMatchObject({
      rolledBack: false,
      superseded: false,
      storedStateKnown: true,
      before: null,
    });
    expect(String(error.runtimeUpdate?.rollbackError)).toContain("database is locked");
    expect(String(error.suggestedAction)).toMatch(/^Check first: ravi sessions info update-failure --json/);
    expect(String(error.suggestedAction)).toContain("cannot be written as a command");
    expect(String(error.suggestedAction)).not.toContain("--skip-probe");
    expect(String(error.suggestedAction)).not.toContain("[1m]");
    expect(JSON.stringify(error)).not.toContain("[1m]");
  });

  it("tells the operator to inspect first when the restore fails and the stored configuration cannot be read", async () => {
    duringProbe = () => {
      // The sessions table is gone from under both the restore and the read-back.
      getDb().exec("ALTER TABLE sessions RENAME TO sessions_gone");
    };

    const { error } = await runFailingUpdate();

    expect(error.runtimeUpdate).toMatchObject({
      rolledBack: false,
      superseded: null,
      storedStateKnown: false,
      before: BEFORE,
      stored: null,
    });
    expect(String(error.runtimeUpdate?.rollbackError).length).toBeGreaterThan(0);
    expect(String(error.message)).toContain("unknown whether the unproven configuration or a newer update is stored");
    // Inspect before restoring; the restore command is conditional, not the first instruction.
    expect(String(error.suggestedAction)).toMatch(/^Inspect first: ravi sessions info update-failure --json/);
    expect(String(error.suggestedAction)).toContain("--skip-probe");
  });
});
