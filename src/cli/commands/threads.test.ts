/**
 * Agent-first contract tests for the `threads` CLI domain (Manual v2):
 * THREAD_NOT_FOUND envelopes (exit 1) with suggestions from the local
 * listing, compact `--fields` mode, and the declared absence of write brakes
 * (every write is a local, reversible SQLite append/status change). Follows
 * the tasks.test.ts pattern: no-op decorator mocks + service mocks with spies
 * + `hasContext: () => true` so the contract helpers throw ContractError
 * instead of exiting the process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

// ---------------------------------------------------------------------------
// Spies and mutable fixtures
// ---------------------------------------------------------------------------

const listThreadsCalls: Array<Record<string, unknown>> = [];
const updateStatusCalls: Array<Record<string, unknown>> = [];
const addEntryCalls: Array<Record<string, unknown>> = [];
const upsertLinkCalls: Array<Record<string, unknown>> = [];

function buildThreadFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "thr_1",
    slug: "triagem-vendas",
    title: "Triagem de vendas",
    summary: "Fila de triagem",
    status: "open",
    ownerType: "system",
    ownerId: null,
    scopeType: "global",
    scopeId: null,
    defaultAgentId: null,
    defaultChatId: null,
    defaultContactId: null,
    currentAssigneeType: null,
    currentAssigneeId: null,
    closedReason: null,
    closedAt: null,
    metadata: null,
    createdAt: 1,
    updatedAt: 2,
    lastEntryAt: null,
    lastHandoffAt: null,
    ...overrides,
  };
}

let threadFixtures: Array<Record<string, unknown>> = [];

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

mock.module("../../threads/index.js", () => ({
  createThread: (input: Record<string, unknown>) => buildThreadFixture({ id: "thr_new", ...input }),
  resolveThread: (ref: string) => {
    const found = threadFixtures.find((thread) => thread.id === ref || thread.slug === ref);
    if (!found) throw new Error(`Thread not found: ${ref}`);
    return found;
  },
  listThreads: (query: Record<string, unknown> = {}) => {
    listThreadsCalls.push(query);
    return {
      items: threadFixtures,
      total: threadFixtures.length,
      limit: typeof query.limit === "number" ? query.limit : 50,
      offset: typeof query.offset === "number" ? query.offset : 0,
    };
  },
  updateThreadStatus: (threadId: string, status: string, options: Record<string, unknown> = {}) => {
    updateStatusCalls.push({ threadId, status, ...options });
    const base = threadFixtures.find((thread) => thread.id === threadId) ?? buildThreadFixture({ id: threadId });
    return { ...base, status, closedReason: options.reason ?? null, closedAt: 3 };
  },
  addThreadEntry: (input: Record<string, unknown>) => {
    addEntryCalls.push(input);
    return { id: "tre_1", threadId: input.threadId, kind: input.kind, body: input.body, createdAt: 3 };
  },
  upsertThreadLink: (input: Record<string, unknown>) => {
    upsertLinkCalls.push(input);
    const target = input.target as { type: string; id?: string };
    return { threadId: input.threadId, role: input.role ?? "related", targetType: target.type, targetId: target.id };
  },
  listThreadEntries: () => [],
  listThreadLinks: () => [],
  buildThreadBrief: (threadId: string) => ({ threadId, text: "brief" }),
  normalizeThreadSlug: (value: string) => value.trim().toLowerCase(),
  parseThreadPointer: (value: string) => {
    const separator = value.indexOf(":");
    if (separator <= 0) return { type: value };
    return { type: value.slice(0, separator), id: value.slice(separator + 1) };
  },
  formatThreadPointer: (pointer: { type: string; id?: string }) =>
    pointer.id ? `${pointer.type}:${pointer.id}` : pointer.type,
}));

const { ThreadCommands } = await import("./threads.js");
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
  listThreadsCalls.length = 0;
  updateStatusCalls.length = 0;
  addEntryCalls.length = 0;
  upsertLinkCalls.length = 0;
  threadFixtures = [
    buildThreadFixture(),
    buildThreadFixture({ id: "thr_2", slug: "suporte-n2", title: "Suporte N2", status: "open" }),
  ];
});

// ---------------------------------------------------------------------------
// Not-found envelopes
// ---------------------------------------------------------------------------

describe("threads not-found envelopes", () => {
  it("show on an unknown thread exits 1 with THREAD_NOT_FOUND and suggestions from the local listing", async () => {
    const commands = new ThreadCommands();
    const error = await expectContractError(
      () => commands.show("triagem", undefined, undefined, true),
      "THREAD_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("triagem-vendas");
    expect(error.details.suggestedAction).toContain("ravi threads list");
  });

  it("close on an unknown thread exits 1 with THREAD_NOT_FOUND and writes nothing", async () => {
    const commands = new ThreadCommands();
    await expectContractError(() => commands.close("thr_missing", undefined, "done", true), "THREAD_NOT_FOUND", 1);

    expect(updateStatusCalls).toHaveLength(0);
  });

  it("comment on an unknown thread exits 1 with THREAD_NOT_FOUND and appends no entry", async () => {
    const commands = new ThreadCommands();
    await expectContractError(
      () => commands.comment("thr_missing", "olá", undefined, undefined, true),
      "THREAD_NOT_FOUND",
      1,
    );

    expect(addEntryCalls).toHaveLength(0);
  });

  it("entries and brief on unknown threads exit 1 with THREAD_NOT_FOUND", async () => {
    const commands = new ThreadCommands();
    await expectContractError(
      () => commands.entries("thr_missing", undefined, undefined, undefined, true),
      "THREAD_NOT_FOUND",
      1,
    );
    await expectContractError(() => commands.brief("thr_missing", undefined, true), "THREAD_NOT_FOUND", 1);
  });
});

// ---------------------------------------------------------------------------
// Declared unbraked writes + compact mode
// ---------------------------------------------------------------------------

describe("threads unbraked writes and compact mode", () => {
  it("close is declared UNBRAKED: it writes immediately without --execute", async () => {
    const commands = new ThreadCommands();
    const payload = await silenced(() => commands.close("thr_1", undefined, "resolvido", true));

    expect(updateStatusCalls).toHaveLength(1);
    expect(updateStatusCalls[0]).toMatchObject({ threadId: "thr_1", status: "closed", reason: "resolvido" });
    expect(payload).toMatchObject({ action: "close" });
  });

  it("comment is declared UNBRAKED: it appends the entry immediately", async () => {
    const commands = new ThreadCommands();
    const payload = await silenced(() => commands.comment("triagem-vendas", "novo lead", undefined, undefined, true));

    expect(addEntryCalls).toHaveLength(1);
    expect(addEntryCalls[0]).toMatchObject({ threadId: "thr_1", kind: "comment", body: "novo lead" });
    expect(payload).toMatchObject({ action: "comment" });
  });

  it("link resolves the thread and upserts the link immediately", async () => {
    const commands = new ThreadCommands();
    await silenced(() => commands.link("thr_1", "chat:c1", undefined, undefined, undefined, undefined, true));

    expect(upsertLinkCalls).toHaveLength(1);
    expect(upsertLinkCalls[0]).toMatchObject({ threadId: "thr_1", target: { type: "chat", id: "c1" } });
  });

  it("list --fields narrows each item to the requested fields", async () => {
    const commands = new ThreadCommands();
    const payload = await silenced(() =>
      commands.list(undefined, undefined, undefined, undefined, undefined, undefined, true, "id,status"),
    );

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "status"]);
    }
  });
});
