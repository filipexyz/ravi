import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

// Manual v2 contract: hasContext() true makes the contract helpers throw
// ContractError instead of process.exit, which is what tests need.
const actualContext = await import("../context.js");
mock.module("../context.js", () => ({
  ...actualContext,
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { SyncCommands } = await import("./sync.js");
const { ContractError } = await import("../agent-contract.js");
const { enqueueSyncEvent } = await import("../../sync/index.js");
const { closeRouterDb } = await import("../../router/router-db.js");

let stateDir: string;
let originalSyncRunnerEnabled: string | undefined;

beforeEach(async () => {
  originalSyncRunnerEnabled = process.env.RAVI_SYNC_RUNNER_ENABLED;
  delete process.env.RAVI_SYNC_RUNNER_ENABLED;
  stateDir = await createIsolatedRaviState("ravi-sync-cli-test-");
});

afterEach(async () => {
  if (originalSyncRunnerEnabled === undefined) delete process.env.RAVI_SYNC_RUNNER_ENABLED;
  else process.env.RAVI_SYNC_RUNNER_ENABLED = originalSyncRunnerEnabled;
  await cleanupIsolatedRaviState(stateDir);
});

afterAll(() => mock.restore());

describe("sync cli", () => {
  it("prints status as JSON", () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    try {
      const result = new SyncCommands().status(true);
      expect(result.linked).toBe(false);
      const parsed = JSON.parse(logs.join("\n")) as {
        linked: boolean;
        runner: { enabled: boolean; env: string };
        outbox: { pending: number };
      };
      expect(parsed.linked).toBe(false);
      expect(parsed.runner).toMatchObject({ enabled: false, env: "RAVI_SYNC_RUNNER_ENABLED" });
      expect(parsed.outbox.pending).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});

// Manual v2 agent-first contract: write brake on the bulk push/pull transfers,
// retry declared unbraked, and the not-found envelope on inspect.
describe("sync contract", () => {
  it("push without --execute is a dry-run: exit 3 with the batch plan and NO upload", async () => {
    const commands = new SyncCommands();
    const error = await expectContractError(
      () => commands.push("tasks", undefined, "demo-project", undefined, undefined, "25", undefined, undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      domain: "tasks",
      project: "demo-project",
      limit: 25,
      includeTraces: false,
      outboxPending: 0,
      outboxFailed: 0,
    });
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("push with --execute on an unlinked install reports unlinked without throwing", async () => {
    const commands = new SyncCommands();
    const result = await silenced(() =>
      commands.push(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true, true),
    );

    expect(result).toMatchObject({ linked: false, status: "unlinked" });
  });

  it("pull without --execute is a dry-run: exit 3 with the batch plan and NO download", async () => {
    const commands = new SyncCommands();
    const error = await expectContractError(
      () => commands.pull(undefined, undefined, undefined, undefined, undefined, undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      domain: null,
      inboxPending: 0,
      inboxFailed: 0,
    });
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("reads an existing sync summary without changing storage", async () => {
    enqueueSyncEvent({
      domain: "tasks",
      eventType: "task.updated",
      entityType: "task",
      entityId: "task_existing",
      payload: { status: "ready" },
    });
    closeRouterDb();
    const before = stateSnapshot(stateDir);

    const error = await expectContractError(
      () =>
        new SyncCommands().push(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          true,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toMatchObject({ outboxPending: 1, outboxFailed: 0 });
    expect(stateSnapshot(stateDir)).toEqual(before);
  });

  it("retry is declared UNBRAKED: it runs immediately without --execute", async () => {
    const commands = new SyncCommands();
    const result = await silenced(() => commands.retry(undefined, undefined, true));

    expect(result).toEqual({ success: true, retried: 0 });
  });

  it("inspect on an unknown id exits 1 with the SYNC_RECORD_NOT_FOUND envelope", async () => {
    const commands = new SyncCommands();
    const error = await expectContractError(
      () => commands.inspect("row-does-not-exist", true),
      "SYNC_RECORD_NOT_FOUND",
      1,
    );

    expect(error.details.suggestedAction).toContain("ravi sync status --json");
  });
});

async function silenced<T>(run: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<InstanceType<typeof ContractError>> {
  let caught: unknown;
  await silenced(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as InstanceType<typeof ContractError>;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

function stateSnapshot(dir: string): { files: string[]; databaseHash: string } {
  const files = readdirSync(dir).sort();
  const database = readFileSync(join(dir, "ravi.db"));
  return {
    files,
    databaseHash: createHash("sha256").update(database).digest("hex"),
  };
}
