/**
 * Agent-first contract tests for the `watch` CLI domain (Manual v2):
 * write brake (exit 3) on `rm` (destructive), `trigger` (arms a real
 * automation) and `run` (fires a real poll cycle); WATCH_NOT_FOUND envelope
 * (exit 1 + suggestions from the local store) and compact `--fields` mode.
 * Follows the tasks.test.ts / group.test.ts pattern: no-op decorator mocks +
 * service mocks with spies + `hasContext: () => true` so the contract helpers
 * throw ContractError instead of exiting the process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const { CliExpectedError } = await import("../expected-error.js");

afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Spies and mutable fixtures
// ---------------------------------------------------------------------------

const removeWatchCalls: string[] = [];
const setEnabledCalls: Array<{ id: string; enabled: boolean }> = [];
const createTriggerCalls: Array<Record<string, unknown>> = [];

interface MockWatch {
  id: string;
  name: string | null;
  provider: string;
  placement: string;
  status: string;
  resourceRef: string;
  eventTypes: string[];
  eventSubjects: string[];
  createdAt: number;
  updatedAt: number;
}

let watchStore: MockWatch[] = [];
let watchOperationError: unknown = null;

function buildWatch(overrides: Partial<MockWatch> = {}): MockWatch {
  return {
    id: "watch-gh-1",
    name: "ravi repo",
    provider: "github",
    placement: "local",
    status: "active",
    resourceRef: "filipexyz/ravi.bot",
    eventTypes: ["release.published"],
    eventSubjects: ["ravi.watch.github.release.published"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Module mocks (must be installed before importing the modules under test)
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
    throw new CliExpectedError(message);
  },
}));

mock.module("./operational-return-schemas.js", () => ({
  watchConnectorsReturnSchema: {},
  watchCreateReturnSchema: {},
  watchEventsReturnSchema: {},
  watchListReturnSchema: {},
  watchMutationReturnSchema: {},
  watchRemoveReturnSchema: {},
  watchShowReturnSchema: {},
  watchTriggerReturnSchema: {},
}));

mock.module("../../router/config.js", () => ({
  getAgent: (id: string) => (id === "main" ? { id: "main" } : undefined),
}));

mock.module("../../router/router-db.js", () => ({
  getAccountForAgent: () => "acc-main",
}));

mock.module("../../cron/schedule.js", () => ({
  parseDurationMs: () => 5000,
  formatDurationMs: () => "5s",
}));

mock.module("../../triggers/index.js", () => ({
  dbCreateTrigger: (input: Record<string, unknown>) => {
    createTriggerCalls.push(input);
    return { id: "trigger-1", ...input };
  },
}));

mock.module("../../watch/index.js", () => ({
  isWatchApiError: (error: unknown) =>
    Boolean(error && typeof error === "object" && (error as Record<string, unknown>).__watchApi === true),
  listWatchConnectors: () => [],
  listWatchRecords: (input?: { limit?: number; offset?: number }) => {
    const limit = input?.limit ?? 50;
    const offset = input?.offset ?? 0;
    return {
      items: watchStore.slice(offset, offset + limit),
      total: watchStore.length,
      limit,
      offset,
    };
  },
  showWatch: (id: string) => watchStore.find((watch) => watch.id === id) ?? null,
  removeWatch: async (id: string) => {
    removeWatchCalls.push(id);
    return watchStore.some((watch) => watch.id === id);
  },
  setWatchEnabled: async (id: string, enabled: boolean) => {
    if (watchOperationError) throw watchOperationError;
    setEnabledCalls.push({ id, enabled });
    const watch = watchStore.find((item) => item.id === id);
    if (!watch) throw new Error(`Watch not found: ${id}`);
    return { ...watch, status: enabled ? "active" : "disabled" };
  },
  createWatch: async () => {
    if (watchOperationError) throw watchOperationError;
    throw new Error("createWatch is not exercised by the contract tests");
  },
}));

const { WatchCommands } = await import("./watch.js");
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
  removeWatchCalls.length = 0;
  setEnabledCalls.length = 0;
  createTriggerCalls.length = 0;
  watchStore = [buildWatch()];
  watchOperationError = null;
});

// ---------------------------------------------------------------------------
// Write brake
// ---------------------------------------------------------------------------

describe("watch write brake", () => {
  it("rm without --execute is a dry-run: exit 3, plan shown, NO local or remote removal", async () => {
    watchStore = [buildWatch({ name: "PRIVATE_MESSAGE_8K2R", resourceRef: "C:/sentinel/private" })];
    const commands = new WatchCommands();
    const error = await expectContractError(
      () => commands.rm("watch-gh-1", true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toEqual({
      watchId: "watch-gh-1",
      provider: "github",
      resourceRefPresent: true,
      placement: "local",
      status: "active",
      namePresent: true,
    });
    expect(JSON.stringify(error.details.plan)).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(JSON.stringify(error.details.plan)).not.toContain("C:/sentinel/private");
    expect(removeWatchCalls).toHaveLength(0);
  });

  it("rm with --execute removes the watch", async () => {
    const commands = new WatchCommands();
    const payload = await silenced(() => commands.rm("watch-gh-1", true, true));

    expect(removeWatchCalls).toEqual(["watch-gh-1"]);
    expect(payload).toMatchObject({ deleted: true, id: "watch-gh-1" });
  });

  it("trigger without --execute is a dry-run: exit 3 with the resolved watch + trigger plan, NO trigger created", async () => {
    watchStore = [buildWatch({ resourceRef: "C:/sentinel/private" })];
    const sensitiveMessage = "PRIVATE_MESSAGE_8K2R";
    const commands = new WatchCommands();
    const error = await expectContractError(
      () =>
        commands.trigger(
          "watch-gh-1",
          sensitiveMessage,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toEqual({
      watch: { id: "watch-gh-1", provider: "github" },
      trigger: {
        name: "watch:github:release.published",
        topic: "ravi.watch.github.release.published",
        filterPresent: true,
        messageChars: sensitiveMessage.length,
        session: "isolated",
        cooldownMs: 5000,
      },
    });
    expect(JSON.stringify(error.details.plan)).not.toContain(sensitiveMessage);
    expect(JSON.stringify(error.details.plan)).not.toContain("C:/sentinel/private");
    expect(createTriggerCalls).toHaveLength(0);
  });

  it("trigger with --execute creates the trigger scoped to the watch", async () => {
    const commands = new WatchCommands();
    const payload = await silenced(() =>
      commands.trigger(
        "watch-gh-1",
        "Resume o evento.",
        undefined,
        "main",
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );

    expect(createTriggerCalls).toHaveLength(1);
    expect(createTriggerCalls[0]).toMatchObject({
      name: "watch:github:release.published",
      topic: "ravi.watch.github.release.published",
      filter: 'data.watchId == "watch-gh-1"',
      message: "Resume o evento.",
      agentId: "main",
      accountId: "acc-main",
      session: "isolated",
    });
    expect(payload).toMatchObject({ status: "created" });
  });

  it("trigger validates --message BEFORE the brake: missing message fails without a dry-run and creates nothing", async () => {
    const commands = new WatchCommands();
    await silenced(async () => {
      await expect(
        commands.trigger(
          "watch-gh-1",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        ),
      ).rejects.toThrow("--message is required");
    });

    expect(createTriggerCalls).toHaveLength(0);
  });

  it("trigger fails BEFORE the brake when the target agent does not exist", async () => {
    const commands = new WatchCommands();
    await silenced(async () => {
      await expect(
        commands.trigger(
          "watch-gh-1",
          "Resume o evento.",
          undefined,
          "ghost",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
        ),
      ).rejects.toThrow("Agent not found: ghost");
    });

    expect(createTriggerCalls).toHaveLength(0);
  });

  it("run without --execute is a dry-run: exit 3 with the resolved local watch plan", async () => {
    watchStore = [
      buildWatch({
        resourceRef: "C:/sentinel/private",
        eventTypes: ["SENTINEL_SECRET_7M4Q"],
      }),
    ];
    const commands = new WatchCommands();
    const error = await expectContractError(
      () => commands.run("watch-gh-1", true, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toEqual({
      watchId: "watch-gh-1",
      provider: "github",
      resourceRefPresent: true,
      placement: "local",
      eventTypesCount: 1,
      once: true,
    });
    expect(JSON.stringify(error.details.plan)).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(JSON.stringify(error.details.plan)).not.toContain("C:/sentinel/private");
    expect(removeWatchCalls).toHaveLength(0);
    expect(setEnabledCalls).toHaveLength(0);
    expect(createTriggerCalls).toHaveLength(0);
  });

  it("run with --execute emits LOCAL_RUNNER_NOT_IMPLEMENTED with exit 1", async () => {
    const error = await expectContractError(
      () => new WatchCommands().run("watch-gh-1", true, true, true),
      "LOCAL_RUNNER_NOT_IMPLEMENTED",
      1,
    );

    expect(error.details.retryable).toBe(false);
  });

  it("run still validates placement BEFORE the brake: console watches fail with the legacy message", async () => {
    watchStore = [buildWatch({ id: "watch-npm-console", placement: "console" })];

    const commands = new WatchCommands();
    await silenced(async () => {
      expect(() => commands.run("watch-npm-console", true, undefined, undefined)).toThrow(
        "Only local watches can be run from the OSS CLI.",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Not-found envelope and compact mode
// ---------------------------------------------------------------------------

describe("watch envelopes and compact mode", () => {
  it("preserves safe provider errors and removes arbitrary provider details", async () => {
    watchOperationError = {
      __watchApi: true,
      code: "RATE_LIMITED",
      message: "Provider rate limit reached.",
      details: { retryAfterMs: 1_000, accessToken: "secret-token" },
    };

    const error = await expectContractError(() => new WatchCommands().enable("watch-gh-1", true), "RATE_LIMITED", 1);
    expect(error.details.retryable).toBe(true);
    expect(error.details.retryAfterMs).toBe(1_000);
    expect(error.details.accessToken).toBeUndefined();
    expect(JSON.stringify(error.envelope())).not.toContain("secret-token");
  });

  it("redacts unexpected provider failures as UNHANDLED_ERROR", async () => {
    watchOperationError = new Error("provider https://secret.invalid?token=abc failed");

    const error = await expectContractError(
      () => new WatchCommands().disable("watch-gh-1", true),
      "UNHANDLED_ERROR",
      1,
    );
    expect(error.message).toBe("Command failed unexpectedly.");
    expect(JSON.stringify(error.envelope())).not.toContain("secret.invalid");
  });

  it("show on an unknown watch exits 1 with WATCH_NOT_FOUND and suggestions from the local store", async () => {
    const commands = new WatchCommands();
    const error = await expectContractError(() => commands.show("watch-gh-9", true), "WATCH_NOT_FOUND", 1);

    expect(error.details.suggestions).toContain("watch-gh-1");
    expect(error.details.suggestedAction).toContain("ravi watch list");
  });

  it("events on an unknown watch exits 1 with WATCH_NOT_FOUND", async () => {
    const commands = new WatchCommands();
    await expectContractError(() => commands.events("nope", true), "WATCH_NOT_FOUND", 1);
  });

  it("rm on an unknown watch exits 1 with WATCH_NOT_FOUND before the brake and removes nothing", async () => {
    const commands = new WatchCommands();
    await expectContractError(() => commands.rm("nope", true, undefined), "WATCH_NOT_FOUND", 1);

    expect(removeWatchCalls).toHaveLength(0);
  });

  it("enable/disable on an unknown watch exit 1 with WATCH_NOT_FOUND and never reach the provider", async () => {
    const commands = new WatchCommands();
    await expectContractError(() => commands.enable("nope", true), "WATCH_NOT_FOUND", 1);
    await expectContractError(() => commands.disable("nope", true), "WATCH_NOT_FOUND", 1);

    expect(setEnabledCalls).toHaveLength(0);
  });

  it("run on an unknown watch exits 1 with WATCH_NOT_FOUND", async () => {
    const commands = new WatchCommands();
    await expectContractError(() => commands.run("nope", true, true, undefined), "WATCH_NOT_FOUND", 1);
  });

  it("list --fields narrows each item to the requested fields", async () => {
    watchStore = [buildWatch(), buildWatch({ id: "watch-npm-1", name: "zod", provider: "npm", resourceRef: "zod" })];

    const commands = new WatchCommands();
    const payload = await silenced(() =>
      commands.list(undefined, undefined, undefined, undefined, true, "id,provider"),
    );

    expect(payload.total).toBe(2);
    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "provider"]);
    }
  });
});
