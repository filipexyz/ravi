import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { file, sleep, spawn, write } from "bun";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { closeRouterDb, getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  acquireRuntimeRecoveryClaim,
  CrashRecoveryLedgerConflictError,
  CrashRecoveryLedgerCorruptionError,
  compareAndSetRuntimePromptQueueStatus,
  completeRuntimeRecoveryClaim,
  completeRuntimeRecoveryRun,
  createRuntimeBootEpoch,
  createRuntimeRecoveryRun,
  createRuntimeTurnAttempt,
  enqueueRuntimePrompt,
  getRuntimeBootEpoch,
  getRuntimePromptQueueItem,
  getRuntimeRecoveryCandidate,
  getRuntimeRecoveryClaimByCandidate,
  getRuntimeRecoveryRun,
  getRuntimeTurnAttempt,
  heartbeatRuntimeBootEpoch,
  heartbeatRuntimeTurnAttempt,
  listRuntimePromptQueue,
  listRuntimeRecoveryCandidates,
  listRuntimeTurnAttempts,
  markRuntimeBootEpochAbandoned,
  markRuntimeBootEpochGracefulStopped,
  markRuntimeTurnAttemptSafety,
  recordRuntimeRecoveryCandidate,
  terminalizeRuntimeTurnAttempt,
} from "./crash-recovery-store.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-crash-recovery-store-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function createBoot(bootEpoch = "boot-a", startedAt = 100) {
  return createRuntimeBootEpoch({
    bootEpoch,
    instanceId: "local",
    pid: 1234,
    startedAt,
    lastHeartbeatAt: startedAt,
    leaseExpiresAt: startedAt + 10_000,
    metadata: { host: "test" },
  });
}

function createAttempt(input: {
  attemptId: string;
  turnId?: string;
  bootEpoch?: string;
  recoveredFromAttemptId?: string;
  startedAt?: number;
  sessionKey?: string;
}) {
  const startedAt = input.startedAt ?? 200;
  return createRuntimeTurnAttempt({
    attemptId: input.attemptId,
    turnId: input.turnId ?? "turn-a",
    recoveredFromAttemptId: input.recoveredFromAttemptId,
    runId: "run-a",
    sessionKey: input.sessionKey ?? "agent:dev:main",
    sessionName: "main",
    agentId: "dev",
    provider: "codex",
    model: "gpt-test",
    bootEpoch: input.bootEpoch ?? "boot-a",
    startedAt,
    lastHeartbeatAt: startedAt,
    leaseExpiresAt: startedAt + 1_000,
    requestBlobSha256: "request-sha",
    userPromptSha256: "user-sha",
    systemPromptSha256: "system-sha",
    checkpoint: { providerSessionId: "provider-session-a" },
    originKind: "human",
    source: { channel: "slack", chatId: "chat-a" },
    turnProvenance: { origin: "human", reason: "test" },
    taskBarrierTaskId: "task-a",
    deliveryBarrier: "after_response",
    pendingIds: ["pending-a"],
    metadata: { fixture: true },
  });
}

function enqueuePrompt(input: {
  dedupeKey: string;
  queueItemId?: string;
  queuedAt?: number;
  prompt?: Record<string, unknown>;
}) {
  return enqueueRuntimePrompt({
    queueItemId: input.queueItemId,
    dedupeKey: input.dedupeKey,
    sessionKey: "agent:dev:main",
    sessionName: "main",
    agentId: "dev",
    laneKey: "after_response",
    bootEpoch: "boot-a",
    originKind: "human",
    deliveryBarrier: "after_response",
    taskBarrierTaskId: "task-a",
    pendingId: `pending:${input.dedupeKey}`,
    prompt: input.prompt ?? { message: "hello", nested: { a: 1, b: 2 } },
    runtimeMessage: { content: "hello", role: "user" },
    queuedAt: input.queuedAt ?? 300,
    metadata: { source: "test" },
  });
}

function createStartingQueue(input: { queueItemId: string; startingAt: number; leaseExpiresAt?: number }) {
  const leaseOwner = `lease:${input.queueItemId}`;
  const leaseExpiresAt = input.leaseExpiresAt ?? 2_000;
  enqueuePrompt({ dedupeKey: input.queueItemId, queueItemId: input.queueItemId, queuedAt: 500 });
  compareAndSetRuntimePromptQueueStatus({
    queueItemId: input.queueItemId,
    expectedStatus: "queued",
    status: "leased",
    bootEpoch: "boot-a",
    leaseOwner,
    leaseExpiresAt,
    updatedAt: 600,
  });
  compareAndSetRuntimePromptQueueStatus({
    queueItemId: input.queueItemId,
    expectedStatus: "leased",
    expectedBootEpoch: "boot-a",
    expectedLeaseOwner: leaseOwner,
    expectedLeaseExpiresAt: leaseExpiresAt,
    status: "starting",
    updatedAt: input.startingAt,
  });
  return { leaseOwner, leaseExpiresAt };
}

