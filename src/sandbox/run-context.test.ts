// Sandbox run authority and the served-jti queue (OSS `.ravi/specs/sandbox/listener`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dbCreateAgent, dbGetContext, dbUpdateAgent, getDb } from "../router/router-db.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { sha256Base64url } from "../sandbox-listener/gate-assertion.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { TEST_GRANT_JTI, TEST_INSTALLATION_A, TEST_RUN_ID } from "../test/sandbox-grant-tokens.js";
import {
  createSandboxRunAuthority,
  getLiveSandboxRun,
  getLiveSandboxRunContext,
  pruneSandboxRunsAtStart,
  revokeSandboxRun,
  SANDBOX_RUN_CONTEXT_KIND,
  SANDBOX_RUN_ROOT_CONTEXT_KIND,
  SandboxRunAuthorityError,
} from "./run-context.js";
import {
  acknowledgeServedJtis,
  dbAppendServedJti,
  dbClearServedJtiOverflow,
  dbCountUnacknowledgedServedJtis,
  dbGetSandboxRun,
  dbGetServedJtiOverflowAt,
  dbListRecentServedJtis,
  dbListUnacknowledgedServedJtis,
  dbPruneAcknowledgedServedJtis,
  dbRevokeSandboxRun,
  ensureSandboxSchema,
  SANDBOX_SERVED_JTI_QUEUE_MAX,
} from "./runs-db.js";

const AGENT = "sandbox-worker";
const TASK = "task-1";
const OTHER_RUN_ID = "sbr_zzzzzzzzzzzzzzzzzzzzzzzzzz";
const GRANT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";

let stateDir: string | null = null;

function createAgent(id: string, capabilities: string[]) {
  dbCreateAgent({ id, cwd: `/tmp/${id}` });
  dbUpdateAgent(id, { defaults: { runtimePermissions: { profile: "explicit-only", capabilities } } });
}

const authorityInput = (overrides: Partial<Parameters<typeof createSandboxRunAuthority>[0]> = {}) => ({
  runId: TEST_RUN_ID,
  jti: TEST_GRANT_JTI,
  agentId: AGENT,
  homeTaskId: TASK,
  caps: [`mutate:task:${TASK}`, `read:task:${TASK}`],
  cmds: ["tasks.done", "tasks.report", "tasks.show"],
  grant: GRANT,
  org: "org_123",
  installationId: TEST_INSTALLATION_A,
  expiresAt: Date.now() + 600_000,
  ...overrides,
});

