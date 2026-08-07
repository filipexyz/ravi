/**
 * Devin CLI tests: validated-argument helpers plus the agent-first contract
 * (Manual v2) — write brake on create/send (exit 3), DEVIN_SESSION_NOT_FOUND
 * envelope (exit 1) and compact --fields mode. The Devin client and local
 * store are mocked (mock.module BEFORE the dynamic import), so no network and
 * no sqlite; contract helpers throw ContractError through runWithContext.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { ContractError } from "../agent-contract.js";
import { redactCommandAccessInput } from "../command-access.js";
import { runWithContext } from "../context.js";
import { getCommandAccessMetadata } from "../decorators.js";

const originalDefaultMaxAcuLimit = process.env.DEVIN_DEFAULT_MAX_ACU_LIMIT;

afterEach(() => {
  if (originalDefaultMaxAcuLimit === undefined) delete process.env.DEVIN_DEFAULT_MAX_ACU_LIMIT;
  else process.env.DEVIN_DEFAULT_MAX_ACU_LIMIT = originalDefaultMaxAcuLimit;
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Spies and in-memory fixtures
// ---------------------------------------------------------------------------

const createSessionCalls: Array<Record<string, unknown>> = [];
const sendMessageCalls: Array<{ devinId: string; message: string; asUser?: string }> = [];
const archiveSessionCalls: string[] = [];
const getSessionCalls: string[] = [];
const getInsightsCalls: string[] = [];
const generateInsightsCalls: string[] = [];
const upsertSessionCalls: string[] = [];
let clientCreationCount = 0;

function recordClientCreation<T>(client: T): T {
  clientCreationCount += 1;
  return client;
}

interface RemoteSession {
  session_id: string;
  status: string;
  url: string;
  title?: string | null;
  tags?: string[];
}

const storeSessions = new Map<string, Record<string, unknown>>();

function remoteFor(devinId: string, extra: Partial<RemoteSession> = {}): RemoteSession {
  return {
    session_id: devinId,
    status: "running",
    url: `https://app.devin.ai/sessions/${devinId}`,
    title: null,
    tags: [],
    ...extra,
  };
}

function recordFor(remote: RemoteSession, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const existing = storeSessions.get(remote.session_id) ?? {};
  return {
    id: `loc-${remote.session_id}`,
    devinId: remote.session_id,
    title: remote.title ?? null,
    status: remote.status,
    statusDetail: null,
    url: remote.url,
    tags: remote.tags ?? [],
    originType: null,
    originId: null,
    taskId: null,
    projectId: null,
    proxRunId: null,
    lastSyncedAt: null,
    updatedAt: Date.now(),
    devinMode: null,
    platform: null,
    resumable: null,
    maxAcuLimit: null,
    maxAcuLimitSource: null,
    userId: null,
    serviceUserId: null,
    effectiveCreateAsUserId: null,
    pullRequests: [],
    ...existing,
    ...extra,
  };
}

function seedSession(devinId: string, extra: Record<string, unknown> = {}): void {
  storeSessions.set(devinId, recordFor(remoteFor(devinId), extra));
}

// ---------------------------------------------------------------------------
// Module mocks (must be installed before importing ./devin.js)
// ---------------------------------------------------------------------------

mock.module("../../devin/client.js", () => ({
  createDevinClientFromEnv: () => ({
    baseUrl: recordClientCreation("https://api.devin.test"),
    orgId: "org_test",
    createSession: async (input: Record<string, unknown>, options?: Record<string, unknown>) => {
      createSessionCalls.push({ ...input, ...(options ?? {}) });
      return remoteFor("devin-new-1", {
        title: (input.title as string | undefined) ?? null,
        tags: (input.tags as string[] | undefined) ?? [],
      });
    },
    sendMessage: async (devinId: string, message: string, asUser?: string) => {
      sendMessageCalls.push({ devinId, message, asUser });
      return remoteFor(devinId);
    },
    getSession: async (devinId: string) => {
      getSessionCalls.push(devinId);
      return remoteFor(devinId);
    },
    listSessions: async () => ({ items: [], total: 0, has_next_page: false }),
    listAllMessages: async () => [],
    listAttachments: async () => [],
    getSessionInsights: async (devinId: string) => {
      getInsightsCalls.push(devinId);
      return {
        session_id: devinId,
        status: "running",
        url: `https://app.devin.ai/sessions/${devinId}`,
        updated_at: Date.now(),
      };
    },
    generateSessionInsights: async (devinId: string) => {
      generateInsightsCalls.push(devinId);
      return {
        session_id: devinId,
        status: "running",
        url: `https://app.devin.ai/sessions/${devinId}`,
        updated_at: Date.now(),
      };
    },
    terminateSession: async (devinId: string) => remoteFor(devinId, { status: "terminated" }),
    archiveSession: async (devinId: string) => {
      archiveSessionCalls.push(devinId);
      return remoteFor(devinId, { status: "archived" });
    },
    self: async () => ({}),
  }),
  getDefaultMaxAcuLimit: () => {
    const value = process.env.DEVIN_DEFAULT_MAX_ACU_LIMIT?.trim();
    if (!value) return undefined;
    return Number(value);
  },
  getDefaultDevinMode: () => undefined,
  getDefaultDevinPlatform: () => undefined,
  getDefaultDevinRepos: () => undefined,
  getDefaultCreateAsUserId: () => undefined,
}));

mock.module("../../devin/store.js", () => ({
  getDevinSession: (idOrDevinId: string) => {
    for (const record of storeSessions.values()) {
      if (record.id === idOrDevinId || record.devinId === idOrDevinId) return record;
    }
    return null;
  },
  listDevinSessions: (options: { status?: string; tag?: string; limit?: number } = {}) => {
    const sessions = [...storeSessions.values()];
    return typeof options.limit === "number" ? sessions.slice(0, options.limit) : sessions;
  },
  upsertDevinSession: (remote: RemoteSession, extra: Record<string, unknown> = {}) => {
    upsertSessionCalls.push(remote.session_id);
    const record = recordFor(remote, {
      status: remote.status,
      ...(typeof extra.lastSyncedAt === "number" ? { lastSyncedAt: extra.lastSyncedAt } : {}),
    });
    storeSessions.set(remote.session_id, record);
    return record;
  },
  listDevinMessages: () => [],
  upsertDevinMessages: (_devinId: string, messages: unknown[]) => messages,
  listDevinAttachments: () => [],
  upsertDevinAttachments: (_devinId: string, attachments: unknown[]) => attachments,
}));

// Spread the real module so this mock does not strip exports other test files
// (e.g. meetings.test.ts) rely on when bun runs several files in one process.
const actualArtifactsStore = await import("../../artifacts/store.js");
mock.module("../../artifacts/store.js", () => ({
  ...actualArtifactsStore,
  createArtifact: () => ({ id: "artifact-test-1" }),
}));

const { DevinSessionCommands, determineMaxAcuLimit, resolveResumable } = await import("./devin.js");

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
): Promise<InstanceType<typeof ContractError>> {
  let caught: unknown;
  await runWithContext({ sessionKey: "devin-test", sessionName: "devin-test", agentId: "devin-test" }, async () => {
    await silenced(async () => {
      try {
        await run();
      } catch (error) {
        caught = error;
      }
    });
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as InstanceType<typeof ContractError>;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

/** Positional args for `create` (29 params); only prompt/--max-acu/--json set. */
function createArgs(execute?: boolean): Parameters<InstanceType<typeof DevinSessionCommands>["create"]> {
  const args = new Array(29).fill(undefined);
  args[0] = "hello world"; // prompt
  args[19] = "10"; // --max-acu
  args[27] = true; // --json
  args[28] = execute; // --execute
  return args as Parameters<InstanceType<typeof DevinSessionCommands>["create"]>;
}