async function acquireClaimInChildProcess(input: {
  recoveryRunId: string;
  candidateKey: string;
  claimedByBootEpoch: string;
  claimId: string;
  claimedAt: number;
  readyPath: string;
  releasePath: string;
}) {
  const storeModuleUrl = pathToFileURL(join(import.meta.dir, "crash-recovery-store.ts")).href;
  const workerScript = `
    import { acquireRuntimeRecoveryClaim } from ${JSON.stringify(storeModuleUrl)};
    const [, recoveryRunId, candidateKey, claimedByBootEpoch, claimId, claimedAt, readyPath, releasePath] = Bun.argv;
    try {
      await Bun.write(readyPath, "ready");
      while (!(await Bun.file(releasePath).exists())) {
        await Bun.sleep(5);
      }
      const result = acquireRuntimeRecoveryClaim({
        recoveryRunId,
        candidateKey,
        claimedByBootEpoch,
        claimId,
        claimedAt: Number(claimedAt),
      });
      console.log("CLAIM_RESULT=" + JSON.stringify(result));
    } catch (error) {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    }
  `;
  const child = spawn(
    [
      "bun",
      "-e",
      workerScript,
      input.recoveryRunId,
      input.candidateKey,
      input.claimedByBootEpoch,
      input.claimId,
      String(input.claimedAt),
      input.readyPath,
      input.releasePath,
    ],
    {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        RAVI_STATE_DIR: stateDir!,
        RAVI_LOG_LEVEL: "error",
        RAVI_SUPPRESS_AUDIT_EVENTS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Claim child failed (${exitCode}): ${stderr || stdout}`);
  const resultLine = stdout.split("\n").find((line) => line.startsWith("CLAIM_RESULT="));
  if (!resultLine) throw new Error(`Claim child returned no result: ${stdout}`);
  return JSON.parse(resultLine.slice("CLAIM_RESULT=".length)) as {
    status: "acquired" | "existing";
    claim: { claimId: string };
  };
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await file(path).exists()) return;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for child readiness file: ${path}`);
}

describe("crash recovery ledger", () => {
  it("creates and reopens the complete schema with foreign keys and indexes", () => {
    const baselineDb = new Database(join(stateDir!, "ravi.db"));
    baselineDb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    baselineDb.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run("baseline", "kept", 1);
    baselineDb.close();

    const db = getDb();
    expect(db.prepare("SELECT value FROM settings WHERE key = ?").get("baseline")).toEqual({ value: "kept" });
    const tableRows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'runtime_boot_epochs',
           'runtime_turn_attempts',
           'runtime_prompt_queue',
           'runtime_recovery_runs',
           'runtime_recovery_candidates',
           'runtime_recovery_claims'
         ) ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tableRows.map((row) => row.name)).toEqual([
      "runtime_boot_epochs",
      "runtime_prompt_queue",
      "runtime_recovery_candidates",
      "runtime_recovery_claims",
      "runtime_recovery_runs",
      "runtime_turn_attempts",
    ]);

    const queueIndexes = db.prepare("PRAGMA index_list(runtime_prompt_queue)").all() as Array<{ name: string }>;
    expect(queueIndexes.map((row) => row.name)).toContain("idx_runtime_prompt_queue_session_lane");
    expect(queueIndexes.map((row) => row.name)).toContain("idx_runtime_prompt_queue_lease");

    const claimForeignKeys = db.prepare("PRAGMA foreign_key_list(runtime_recovery_claims)").all() as Array<{
      table: string;
    }>;
    expect(claimForeignKeys.map((row) => row.table)).toContain("runtime_recovery_candidates");
    expect(claimForeignKeys.map((row) => row.table)).toContain("runtime_boot_epochs");

    createBoot();
    const first = enqueuePrompt({ dedupeKey: "dedupe-a", queuedAt: 500 }).item;
    closeRouterDb();
    const second = enqueuePrompt({ dedupeKey: "dedupe-b", queuedAt: 500 }).item;
    expect(second.queueSequence).toBeGreaterThan(first.queueSequence);
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps boot heartbeat, lease, and terminal state monotonic", () => {
    const created = createBoot();
    const duplicate = createBoot();
    expect(duplicate).toEqual(created);

    const heartbeat = heartbeatRuntimeBootEpoch({
      bootEpoch: "boot-a",
      heartbeatAt: 150,
      leaseExpiresAt: 11_500,
    });
    expect(heartbeat.lastHeartbeatAt).toBe(150);
    expect(heartbeat.leaseExpiresAt).toBe(11_500);
    expect(() => heartbeatRuntimeBootEpoch({ bootEpoch: "boot-a", heartbeatAt: 149, leaseExpiresAt: 11_500 })).toThrow(
      CrashRecoveryLedgerConflictError,
    );
    expect(() => heartbeatRuntimeBootEpoch({ bootEpoch: "boot-a", heartbeatAt: 160, leaseExpiresAt: 11_499 })).toThrow(
      CrashRecoveryLedgerConflictError,
    );

    const stopped = markRuntimeBootEpochGracefulStopped({
      bootEpoch: "boot-a",
      stoppedAt: 2_000,
      reason: "operator restart",
    });
    expect(stopped.status).toBe("graceful_stopped");
    expect(markRuntimeBootEpochGracefulStopped({ bootEpoch: "boot-a", stoppedAt: 2_000 })).toEqual(stopped);
    expect(() => markRuntimeBootEpochGracefulStopped({ bootEpoch: "boot-a", stoppedAt: 2_100 })).toThrow(
      CrashRecoveryLedgerConflictError,
    );
    expect(() =>
      markRuntimeBootEpochAbandoned({
        bootEpoch: "boot-a",
        abandonedAt: 11_500,
        expectedLastHeartbeatAt: 150,
        expectedLeaseExpiresAt: 11_500,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() => heartbeatRuntimeBootEpoch({ bootEpoch: "boot-a", heartbeatAt: 2_100, leaseExpiresAt: 3_100 })).toThrow(
      CrashRecoveryLedgerConflictError,
    );
    expect(() => createAttempt({ attemptId: "attempt-after-stop" })).toThrow(CrashRecoveryLedgerConflictError);
  });

  it("abandons a boot only after the exact observed lease expires", () => {
    createBoot();
    expect(() =>
      markRuntimeBootEpochAbandoned({
        bootEpoch: "boot-a",
        abandonedAt: 10_099,
        expectedLastHeartbeatAt: 100,
        expectedLeaseExpiresAt: 10_100,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    heartbeatRuntimeBootEpoch({ bootEpoch: "boot-a", heartbeatAt: 200, leaseExpiresAt: 10_200 });
    expect(() =>
      markRuntimeBootEpochAbandoned({
        bootEpoch: "boot-a",
        abandonedAt: 10_200,
        expectedLastHeartbeatAt: 100,
        expectedLeaseExpiresAt: 10_100,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    expect(
      markRuntimeBootEpochAbandoned({
        bootEpoch: "boot-a",
        abandonedAt: 10_200,
        expectedLastHeartbeatAt: 200,
        expectedLeaseExpiresAt: 10_200,
      }).status,
    ).toBe("abandoned");
  });

  it("tracks independent attempts for one turn with irreversible safety and terminal state", () => {
    createBoot();
    const first = createAttempt({ attemptId: "attempt-1" });
    expect(first.checkpoint).toEqual({ providerSessionId: "provider-session-a" });
    expect(first.pendingIds).toEqual(["pending-a"]);

    const heartbeat = heartbeatRuntimeTurnAttempt({
      attemptId: "attempt-1",
      bootEpoch: "boot-a",
      heartbeatAt: 250,
      leaseExpiresAt: 1_500,
    });
    expect(heartbeat.lastHeartbeatAt).toBe(250);
    expect(() =>
      heartbeatRuntimeTurnAttempt({
        attemptId: "attempt-1",
        bootEpoch: "boot-a",
        heartbeatAt: 249,
        leaseExpiresAt: 1_500,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    const toolStarted = markRuntimeTurnAttemptSafety({ attemptId: "attempt-1", startedTool: true, markedAt: 260 });
    expect(toolStarted.startedTool).toBe(true);
    expect(toolStarted.materializedOutput).toBe(false);
    const output = markRuntimeTurnAttemptSafety({
      attemptId: "attempt-1",
      materializedOutput: true,
      markedAt: 270,
    });
    expect(output.startedTool).toBe(true);
    expect(output.materializedOutput).toBe(true);
    expect(() =>
      heartbeatRuntimeTurnAttempt({
        attemptId: "attempt-1",
        bootEpoch: "boot-a",
        heartbeatAt: 265,
        leaseExpiresAt: 1_600,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() =>
      terminalizeRuntimeTurnAttempt({ attemptId: "attempt-1", status: "interrupted", completedAt: 269 }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    const interrupted = terminalizeRuntimeTurnAttempt({
      attemptId: "attempt-1",
      status: "interrupted",
      completedAt: 300,
    });
    expect(interrupted.status).toBe("interrupted");
    expect(terminalizeRuntimeTurnAttempt({ attemptId: "attempt-1", status: "interrupted", completedAt: 300 })).toEqual(
      interrupted,
    );
    expect(() =>
      terminalizeRuntimeTurnAttempt({ attemptId: "attempt-1", status: "interrupted", completedAt: 350 }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() =>
      terminalizeRuntimeTurnAttempt({ attemptId: "attempt-1", status: "complete", completedAt: 350 }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() => markRuntimeTurnAttemptSafety({ attemptId: "attempt-1", startedTool: true })).toThrow(
      CrashRecoveryLedgerConflictError,
    );
    expect(() =>
      heartbeatRuntimeTurnAttempt({
        attemptId: "attempt-1",
        bootEpoch: "boot-a",
        heartbeatAt: 350,
        leaseExpiresAt: 1_600,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    const second = createAttempt({
      attemptId: "attempt-2",
      recoveredFromAttemptId: "attempt-1",
      startedAt: 400,
    });
    expect(second.turnId).toBe(first.turnId);
    expect(second.recoveredFromAttemptId).toBe("attempt-1");
    expect(listRuntimeTurnAttempts({ turnId: "turn-a" }).map((attempt) => attempt.attemptId)).toEqual([
      "attempt-2",
      "attempt-1",
    ]);
  });

  it("deduplicates immutable prompt atoms and preserves FIFO with equal timestamps", () => {
    createBoot();
    const first = enqueuePrompt({ dedupeKey: "dedupe-a", queueItemId: "queue-a", queuedAt: 500 });
    const retry = enqueueRuntimePrompt({
      dedupeKey: "dedupe-a",
      sessionKey: "agent:dev:main",
      sessionName: "main",
      agentId: "dev",
      laneKey: "after_response",
      bootEpoch: "boot-a",
      originKind: "human",
      deliveryBarrier: "after_response",
      taskBarrierTaskId: "task-a",
      pendingId: "pending:dedupe-a",
      prompt: { nested: { b: 2, a: 1 }, message: "hello" },
      runtimeMessage: { role: "user", content: "hello" },
      queuedAt: 999,
      metadata: { source: "test" },
    });
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.item.queueItemId).toBe("queue-a");
    expect(retry.item.queueSequence).toBe(first.item.queueSequence);
    expect(retry.item.queuedAt).toBe(500);

    expect(() => enqueuePrompt({ dedupeKey: "dedupe-a", prompt: { message: "different" }, queuedAt: 500 })).toThrow(
      CrashRecoveryLedgerConflictError,
    );

    const second = enqueuePrompt({ dedupeKey: "dedupe-b", queueItemId: "queue-b", queuedAt: 500 }).item;
    expect(second.queueSequence).toBeGreaterThan(first.item.queueSequence);
    expect(
      listRuntimePromptQueue({ sessionKey: "agent:dev:main", laneKey: "after_response" }).map(
        (item) => item.queueItemId,
      ),
    ).toEqual(["queue-a", "queue-b"]);

    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-a",
        expectedStatus: "queued",
        status: "leased",
        bootEpoch: "boot-a",
        leaseOwner: "worker-a",
        leaseExpiresAt: 2_000,
        updatedAt: 499,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    const leased = compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-a",
      expectedStatus: "queued",
      status: "leased",
      bootEpoch: "boot-a",
      leaseOwner: "worker-a",
      leaseExpiresAt: 2_000,
      updatedAt: 600,
    });
    expect(leased.applied).toBe(true);
    expect(leased.item.status).toBe("leased");
    const stale = compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-a",
      expectedStatus: "queued",
      status: "cancelled",
      updatedAt: 610,
    });
    expect(stale.applied).toBe(false);
    expect(stale.item.status).toBe("leased");

    const staleOwner = compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-a",
      expectedStatus: "leased",
      expectedBootEpoch: "boot-a",
      expectedLeaseOwner: "worker-stale",
      expectedLeaseExpiresAt: 2_000,
      status: "starting",
      updatedAt: 610,
    });
    expect(staleOwner.applied).toBe(false);
    expect(staleOwner.item.status).toBe("leased");

    const cancelled = compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-a",
      expectedStatus: "leased",
      expectedBootEpoch: "boot-a",
      expectedLeaseOwner: "worker-a",
      expectedLeaseExpiresAt: 2_000,
      status: "cancelled",
      completedAt: 620,
      updatedAt: 620,
    });
    expect(cancelled.item.completedAt).toBe(620);
    expect(
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-a",
        expectedStatus: "cancelled",
        status: "cancelled",
        completedAt: 620,
        updatedAt: 620,
      }).applied,
    ).toBe(false);
    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-a",
        expectedStatus: "cancelled",
        status: "cancelled",
        completedAt: 621,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-a",
        expectedStatus: "cancelled",
        status: "requeued",
        updatedAt: 630,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
  });

  it("fences queue ownership and forbids delivery through another session", () => {
    createBoot();
    enqueuePrompt({ dedupeKey: "queue-session", queueItemId: "queue-session", queuedAt: 500 });
    createAttempt({ attemptId: "attempt-other-session", sessionKey: "agent:dev:other", startedAt: 550 });
    compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-session",
      expectedStatus: "queued",
      status: "leased",
      bootEpoch: "boot-a",
      leaseOwner: "lease-token-a",
      leaseExpiresAt: 2_000,
      updatedAt: 600,
    });

    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-session",
        expectedStatus: "leased",
        expectedBootEpoch: "boot-a",
        expectedLeaseOwner: "lease-token-a",
        expectedLeaseExpiresAt: 2_000,
        status: "delivered",
        deliveredAttemptId: "attempt-other-session",
        deliveredTurnId: "turn-a",
        updatedAt: 650,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    const requeued = compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-session",
      expectedStatus: "leased",
      expectedBootEpoch: "boot-a",
      expectedLeaseOwner: "lease-token-a",
      expectedLeaseExpiresAt: 2_000,
      status: "requeued",
      updatedAt: 650,
    });
    expect(requeued.item).toMatchObject({
      status: "requeued",
      bootEpoch: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("requires a live lease for first delivery and forbids delivered-item redelivery", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-delivery-1" });
    createAttempt({ attemptId: "attempt-delivery-2" });
    enqueuePrompt({ dedupeKey: "queue-delivery", queueItemId: "queue-delivery", queuedAt: 500 });

    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-delivery",
        expectedStatus: "queued",
        status: "delivered",
        deliveredAttemptId: "attempt-delivery-1",
        deliveredTurnId: "turn-a",
        updatedAt: 600,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-delivery",
      expectedStatus: "queued",
      status: "leased",
      bootEpoch: "boot-a",
      leaseOwner: "lease-token-a",
      leaseExpiresAt: 2_000,
      updatedAt: 600,
    });
    compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-delivery",
      expectedStatus: "leased",
      expectedBootEpoch: "boot-a",
      expectedLeaseOwner: "lease-token-a",
      expectedLeaseExpiresAt: 2_000,
      status: "requeued",
      updatedAt: 650,
    });
    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-delivery",
        expectedStatus: "requeued",
        status: "delivered",
        deliveredAttemptId: "attempt-delivery-1",
        deliveredTurnId: "turn-a",
        updatedAt: 700,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-delivery",
      expectedStatus: "requeued",
      status: "leased",
      bootEpoch: "boot-a",
      leaseOwner: "lease-token-b",
      leaseExpiresAt: 2_000,
      updatedAt: 700,
    });
    compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-delivery",
      expectedStatus: "leased",
      expectedBootEpoch: "boot-a",
      expectedLeaseOwner: "lease-token-b",
      expectedLeaseExpiresAt: 2_000,
      status: "starting",
      updatedAt: 750,
    });
    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-delivery",
        expectedStatus: "starting",
        expectedBootEpoch: "boot-a",
        expectedLeaseOwner: "lease-token-b",
        expectedLeaseExpiresAt: 2_000,
        status: "delivered",
        deliveredAttemptId: "attempt-delivery-1",
        deliveredTurnId: "turn-a",
        updatedAt: 2_001,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    const delivered = compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-delivery",
      expectedStatus: "starting",
      expectedBootEpoch: "boot-a",
      expectedLeaseOwner: "lease-token-b",
      expectedLeaseExpiresAt: 2_000,
      status: "delivered",
      deliveredAttemptId: "attempt-delivery-1",
      deliveredTurnId: "turn-a",
      updatedAt: 800,
    });
    expect(delivered.item).toMatchObject({
      status: "delivered",
      deliveredAttemptId: "attempt-delivery-1",
      metadata: { source: "test" },
    });

    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-delivery",
        expectedStatus: "delivered",
        expectedBootEpoch: "boot-a",
        expectedLeaseOwner: "lease-token-b",
        expectedLeaseExpiresAt: 2_000,
        status: "leased",
        bootEpoch: "boot-a",
        leaseOwner: "lease-token-b",
        leaseExpiresAt: 2_000,
        updatedAt: 810,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-delivery",
        expectedStatus: "delivered",
        expectedBootEpoch: "boot-a",
        expectedLeaseOwner: "lease-token-b",
        expectedLeaseExpiresAt: 2_000,
        status: "delivered",
        deliveredAttemptId: "attempt-delivery-2",
        deliveredTurnId: "turn-a",
        updatedAt: 820,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    terminalizeRuntimeTurnAttempt({
      attemptId: "attempt-delivery-1",
      status: "complete",
      completedAt: 900,
    });
    const completed = compareAndSetRuntimePromptQueueStatus({
      queueItemId: "queue-delivery",
      expectedStatus: "delivered",
      expectedBootEpoch: "boot-a",
      expectedLeaseOwner: "lease-token-b",
      expectedLeaseExpiresAt: 2_000,
      status: "complete",
      completedAt: 2_100,
      updatedAt: 2_100,
    });
    expect(completed.item).toMatchObject({ status: "complete", completedAt: 2_100 });
  });

  it("rejects delivery into a terminal attempt", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-delivery-terminal" });
    terminalizeRuntimeTurnAttempt({
      attemptId: "attempt-delivery-terminal",
      status: "complete",
      completedAt: 300,
    });
    const lease = createStartingQueue({ queueItemId: "queue-delivery-terminal", startingAt: 650 });

    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-delivery-terminal",
        expectedStatus: "starting",
        expectedBootEpoch: "boot-a",
        expectedLeaseOwner: lease.leaseOwner,
        expectedLeaseExpiresAt: lease.leaseExpiresAt,
        status: "delivered",
        deliveredAttemptId: "attempt-delivery-terminal",
        deliveredTurnId: "turn-a",
        updatedAt: 700,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
  });

  it("rejects delivery into an attempt whose lease expired", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-delivery-expired" });
    const lease = createStartingQueue({ queueItemId: "queue-delivery-expired", startingAt: 1_100 });

    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-delivery-expired",
        expectedStatus: "starting",
        expectedBootEpoch: "boot-a",
        expectedLeaseOwner: lease.leaseOwner,
        expectedLeaseExpiresAt: lease.leaseExpiresAt,
        status: "delivered",
        deliveredAttemptId: "attempt-delivery-expired",
        deliveredTurnId: "turn-a",
        updatedAt: 1_200,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
  });

  it("rejects delivery into a recovery-claimed attempt", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-delivery-claimed" });
    const lease = createStartingQueue({ queueItemId: "queue-delivery-claimed", startingAt: 900 });
    createRuntimeRecoveryRun({
      recoveryRunId: "apply-delivery-claimed",
      mode: "apply",
      bootEpoch: "boot-a",
      startedAt: 1_000,
    });
    const candidate = recordRuntimeRecoveryCandidate({
      recoveryRunId: "apply-delivery-claimed",
      candidateType: "turn_attempt",
      sessionKey: "agent:dev:main",
      attemptId: "attempt-delivery-claimed",
      decision: "resume",
      reasonCode: "safe",
      action: "resume_through_dispatcher",
      recordedAt: 1_010,
    });
    acquireRuntimeRecoveryClaim({
      recoveryRunId: "apply-delivery-claimed",
      candidateKey: candidate.candidateKey,
      claimedByBootEpoch: "boot-a",
      claimId: "claim-delivery-claimed",
      claimedAt: 1_020,
    });

    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-delivery-claimed",
        expectedStatus: "starting",
        expectedBootEpoch: "boot-a",
        expectedLeaseOwner: lease.leaseOwner,
        expectedLeaseExpiresAt: lease.leaseExpiresAt,
        status: "delivered",
        deliveredAttemptId: "attempt-delivery-claimed",
        deliveredTurnId: "turn-a",
        updatedAt: 1_030,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
  });

  it("audits inspect and dry-run candidates without allowing claims", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-inspect" });
    for (const mode of ["inspect", "dry-run"] as const) {
      const runId = `run-${mode}`;
      createRuntimeRecoveryRun({ recoveryRunId: runId, mode, bootEpoch: "boot-a", startedAt: 1_000 });
      const candidate = recordRuntimeRecoveryCandidate({
        recoveryRunId: runId,
        candidateType: "turn_attempt",
        sessionKey: "agent:dev:main",
        attemptId: "attempt-inspect",
        decision: "manual_review",
        reasonCode: "inspect_only",
        action: "none",
        details: { mode },
        recordedAt: 1_010,
      });
      expect(candidate.actionStatus).toBe("not_applied");
      expect(candidate.actionCompletedAt).toBe(1_010);
      expect(() =>
        acquireRuntimeRecoveryClaim({
          recoveryRunId: runId,
          candidateKey: "attempt:attempt-inspect",
          claimedByBootEpoch: "boot-a",
          claimedAt: 1_020,
        }),
      ).toThrow(CrashRecoveryLedgerConflictError);
      expect(listRuntimeRecoveryCandidates(runId)).toHaveLength(1);
      completeRuntimeRecoveryRun({
        recoveryRunId: runId,
        status: "complete",
        summary: { candidates: 1 },
        completedAt: 1_030,
      });
      expect(() =>
        recordRuntimeRecoveryCandidate({
          recoveryRunId: runId,
          candidateType: "turn_attempt",
          sessionKey: "agent:dev:main",
          attemptId: "attempt-inspect",
          decision: "manual_review",
          reasonCode: "late",
          action: "none",
          recordedAt: 1_040,
        }),
      ).toThrow(CrashRecoveryLedgerConflictError);
    }
  });

  it("keeps legacy trace evidence inspect-only even inside an apply run", () => {
    createBoot();
    createRuntimeRecoveryRun({ recoveryRunId: "apply-legacy", mode: "apply", bootEpoch: "boot-a", startedAt: 1_000 });
    const candidate = recordRuntimeRecoveryCandidate({
      recoveryRunId: "apply-legacy",
      candidateType: "legacy_session_turn",
      sessionKey: "agent:dev:main",
      turnId: "legacy-turn",
      decision: "manual_review",
      reasonCode: "legacy_trace_only",
      action: "none",
      recordedAt: 1_010,
    });
    expect(candidate).toMatchObject({ actionStatus: "not_applied", actionCompletedAt: 1_010 });
    expect(() =>
      acquireRuntimeRecoveryClaim({
        recoveryRunId: "apply-legacy",
        candidateKey: candidate.candidateKey,
        claimedByBootEpoch: "boot-a",
        claimedAt: 1_020,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(
      completeRuntimeRecoveryRun({
        recoveryRunId: "apply-legacy",
        status: "complete",
        summary: { inspected: 1 },
        completedAt: 1_030,
      }).status,
    ).toBe("complete");
  });

  it("grants one global claim across apply runs and projects the terminal result atomically", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-claim" });
    for (const runId of ["apply-1", "apply-2"]) {
      createRuntimeRecoveryRun({ recoveryRunId: runId, mode: "apply", bootEpoch: "boot-a", startedAt: 1_000 });
      recordRuntimeRecoveryCandidate({
        recoveryRunId: runId,
        candidateKey: "attempt:attempt-claim",
        candidateType: "turn_attempt",
        sessionKey: "agent:dev:main",
        attemptId: "attempt-claim",
        decision: "resume",
        reasonCode: "expired_abandoned_attempt",
        action: "resume_through_dispatcher",
        details: { safe: true },
        recordedAt: 1_010,
      });
    }

    expect(() =>
      completeRuntimeRecoveryRun({
        recoveryRunId: "apply-1",
        status: "complete",
        completedAt: 1_015,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    const winner = acquireRuntimeRecoveryClaim({
      recoveryRunId: "apply-1",
      candidateKey: "attempt:attempt-claim",
      claimedByBootEpoch: "boot-a",
      claimId: "claim-a",
      claimedAt: 1_020,
    });
    const loser = acquireRuntimeRecoveryClaim({
      recoveryRunId: "apply-2",
      candidateKey: "attempt:attempt-claim",
      claimedByBootEpoch: "boot-a",
      claimId: "claim-b",
      claimedAt: 1_021,
    });
    expect(winner.status).toBe("acquired");
    expect(loser.status).toBe("existing");
    expect(loser.claim.claimId).toBe("claim-a");
    expect(getRuntimeRecoveryCandidate("apply-1", "attempt:attempt-claim")?.actionStatus).toBe("claimed");
    expect(getRuntimeRecoveryCandidate("apply-2", "attempt:attempt-claim")).toMatchObject({
      actionStatus: "not_applied",
      claimId: "claim-a",
      result: { code: "already_claimed", claimId: "claim-a", recoveryRunId: "apply-1" },
    });
    expect(getRuntimeTurnAttempt("attempt-claim")).toMatchObject({
      recoveryClaimId: "claim-a",
      recoveryRunId: "apply-1",
      recoveryStatus: "claimed",
    });

    expect(() =>
      completeRuntimeRecoveryClaim({
        claimId: "claim-a",
        status: "applied",
        result: { dispatched: true },
        completedAt: 1_019,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    const completed = completeRuntimeRecoveryClaim({
      claimId: "claim-a",
      status: "applied",
      result: { dispatched: true },
      completedAt: 1_100,
    });
    expect(completed.claim).toMatchObject({ status: "applied", result: { dispatched: true } });
    expect(completed.candidate).toMatchObject({
      actionStatus: "applied",
      result: { dispatched: true },
      actionCompletedAt: 1_100,
    });
    expect(getRuntimeTurnAttempt("attempt-claim")).toMatchObject({
      recoveryStatus: "resume",
      recoveryReason: "expired_abandoned_attempt",
      recoveredAt: 1_100,
    });
    expect(
      completeRuntimeRecoveryClaim({
        claimId: "claim-a",
        status: "applied",
        result: { dispatched: true },
        completedAt: 1_100,
      }).claim.status,
    ).toBe("applied");
    expect(() =>
      completeRuntimeRecoveryClaim({
        claimId: "claim-a",
        status: "applied",
        result: { dispatched: false },
        completedAt: 1_100,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() =>
      completeRuntimeRecoveryClaim({
        claimId: "claim-a",
        status: "applied",
        result: { dispatched: true },
        completedAt: 1_200,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() =>
      completeRuntimeRecoveryClaim({
        claimId: "claim-a",
        status: "failed",
        result: { error: "late" },
        completedAt: 1_200,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(getRuntimeRecoveryClaimByCandidate("attempt:attempt-claim")?.claimId).toBe("claim-a");
    expect(
      completeRuntimeRecoveryRun({ recoveryRunId: "apply-1", status: "complete", completedAt: 1_200 }).status,
    ).toBe("complete");
    expect(
      completeRuntimeRecoveryRun({ recoveryRunId: "apply-2", status: "complete", completedAt: 1_200 }).status,
    ).toBe("complete");
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("fences normal attempt and queue mutations after a recovery claim", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-fenced" });
    const queueItem = enqueuePrompt({ dedupeKey: "queue-fenced", queueItemId: "queue-fenced" }).item;
    createRuntimeRecoveryRun({ recoveryRunId: "apply-fenced", mode: "apply", bootEpoch: "boot-a", startedAt: 1_000 });

    const attemptCandidate = recordRuntimeRecoveryCandidate({
      recoveryRunId: "apply-fenced",
      candidateType: "turn_attempt",
      sessionKey: "agent:dev:main",
      attemptId: "attempt-fenced",
      decision: "resume",
      reasonCode: "safe",
      action: "resume_through_dispatcher",
      recordedAt: 1_010,
    });
    const queueCandidate = recordRuntimeRecoveryCandidate({
      recoveryRunId: "apply-fenced",
      candidateType: "prompt_queue",
      sessionKey: queueItem.sessionKey,
      queueItemId: queueItem.queueItemId,
      decision: "requeue",
      reasonCode: "orphaned_queue_item",
      action: "requeue_through_dispatcher",
      recordedAt: 1_011,
    });
    acquireRuntimeRecoveryClaim({
      recoveryRunId: "apply-fenced",
      candidateKey: attemptCandidate.candidateKey,
      claimedByBootEpoch: "boot-a",
      claimId: "claim-attempt-fenced",
      claimedAt: 1_020,
    });
    acquireRuntimeRecoveryClaim({
      recoveryRunId: "apply-fenced",
      candidateKey: queueCandidate.candidateKey,
      claimedByBootEpoch: "boot-a",
      claimId: "claim-queue-fenced",
      claimedAt: 1_021,
    });

    expect(() =>
      heartbeatRuntimeTurnAttempt({
        attemptId: "attempt-fenced",
        bootEpoch: "boot-a",
        heartbeatAt: 1_030,
        leaseExpiresAt: 1_300,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() =>
      markRuntimeTurnAttemptSafety({ attemptId: "attempt-fenced", startedTool: true, markedAt: 1_030 }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() =>
      terminalizeRuntimeTurnAttempt({ attemptId: "attempt-fenced", status: "complete", completedAt: 1_030 }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() =>
      compareAndSetRuntimePromptQueueStatus({
        queueItemId: "queue-fenced",
        expectedStatus: "queued",
        status: "requeued",
        updatedAt: 1_030,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    expect(getRuntimeTurnAttempt("attempt-fenced")).toMatchObject({
      status: "running",
      startedTool: false,
      materializedOutput: false,
      recoveryClaimId: "claim-attempt-fenced",
    });
    expect(getRuntimePromptQueueItem("queue-fenced")).toMatchObject({
      status: "queued",
      recoveryClaimId: "claim-queue-fenced",
    });
  });

  it("grants one global claim under a real two-process race", async () => {
    createBoot();
    createBoot("boot-race-1");
    createBoot("boot-race-2");
    createAttempt({ attemptId: "attempt-race" });
    for (const [runId, bootEpoch] of [
      ["race-1", "boot-race-1"],
      ["race-2", "boot-race-2"],
    ] as const) {
      createRuntimeRecoveryRun({ recoveryRunId: runId, mode: "apply", bootEpoch, startedAt: 1_000 });
      recordRuntimeRecoveryCandidate({
        recoveryRunId: runId,
        candidateType: "turn_attempt",
        sessionKey: "agent:dev:main",
        attemptId: "attempt-race",
        decision: "resume",
        reasonCode: "expired_abandoned_attempt",
        action: "resume_through_dispatcher",
        recordedAt: 1_010,
      });
    }

    const releasePath = join(stateDir!, "claim-race-release");
    const readyPaths = [join(stateDir!, "claim-race-ready-1"), join(stateDir!, "claim-race-ready-2")];
    const resultPromises = [
      acquireClaimInChildProcess({
        recoveryRunId: "race-1",
        candidateKey: "attempt:attempt-race",
        claimedByBootEpoch: "boot-race-1",
        claimId: "claim-race-1",
        claimedAt: 1_020,
        readyPath: readyPaths[0]!,
        releasePath,
      }),
      acquireClaimInChildProcess({
        recoveryRunId: "race-2",
        candidateKey: "attempt:attempt-race",
        claimedByBootEpoch: "boot-race-2",
        claimId: "claim-race-2",
        claimedAt: 1_020,
        readyPath: readyPaths[1]!,
        releasePath,
      }),
    ];
    await Promise.all(readyPaths.map((path) => waitForFile(path)));
    await write(releasePath, "release");
    const results = await Promise.all(resultPromises);
    expect(results.map((result) => result.status).sort()).toEqual(["acquired", "existing"]);
    expect(new Set(results.map((result) => result.claim.claimId)).size).toBe(1);
    expect(
      (getDb().prepare("SELECT COUNT(*) AS count FROM runtime_recovery_claims").get() as { count: number }).count,
    ).toBe(1);
    expect(getRuntimeTurnAttempt("attempt-race")?.recoveryClaimId).toBe(results[0]?.claim.claimId);
  });

  it("projects a failed queue claim without making the prompt claimable again", () => {
    createBoot();
    const queueItem = enqueuePrompt({ dedupeKey: "queue-claim", queueItemId: "queue-claim" }).item;
    createRuntimeRecoveryRun({ recoveryRunId: "apply-queue", mode: "apply", bootEpoch: "boot-a", startedAt: 1_000 });
    recordRuntimeRecoveryCandidate({
      recoveryRunId: "apply-queue",
      candidateKey: "queue:queue-claim",
      candidateType: "prompt_queue",
      sessionKey: queueItem.sessionKey,
      queueItemId: queueItem.queueItemId,
      decision: "requeue",
      reasonCode: "orphaned_queue_item",
      action: "requeue_through_dispatcher",
      recordedAt: 1_010,
    });
    const acquired = acquireRuntimeRecoveryClaim({
      recoveryRunId: "apply-queue",
      candidateKey: "queue:queue-claim",
      claimedByBootEpoch: "boot-a",
      claimId: "claim-queue",
      claimedAt: 1_020,
    });
    expect(acquired.status).toBe("acquired");
    completeRuntimeRecoveryClaim({
      claimId: "claim-queue",
      status: "failed",
      result: { error: "dispatcher unavailable" },
      completedAt: 1_030,
    });
    expect(getRuntimePromptQueueItem("queue-claim")).toMatchObject({
      recoveryClaimId: "claim-queue",
      recoveryStatus: "action_failed",
      recoveryReason: "orphaned_queue_item",
      recoveredAt: 1_030,
    });
    expect(
      acquireRuntimeRecoveryClaim({
        recoveryRunId: "apply-queue",
        candidateKey: "queue:queue-claim",
        claimedByBootEpoch: "boot-a",
        claimedAt: 1_040,
      }),
    ).toMatchObject({ status: "existing", claim: { claimId: "claim-queue", status: "failed" } });
  });

  it("rolls back claim completion when attempt or queue source projections partially diverge", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-diverged" });
    const queueItem = enqueuePrompt({ dedupeKey: "queue-diverged", queueItemId: "queue-diverged" }).item;
    createRuntimeRecoveryRun({ recoveryRunId: "apply-diverged", mode: "apply", bootEpoch: "boot-a", startedAt: 1_000 });
    const attemptCandidate = recordRuntimeRecoveryCandidate({
      recoveryRunId: "apply-diverged",
      candidateType: "turn_attempt",
      sessionKey: "agent:dev:main",
      attemptId: "attempt-diverged",
      decision: "resume",
      reasonCode: "safe",
      action: "resume_through_dispatcher",
      recordedAt: 1_010,
    });
    const queueCandidate = recordRuntimeRecoveryCandidate({
      recoveryRunId: "apply-diverged",
      candidateType: "prompt_queue",
      sessionKey: queueItem.sessionKey,
      queueItemId: queueItem.queueItemId,
      decision: "requeue",
      reasonCode: "orphaned_queue_item",
      action: "requeue_through_dispatcher",
      recordedAt: 1_011,
    });
    acquireRuntimeRecoveryClaim({
      recoveryRunId: "apply-diverged",
      candidateKey: attemptCandidate.candidateKey,
      claimedByBootEpoch: "boot-a",
      claimId: "claim-attempt-diverged",
      claimedAt: 1_020,
    });
    acquireRuntimeRecoveryClaim({
      recoveryRunId: "apply-diverged",
      candidateKey: queueCandidate.candidateKey,
      claimedByBootEpoch: "boot-a",
      claimId: "claim-queue-diverged",
      claimedAt: 1_021,
    });
    const db = getDb();
    db.prepare("UPDATE runtime_turn_attempts SET recovery_status = NULL WHERE attempt_id = ?").run("attempt-diverged");
    db.prepare("UPDATE runtime_prompt_queue SET recovery_reason = ? WHERE queue_item_id = ?").run(
      "diverged-reason",
      "queue-diverged",
    );

    expect(() =>
      completeRuntimeRecoveryClaim({
        claimId: "claim-attempt-diverged",
        status: "applied",
        result: { dispatched: true },
        completedAt: 1_030,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
    expect(() =>
      completeRuntimeRecoveryClaim({
        claimId: "claim-queue-diverged",
        status: "failed",
        result: { error: "dispatcher unavailable" },
        completedAt: 1_031,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);

    expect(getRuntimeRecoveryClaimByCandidate("attempt:attempt-diverged")?.status).toBe("claimed");
    expect(getRuntimeRecoveryCandidate("apply-diverged", "attempt:attempt-diverged")?.actionStatus).toBe("claimed");
    expect(getRuntimeTurnAttempt("attempt-diverged")).toMatchObject({
      recoveryClaimId: "claim-attempt-diverged",
      recoveryStatus: null,
    });
    expect(getRuntimeRecoveryClaimByCandidate("queue:queue-diverged")?.status).toBe("claimed");
    expect(getRuntimeRecoveryCandidate("apply-diverged", "queue:queue-diverged")?.actionStatus).toBe("claimed");
    expect(getRuntimePromptQueueItem("queue-diverged")).toMatchObject({
      recoveryClaimId: "claim-queue-diverged",
      recoveryReason: "diverged-reason",
    });
  });

  it("derives canonical candidate keys and rejects caller-defined collisions", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-canonical" });
    createRuntimeRecoveryRun({
      recoveryRunId: "apply-canonical",
      mode: "apply",
      bootEpoch: "boot-a",
      startedAt: 1_000,
    });
    expect(() =>
      recordRuntimeRecoveryCandidate({
        recoveryRunId: "apply-canonical",
        candidateKey: "attempt:some-other-source",
        candidateType: "turn_attempt",
        sessionKey: "agent:dev:main",
        attemptId: "attempt-canonical",
        decision: "resume",
        reasonCode: "safe",
        action: "resume_through_dispatcher",
        recordedAt: 1_010,
      }),
    ).toThrow(CrashRecoveryLedgerConflictError);
  });

  it("fails closed instead of completing a run with a corrupt candidate action status", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-corrupt-candidate-status" });
    createRuntimeRecoveryRun({
      recoveryRunId: "apply-corrupt-candidate-status",
      mode: "apply",
      bootEpoch: "boot-a",
      startedAt: 1_000,
    });
    const candidate = recordRuntimeRecoveryCandidate({
      recoveryRunId: "apply-corrupt-candidate-status",
      candidateType: "turn_attempt",
      sessionKey: "agent:dev:main",
      attemptId: "attempt-corrupt-candidate-status",
      decision: "resume",
      reasonCode: "safe",
      action: "resume_through_dispatcher",
      recordedAt: 1_010,
    });
    const db = getDb();
    db.exec("PRAGMA ignore_check_constraints = ON");
    try {
      db.prepare(
        `UPDATE runtime_recovery_candidates SET action_status = ?
         WHERE recovery_run_id = ? AND candidate_key = ?`,
      ).run("corrupt-status", "apply-corrupt-candidate-status", candidate.candidateKey);
    } finally {
      db.exec("PRAGMA ignore_check_constraints = OFF");
    }

    expect(() =>
      completeRuntimeRecoveryRun({
        recoveryRunId: "apply-corrupt-candidate-status",
        status: "complete",
        completedAt: 1_020,
      }),
    ).toThrow(CrashRecoveryLedgerCorruptionError);
    expect(getRuntimeRecoveryRun("apply-corrupt-candidate-status")?.status).toBe("running");
  });

  it("fails closed when persisted safety enums are corrupt", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-corrupt-origin" });
    getDb().exec("PRAGMA ignore_check_constraints = ON");
    getDb()
      .prepare("UPDATE runtime_turn_attempts SET origin_kind = ? WHERE attempt_id = ?")
      .run("not-a-real-origin", "attempt-corrupt-origin");
    getDb().exec("PRAGMA ignore_check_constraints = OFF");
    expect(() => getRuntimeTurnAttempt("attempt-corrupt-origin")).toThrow(CrashRecoveryLedgerCorruptionError);
  });

  it("fails closed when persisted safety markers are not binary", () => {
    createBoot();
    createAttempt({ attemptId: "attempt-corrupt-started-tool" });
    createAttempt({ attemptId: "attempt-corrupt-materialized-output" });
    const db = getDb();
    db.exec("PRAGMA ignore_check_constraints = ON");
    try {
      db.prepare("UPDATE runtime_turn_attempts SET started_tool = ? WHERE attempt_id = ?").run(
        2,
        "attempt-corrupt-started-tool",
      );
      db.prepare("UPDATE runtime_turn_attempts SET materialized_output = ? WHERE attempt_id = ?").run(
        -1,
        "attempt-corrupt-materialized-output",
      );
    } finally {
      db.exec("PRAGMA ignore_check_constraints = OFF");
    }

    expect(() => getRuntimeTurnAttempt("attempt-corrupt-started-tool")).toThrow(CrashRecoveryLedgerCorruptionError);
    expect(() => getRuntimeTurnAttempt("attempt-corrupt-materialized-output")).toThrow(
      CrashRecoveryLedgerCorruptionError,
    );
  });

  it("detects valid-JSON prompt tampering on reads and identical enqueue retries", () => {
    createBoot();
    enqueuePrompt({ dedupeKey: "tampered", queueItemId: "queue-tampered" });
    getDb()
      .prepare("UPDATE runtime_prompt_queue SET prompt_json = ? WHERE queue_item_id = ?")
      .run(JSON.stringify({ message: "tampered but valid" }), "queue-tampered");

    expect(() => getRuntimePromptQueueItem("queue-tampered")).toThrow(CrashRecoveryLedgerCorruptionError);
    expect(() => enqueuePrompt({ dedupeKey: "tampered", queueItemId: "queue-tampered" })).toThrow(
      CrashRecoveryLedgerCorruptionError,
    );
  });

  it("fails closed when required prompt JSON is corrupt", () => {
    createBoot();
    enqueuePrompt({ dedupeKey: "corrupt", queueItemId: "queue-corrupt" });
    getDb()
      .prepare("UPDATE runtime_prompt_queue SET prompt_json = ? WHERE queue_item_id = ?")
      .run("{bad", "queue-corrupt");
    expect(() => getRuntimePromptQueueItem("queue-corrupt")).toThrow(CrashRecoveryLedgerCorruptionError);
    expect(getRuntimeBootEpoch("boot-a")?.status).toBe("active");
  });
});