describe("createSandboxRunAuthority", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-sandbox-run-context-");
    createAgent(AGENT, [`mutate:task:${TASK}`, `read:task:${TASK}`]);
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  test("issues a root snapshot and a child holding exactly the grant caps the agent has", () => {
    const expiresAt = Date.now() + 600_000;
    const { run, root, child, droppedCaps } = createSandboxRunAuthority(authorityInput({ expiresAt }));
    expect(root.kind).toBe(SANDBOX_RUN_ROOT_CONTEXT_KIND);
    expect(child.kind).toBe(SANDBOX_RUN_CONTEXT_KIND);
    expect(root.agentId).toBe(AGENT);
    expect(child.agentId).toBe(AGENT);
    expect(child.agentId?.length).toBeGreaterThan(0);
    expect(child.metadata?.parentContextId).toBe(root.contextId);
    expect(child.capabilities.map((cap) => `${cap.permission}:${cap.objectType}:${cap.objectId}`)).toEqual([
      `mutate:task:${TASK}`,
      `read:task:${TASK}`,
    ]);
    expect(droppedCaps).toEqual([]);
    // The child never outlives the grant.
    expect(child.expiresAt).toBeLessThanOrEqual(expiresAt);
    expect(root.expiresAt).toBe(expiresAt);
    expect(run).toMatchObject({
      runId: TEST_RUN_ID,
      jti: TEST_GRANT_JTI,
      agentId: AGENT,
      homeTaskId: TASK,
      grantJws: GRANT,
      grantSha256: sha256Base64url(GRANT),
      rootContextId: root.contextId,
      contextId: child.contextId,
      expiresAt,
      revokedAt: null,
      requestCount: 0,
    });
    expect(getLiveSandboxRun(TEST_RUN_ID)?.runId).toBe(TEST_RUN_ID);
    expect(getLiveSandboxRunContext(run)?.contextId).toBe(child.contextId);
  });

  test("never returns a context key: root and child come back without `contextKey`", () => {
    const authority = createSandboxRunAuthority(authorityInput());
    expect("contextKey" in authority.root).toBe(false);
    expect("contextKey" in authority.child).toBe(false);
    expect(JSON.stringify(authority)).not.toContain("rctx_");
    // The listener still loads the child, by id.
    expect(getLiveSandboxRunContext(authority.run)?.contextId).toBe(authority.child.contextId);
  });

  test("drops and records grant caps the agent lacks locally or outside the milestone-1 grammar", () => {
    createAgent("narrow", [`mutate:task:${TASK}`]);
    const { child, droppedCaps } = createSandboxRunAuthority(
      authorityInput({
        agentId: "narrow",
        caps: [
          "admin:system:*",
          `mutate:task:${TASK}`,
          `read:task:${TASK}`,
          "mutate:task:other",
          "execute:group:tasks",
        ],
      }),
    );
    expect(child.capabilities.map((cap) => `${cap.permission}:${cap.objectType}:${cap.objectId}`)).toEqual([
      `mutate:task:${TASK}`,
    ]);
    expect(droppedCaps).toEqual(["admin:system:*", "execute:group:tasks", "mutate:task:other", `read:task:${TASK}`]);
    expect(child.metadata?.droppedCaps).toEqual(droppedCaps);
  });

  test("refuses an unknown agent, a superadmin agent and a duplicate run", () => {
    const codeOf = (input: Parameters<typeof createSandboxRunAuthority>[0]) => {
      try {
        createSandboxRunAuthority(input);
        return "ok";
      } catch (error) {
        return error instanceof SandboxRunAuthorityError ? error.code : String(error);
      }
    };
    expect(codeOf(authorityInput({ agentId: "nobody" }))).toBe("agent_unknown");
    createAgent("root-like", ["admin:system:*"]);
    expect(codeOf(authorityInput({ agentId: "root-like" }))).toBe("agent_superadmin");
    expect(codeOf(authorityInput({ agentId: "operator" }))).toBe("agent_invalid");
    expect(codeOf(authorityInput({ runId: "sbr_short" }))).toBe("run_id_invalid");
    expect(codeOf(authorityInput({ cmds: ["agents.permissions"] }))).toBe("cmds_invalid");
    expect(codeOf(authorityInput({ expiresAt: Date.now() - 1 }))).toBe("expires_invalid");
    expect(codeOf(authorityInput())).toBe("ok");
    expect(codeOf(authorityInput())).toBe("run_exists");
    // A refused authority leaves no live context behind.
    expect(dbGetContext(dbGetSandboxRun(TEST_RUN_ID)!.rootContextId)?.revokedAt).toBeUndefined();
  });

  test("revokeSandboxRun cascades to the child and blanks the stored grant", () => {
    const { run, root, child } = createSandboxRunAuthority(authorityInput());
    const result = revokeSandboxRun(run.runId, "test_revoke");
    expect(result?.revokedContextIds.sort()).toEqual([root.contextId, child.contextId].sort());
    expect(dbGetContext(root.contextId)?.revokedAt).toBeNumber();
    expect(dbGetContext(child.contextId)?.revokedAt).toBeNumber();
    expect(result?.run.revokedAt).toBeNumber();
    expect(result?.run.grantJws).toBeNull();
    expect(result?.run.grantSha256).toBe(sha256Base64url(GRANT));
    expect(getLiveSandboxRun(run.runId)).toBeNull();
    expect(getLiveSandboxRunContext(run)).toBeNull();
    // Idempotent, and unknown runs are null.
    expect(revokeSandboxRun(run.runId)?.revokedContextIds).toEqual([]);
    expect(revokeSandboxRun(OTHER_RUN_ID)).toBeNull();
  });

  test("the child context is live only while bound to the run's root and agent", () => {
    const { run } = createSandboxRunAuthority(authorityInput());
    const stranger = createRuntimeContext({ kind: SANDBOX_RUN_CONTEXT_KIND, agentId: AGENT, capabilities: [] });
    expect(getLiveSandboxRunContext({ ...run, contextId: stranger.contextId })).toBeNull();
    expect(getLiveSandboxRunContext({ ...run, agentId: "other" })).toBeNull();
    expect(getLiveSandboxRun(run.runId, run.expiresAt)).toBeNull();
  });

  test("pruneSandboxRunsAtStart deletes expired and revoked runs but never pending served jtis", () => {
    const expired = createSandboxRunAuthority(authorityInput({ expiresAt: Date.now() + 1000 }));
    const live = createSandboxRunAuthority(
      authorityInput({ runId: OTHER_RUN_ID, jti: "11111111-2222-4333-8444-555555555555" }),
    );
    dbAppendServedJti({
      jti: "aaaaaaaa-0000-4000-8000-000000000001",
      runId: expired.run.runId,
      status: 200,
      servedAt: 1,
    });
    const result = pruneSandboxRunsAtStart(Date.now() + 2000);
    expect(result.runsDeleted).toBe(1);
    expect(dbGetSandboxRun(expired.run.runId)).toBeNull();
    expect(dbGetContext(expired.root.contextId)?.revokedAt).toBeNumber();
    expect(dbGetContext(expired.child.contextId)?.revokedAt).toBeNumber();
    expect(dbGetSandboxRun(live.run.runId)).not.toBeNull();
    expect(dbCountUnacknowledgedServedJtis()).toBe(1);
  });

  test("revoking zeroes the blanked grant on disk: the runs connection runs with secure_delete", () => {
    // A grant-sized secret; any long run of its filler is a leftover of it.
    const filler = "S".repeat(600);
    const secret = `eyJhbGciOiJFUzI1NiJ9.${filler}.c2ln`;
    const leftover = filler.slice(0, 64);
    createSandboxRunAuthority(authorityInput({ grant: secret }));
    const db = ensureSandboxSchema();
    expect((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete).toBe(1);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(readFileSync(db.filename).includes(leftover)).toBe(true);

    dbRevokeSandboxRun(TEST_RUN_ID, "test_revoke");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(dbGetSandboxRun(TEST_RUN_ID)?.grantJws).toBeNull();
    // Without secure_delete the freed cell keeps most of the grant bytes in the page's free space.
    expect(readFileSync(db.filename).includes(leftover)).toBe(false);
  });
});