beforeEach(() => {
  createSessionCalls.length = 0;
  sendMessageCalls.length = 0;
  archiveSessionCalls.length = 0;
  getSessionCalls.length = 0;
  getInsightsCalls.length = 0;
  generateInsightsCalls.length = 0;
  upsertSessionCalls.length = 0;
  clientCreationCount = 0;
  storeSessions.clear();
});

// ---------------------------------------------------------------------------
// Validated-argument helpers (pre-existing behavior)
// ---------------------------------------------------------------------------

describe("Devin negated options", () => {
  it("resolves resumable from validated command arguments", () => {
    expect(resolveResumable()).toEqual({ value: undefined, source: "omitted" });
    expect(resolveResumable(true, false)).toEqual({ value: true, source: "explicit" });
    expect(resolveResumable(undefined, true)).toEqual({ value: false, source: "explicit" });
  });

  it("rejects contradictory resumable arguments from remote callers", () => {
    expect(() => runWithContext({}, () => resolveResumable(true, true))).toThrow(
      "Use either --resumable or --no-resumable",
    );
  });

  it("uses the validated noMaxAcuLimit argument instead of process.argv", () => {
    process.env.DEVIN_DEFAULT_MAX_ACU_LIMIT = "25";

    expect(determineMaxAcuLimit(undefined, false)).toEqual({ maxAcuLimit: 25, source: "env" });
    expect(determineMaxAcuLimit(undefined, true)).toEqual({ source: "omitted" });
    expect(determineMaxAcuLimit("12", false)).toEqual({ maxAcuLimit: 12, source: "explicit" });
  });

  it("rejects max ACU together with its negated flag", () => {
    expect(() => runWithContext({}, () => determineMaxAcuLimit("12", true))).toThrow(
      "Use either --max-acu or --no-max-acu-limit",
    );
  });
});

