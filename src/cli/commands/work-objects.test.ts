/**
 * Agent-first contract tests for the `work-objects` CLI domain (Manual v2):
 * write brake (exit 3) on `action` — the actionId is executed by a domain
 * adapter and is opaque to the CLI — WORK_OBJECT_NOT_FOUND envelopes (exit 1)
 * when no adapter handles the reference, and the declared UNBRAKED `update`
 * (field-validated patch with optimistic --revision guard). Follows the
 * tasks.test.ts pattern: no-op decorator mocks + service mocks with spies +
 * `hasContext: () => true` so the contract helpers throw ContractError
 * instead of exiting the process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Spies and mutable fixtures
// ---------------------------------------------------------------------------

const resolveCalls: Array<Record<string, unknown>> = [];
const updateCalls: Array<Record<string, unknown>> = [];
const actionCalls: Array<Record<string, unknown>> = [];
const suggestCalls: Array<Record<string, unknown>> = [];

function buildWorkObjectFixture(): Record<string, unknown> {
  return {
    url: "ravi://task/task-1",
    externalRef: { type: "task", id: "task-1" },
    title: "Ship the fix",
    status: "open",
  };
}

let resolveResult: Record<string, unknown> | undefined;
let updateResult: Record<string, unknown> | undefined;
let actionResult: Record<string, unknown> | undefined;
let suggestResult: Record<string, unknown> | undefined;

// ---------------------------------------------------------------------------
// Module mocks (must be installed before importing the module under test)
// ---------------------------------------------------------------------------

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../work-objects/index.js", () => ({
  createWorkObjectRequestContext: (input: Record<string, unknown> = {}) => ({ requestId: "wo_test", ...input }),
  resolveWorkObject: async (input: Record<string, unknown>) => {
    resolveCalls.push(input);
    return resolveResult;
  },
  updateWorkObject: async (ref: Record<string, unknown>, patch: Record<string, unknown>) => {
    updateCalls.push({ ref, patch });
    return updateResult;
  },
  executeWorkObjectAction: async (ref: Record<string, unknown>, action: Record<string, unknown>) => {
    actionCalls.push({ ref, action });
    return actionResult;
  },
  suggestWorkObjectOptions: async (ref: Record<string, unknown>, suggestion: Record<string, unknown>) => {
    suggestCalls.push({ ref, suggestion });
    return suggestResult;
  },
}));

const { WorkObjectCommands } = await import("./work-objects.js");
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
): Promise<ContractErrorInstance> {
  let caught: unknown;
  await silenced(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractErrorInstance;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

beforeEach(() => {
  resolveCalls.length = 0;
  updateCalls.length = 0;
  actionCalls.length = 0;
  suggestCalls.length = 0;
  resolveResult = { providerId: "task", result: buildWorkObjectFixture() };
  updateResult = { providerId: "task", result: { object: buildWorkObjectFixture(), revision: "2" } };
  actionResult = { providerId: "task", result: { message: "Comment added." } };
  suggestResult = { providerId: "task", result: [{ text: "Open", value: "open" }] };
});

// ---------------------------------------------------------------------------
// Write brake on action
// ---------------------------------------------------------------------------

describe("work-objects action write brake", () => {
  it("action without --execute is a dry-run: exit 3 and NO adapter call", async () => {
    const commands = new WorkObjectCommands();
    const error = await expectContractError(
      () => commands.action("task", "task-1", "task.done", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      ref: { type: "task", id: "task-1" },
      actionId: "task.done",
    });
    expect(actionCalls).toHaveLength(0);
  });

  it("action with --execute executes through the adapter", async () => {
    const commands = new WorkObjectCommands();
    const payload = await silenced(() => commands.action("task", "task-1", "task.comment", "olá", true, true));

    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0]).toMatchObject({
      ref: { type: "task", id: "task-1" },
      action: { actionId: "task.comment", value: "olá" },
    });
    expect(payload).toMatchObject({ providerId: "task" });
  });

  it("action validates its arguments BEFORE the brake", async () => {
    const commands = new WorkObjectCommands();
    await silenced(async () => {
      await expect(commands.action("task", "task-1", "  ", undefined, true, undefined)).rejects.toThrow(
        "actionId is required.",
      );
    });
    expect(actionCalls).toHaveLength(0);
  });

  it("action with --execute on an unhandled reference exits 1 with WORK_OBJECT_NOT_FOUND", async () => {
    actionResult = undefined;
    const commands = new WorkObjectCommands();
    await expectContractError(
      () => commands.action("ghost", "obj-1", "ghost.do", undefined, true, true),
      "WORK_OBJECT_NOT_FOUND",
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Not-found envelopes + declared unbraked update
// ---------------------------------------------------------------------------

describe("work-objects envelopes and unbraked update", () => {
  it("resolve on an unhandled reference exits 1 with WORK_OBJECT_NOT_FOUND and a listing suggestedAction", async () => {
    resolveResult = undefined;
    const commands = new WorkObjectCommands();
    const error = await expectContractError(
      () => commands.resolve(undefined, "task", "task-missing", undefined, true),
      "WORK_OBJECT_NOT_FOUND",
      1,
    );

    expect(error.message).toContain("task:task-missing");
    expect(error.details.suggestedAction).toContain("ravi tasks list");
  });

  it("resolve returns the adapter result when handled", async () => {
    const commands = new WorkObjectCommands();
    const payload = await silenced(() => commands.resolve(undefined, "task", "task-1", undefined, true));

    expect(resolveCalls).toHaveLength(1);
    expect(payload).toMatchObject({ providerId: "task" });
  });

  it("update is declared UNBRAKED: it applies the patch immediately without --execute", async () => {
    const commands = new WorkObjectCommands();
    const payload = await silenced(() => commands.update("task", "task-1", '{"priority":"high"}', "1", true));

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      ref: { type: "task", id: "task-1" },
      patch: { values: { priority: "high" }, revision: "1" },
    });
    expect(payload).toMatchObject({ providerId: "task" });
  });

  it("update on an unhandled reference exits 1 with WORK_OBJECT_NOT_FOUND", async () => {
    updateResult = undefined;
    const commands = new WorkObjectCommands();
    await expectContractError(
      () => commands.update("ghost", "obj-1", "{}", undefined, true),
      "WORK_OBJECT_NOT_FOUND",
      1,
    );
  });

  it("suggest on an unhandled reference exits 1 with WORK_OBJECT_NOT_FOUND", async () => {
    suggestResult = undefined;
    const commands = new WorkObjectCommands();
    await expectContractError(
      () => commands.suggest("ghost", "obj-1", "status", undefined, true),
      "WORK_OBJECT_NOT_FOUND",
      1,
    );
  });
});