describe("served-jti queue", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-sandbox-served-jtis-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const jti = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

  test("appends oldest first, keeps a refused replay's first row, acknowledges and prunes", () => {
    expect(dbAppendServedJti({ jti: jti(2), runId: TEST_RUN_ID, status: 200, servedAt: 2000 })).toEqual({
      overflow: false,
    });
    dbAppendServedJti({ jti: jti(1), runId: null, status: 401, servedAt: 1000 });
    dbAppendServedJti({ jti: jti(2), runId: TEST_RUN_ID, status: 401, servedAt: 3000 });
    expect(dbListUnacknowledgedServedJtis().map((row) => [row.jti, row.status, row.servedAt])).toEqual([
      [jti(1), 401, 1000],
      [jti(2), 200, 2000],
    ]);
    expect(dbListUnacknowledgedServedJtis(1).map((row) => row.jti)).toEqual([jti(1)]);
    expect(dbListRecentServedJtis(2500, 1000).map((row) => row.jti)).toEqual([jti(2)]);

    expect(acknowledgeServedJtis([jti(1), "not-served"], 5000)).toBe(1);
    expect(dbCountUnacknowledgedServedJtis()).toBe(1);
    expect(acknowledgeServedJtis([jti(1)], 6000)).toBe(0);
    expect(dbPruneAcknowledgedServedJtis(5001)).toBe(1);
    expect(dbPruneAcknowledgedServedJtis(5001)).toBe(0);
    expect(dbListUnacknowledgedServedJtis().map((row) => row.jti)).toEqual([jti(2)]);
  });

  test("records the verified assertion exp, null when no assertion verified", () => {
    dbAppendServedJti({ jti: jti(1), runId: TEST_RUN_ID, status: 200, servedAt: 1000, assertionExp: 61 });
    dbAppendServedJti({ jti: jti(2), runId: null, status: 401, servedAt: 2000 });
    expect(dbListUnacknowledgedServedJtis().map((row) => [row.jti, row.assertionExp])).toEqual([
      [jti(1), 61],
      [jti(2), null],
    ]);
  });

  test("an older ravi.db without assertion_exp is migrated and its rows read back as null", async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = await createIsolatedRaviState("ravi-sandbox-served-jtis-legacy-");
    // The first 04b shape, written before the sandbox module ever opened this database.
    getDb().exec(`
      CREATE TABLE sandbox_served_jtis (
        jti TEXT PRIMARY KEY, run_id TEXT, status INTEGER NOT NULL, served_at INTEGER NOT NULL, acknowledged_at INTEGER
      );
      INSERT INTO sandbox_served_jtis (jti, run_id, status, served_at) VALUES ('${jti(9)}', NULL, 200, 5000);
    `);
    expect(dbListUnacknowledgedServedJtis().map((row) => [row.jti, row.assertionExp])).toEqual([[jti(9), null]]);
    const columns = (getDb().prepare("PRAGMA table_info(sandbox_served_jtis)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).toContain("assertion_exp");
    dbAppendServedJti({ jti: jti(10), runId: null, status: 200, servedAt: 6000, assertionExp: 66 });
    expect(dbListUnacknowledgedServedJtis().map((row) => row.assertionExp)).toEqual([null, 66]);
  });

  test("drops the oldest beyond the cap and records the overflow", () => {
    for (let n = 1; n <= SANDBOX_SERVED_JTI_QUEUE_MAX; n += 1) {
      dbAppendServedJti({ jti: jti(n), runId: null, status: 200, servedAt: n });
    }
    expect(dbGetServedJtiOverflowAt()).toBeNull();
    expect(
      dbAppendServedJti({ jti: jti(SANDBOX_SERVED_JTI_QUEUE_MAX + 1), runId: null, status: 200, servedAt: 9_999 }),
    ).toEqual({ overflow: true });
    expect(dbCountUnacknowledgedServedJtis()).toBe(SANDBOX_SERVED_JTI_QUEUE_MAX);
    expect(dbListUnacknowledgedServedJtis(1)[0]?.jti).toBe(jti(2));
    expect(dbGetServedJtiOverflowAt()).toBe(9_999);
    dbClearServedJtiOverflow();
    expect(dbGetServedJtiOverflowAt()).toBeNull();
  });
});