// ---------------------------------------------------------------------------
// Agent-first contract (Manual v2)
// ---------------------------------------------------------------------------

describe("devin sessions agent-first contract", () => {
  it("create declares audit redactions for prompt and session-secret inputs", () => {
    const access = getCommandAccessMetadata(DevinSessionCommands).get("create");
    expect(access?.redactions).toEqual(
      expect.arrayContaining(["prompt", "promptFile", "secretIds", "sessionSecretRefs", "sessionSecret"]),
    );
    expect(
      redactCommandAccessInput(access!, {
        prompt: "SENTINEL_DEVIN_PROMPT_DO_NOT_LEAK",
        sessionSecret: "token=SENTINEL_DEVIN_SESSION_SECRET_DO_NOT_LEAK",
        sessionSecretRefs: ["token=SENTINEL_DEVIN_SESSION_SECRET_DO_NOT_LEAK"],
        secretIds: ["SENTINEL_DEVIN_SECRET_ID_DO_NOT_LEAK"],
      }),
    ).toEqual({
      prompt: "[REDACTED]",
      sessionSecret: "[REDACTED]",
      sessionSecretRefs: "[REDACTED]",
      secretIds: "[REDACTED]",
    });
  });

  it("create without --execute is a dry-run: exit 3 and NO remote session created", async () => {
    const commands = new DevinSessionCommands();
    const error = await expectContractError(
      () => commands.create(...createArgs(undefined)),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      promptChars: 11,
      maxAcuLimit: 10,
      maxAcuLimitSource: "explicit",
      sessionSecretCount: 0,
    });
    expect(createSessionCalls).toHaveLength(0);
  });

  it("create dry-run and session-secret format errors never expose session-secret values", async () => {
    const commands = new DevinSessionCommands();
    const secret = "SENTINEL_DEVIN_SESSION_SECRET_DO_NOT_LEAK";
    const args = createArgs(undefined);
    args[8] = [`token=${secret}`];
    const dryRun = await expectContractError(() => commands.create(...args), "WRITE_REQUIRES_EXECUTE", 3);
    expect(dryRun.details.plan).toMatchObject({ sessionSecretCount: 1 });
    expect(JSON.stringify(dryRun.envelope())).not.toContain(secret);

    const invalid = createArgs(undefined);
    invalid[8] = [secret];
    let invalidError: unknown;
    try {
      await runWithContext({ sessionKey: "devin-test", sessionName: "devin-test", agentId: "devin-test" }, () =>
        commands.create(...invalid),
      );
    } catch (error) {
      invalidError = error;
    }
    expect(invalidError).toBeInstanceOf(Error);
    expect((invalidError as Error).message).not.toContain(secret);
    expect(createSessionCalls).toHaveLength(0);
  });

  it("create with --execute creates the remote session and caches it locally", async () => {
    const commands = new DevinSessionCommands();
    const payload = await silenced(() => commands.create(...createArgs(true)));

    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0]).toMatchObject({ prompt: "hello world", max_acu_limit: 10 });
    expect(payload).toMatchObject({ status: "created", maxAcuLimit: 10 });
    expect(storeSessions.has("devin-new-1")).toBe(true);
  });

  it("send validates the session BEFORE the brake: unknown id exits 1 with DEVIN_SESSION_NOT_FOUND", async () => {
    seedSession("devin-abc123", { title: "Fix bug" });
    const commands = new DevinSessionCommands();
    const error = await expectContractError(
      () => commands.send("sess-nope", "olá", undefined, true, undefined),
      "DEVIN_SESSION_NOT_FOUND",
      1,
    );

    expect(error.details.suggestedAction).toContain("ravi devin sessions list");
    expect(error.details.suggestions).toContain("devin-abc123");
    expect(sendMessageCalls).toHaveLength(0);
  });

  it("send without --execute is a dry-run: exit 3 and NO message sent", async () => {
    seedSession("devin-abc123");
    const commands = new DevinSessionCommands();
    const error = await expectContractError(
      () => commands.send("devin-abc123", "continua a task", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toMatchObject({
      devinId: "devin-abc123",
      messagePreview: "continua a task",
    });
    expect(sendMessageCalls).toHaveLength(0);
  });

  it("send with --execute delivers the message to the Devin client", async () => {
    seedSession("devin-abc123");
    const commands = new DevinSessionCommands();
    const payload = await silenced(() => commands.send("devin-abc123", "continua a task", undefined, true, true));

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]).toMatchObject({ devinId: "devin-abc123", message: "continua a task" });
    expect(payload).toMatchObject({ status: "sent" });
  });

  it("show on an unknown session exits 1 with DEVIN_SESSION_NOT_FOUND and local suggestions", async () => {
    seedSession("devin-abc123", { title: "Fix bug" });
    const commands = new DevinSessionCommands();
    const error = await expectContractError(
      () => commands.show("loc-nope", undefined, true),
      "DEVIN_SESSION_NOT_FOUND",
      1,
    );

    expect(error.op).toBe("devin sessions show");
    expect(error.details.suggestions).toContain("devin-abc123");
  });

  it("list --fields narrows items and the sessions alias equally", async () => {
    seedSession("devin-abc123", { title: "Fix bug" });
    seedSession("devin-def456", { title: "Write docs" });
    const commands = new DevinSessionCommands();
    const payload = await silenced(() =>
      commands.list(undefined, undefined, undefined, undefined, undefined, true, "devinId,status"),
    );

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["devinId", "status"]);
    }
    expect(payload.sessions).toEqual(payload.items);
  });

  it("archive without --execute is blocked before client, provider, or cache effects", async () => {
    seedSession("devin-abc123");
    const commands = new DevinSessionCommands();

    const error = await expectContractError(
      () => commands.archive("devin-abc123", true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({ action: "archive-session", devinId: "devin-abc123" });
    expect(clientCreationCount).toBe(0);
    expect(archiveSessionCalls).toEqual([]);
    expect(upsertSessionCalls).toEqual([]);
  });

  it("archive with --execute updates the external session", async () => {
    seedSession("devin-abc123");
    const commands = new DevinSessionCommands();
    const payload = await silenced(() => commands.archive("devin-abc123", true, true));

    expect(archiveSessionCalls).toEqual(["devin-abc123"]);
    expect(payload).toMatchObject({ status: "archived" });
  });

  it("sync is declared UNBRAKED: it refreshes the local cache without --execute", async () => {
    seedSession("devin-abc123");
    const commands = new DevinSessionCommands();
    const payload = await silenced(() => commands.sync("devin-abc123", undefined, undefined, true));

    expect(getSessionCalls).toEqual(["devin-abc123"]);
    expect(payload).toMatchObject({ messages: 0, attachments: 0, insights: null, artifacts: [] });
  });

  it("insights --generate without --execute is blocked before client, provider, or cache effects", async () => {
    seedSession("devin-abc123");
    const commands = new DevinSessionCommands();

    const error = await expectContractError(
      () => commands.insights("devin-abc123", true, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.envelope()).toMatchObject({
      success: false,
      op: "devin sessions insights",
      error: {
        code: "WRITE_REQUIRES_EXECUTE",
        dryRun: true,
        plan: { action: "generate-insights", devinId: "devin-abc123" },
      },
    });
    expect(clientCreationCount).toBe(0);
    expect(getInsightsCalls).toEqual([]);
    expect(generateInsightsCalls).toEqual([]);
    expect(upsertSessionCalls).toEqual([]);
  });

  it("insights reads and refreshes the local cache without --execute when --generate is absent", async () => {
    seedSession("devin-abc123");
    const commands = new DevinSessionCommands();

    const payload = await silenced(() => commands.insights("devin-abc123", undefined, true, undefined));

    expect(payload).toMatchObject({ session: { devinId: "devin-abc123" }, insights: { session_id: "devin-abc123" } });
    expect(clientCreationCount).toBe(1);
    expect(getInsightsCalls).toEqual(["devin-abc123"]);
    expect(generateInsightsCalls).toEqual([]);
    expect(upsertSessionCalls).toEqual(["devin-abc123"]);
  });

  it("insights --generate with --execute calls the provider and updates the local cache", async () => {
    seedSession("devin-abc123");
    const commands = new DevinSessionCommands();

    const payload = await silenced(() => commands.insights("devin-abc123", true, true, true));

    expect(payload).toMatchObject({ session: { devinId: "devin-abc123" }, insights: { session_id: "devin-abc123" } });
    expect(clientCreationCount).toBe(1);
    expect(getInsightsCalls).toEqual([]);
    expect(generateInsightsCalls).toEqual(["devin-abc123"]);
    expect(upsertSessionCalls).toEqual(["devin-abc123"]);
  });
});
