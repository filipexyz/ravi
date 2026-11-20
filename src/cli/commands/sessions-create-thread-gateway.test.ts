import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// This file runs the real `create-thread` handler, so what it publishes must never reach a NATS server: on a
// machine that runs a daemon, 127.0.0.1:4222 is the real one and a `thread.create` job would open a real Slack
// thread. The URL points at a closed port before any module reads it, and the connection helper fails outright.
process.env.NATS_URL = "nats://127.0.0.1:1";
const realNats = await import("../../nats.js");
let natsConnectAttempts = 0;
mock.module("../../nats.js", () => ({
  ...realNats,
  ensureConnected: async () => {
    natsConnectAttempts++;
    throw new Error("NATS is not available in this test");
  },
}));
afterAll(() => mock.restore());

const { cleanupIsolatedRaviState, createIsolatedRaviState } = await import("../../test/ravi-state.js");
const { dbCreateAgent, dbUpsertChannel, dbUpsertChat, getDb } = await import("../../router/router-db.js");
const { attachChatToSession, getOrCreateSession, getSession, renameSessionName } = await import(
  "../../router/sessions.js"
);
const { buildRegistry } = await import("../registry-snapshot.js");
const { dispatch } = await import("../../sdk/gateway/dispatcher.js");
const { returnContractViolationCount } = await import("../../sdk/gateway/return-contract.js");
const { finalizeSlackThreadCreation } = await import("../../channels/slack/thread-lifecycle.js");
const { markSlackThreadRootDelivered } = await import("../../channels/slack/thread-lifecycle-store.js");
const { configureSlackThreadRuntime } = await import("../../channels/slack/thread-runtime.js");
const { SessionCommands, sessionCreateThreadReturnSchema, sessionThreadConfigureReturnSchema } = await import(
  "./sessions.js"
);

const command = buildRegistry([SessionCommands]).commands.find((entry) => entry.fullName === "sessions.create-thread");
if (!command) throw new Error("sessions.create-thread is missing from the real command registry");

const context = {
  contextId: "ctx_create_thread_gateway",
  contextKey: "rctx_create_thread_gateway",
  kind: "test-runtime",
  agentId: "ravi",
  capabilities: [
    { permission: "mutate", objectType: "sessions", objectId: "create-thread", source: "test" },
    // The thread is asked for on behalf of this session, so the caller must be able to reach and change it.
    { permission: "access", objectType: "session", objectId: "main-slack", source: "test" },
    { permission: "modify", objectType: "session", objectId: "main-slack", source: "test" },
    { permission: "access", objectType: "session", objectId: "main-renamed", source: "test" },
    { permission: "modify", objectType: "session", objectId: "main-renamed", source: "test" },
  ],
  metadata: { authorityMode: "delegated" },
  createdAt: Date.now(),
};

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-create-thread-gateway-");
  natsConnectAttempts = 0;
  // A Slack DM session of an agent with a pinned runtime, with the credentials the channel needs to open a thread.
  dbCreateAgent({ id: "ravi", cwd: "/tmp/ravi", provider: "codex", model: "gpt-6-astra" });
  dbUpsertChannel({ name: "ravi-slack", provider: "slack", credentialConnection: "test-installation" });
  const parent = getOrCreateSession("agent:ravi:slack:ravi-slack:D1", "ravi", "/tmp/ravi", {
    name: "main-slack",
    channel: "slack",
    chatType: "dm",
    lastChannel: "slack",
    lastTo: "D1",
    lastAccountId: "ravi-slack",
  });
  const chat = dbUpsertChat({ channel: "slack", instanceId: "ravi-slack", platformChatId: "D1", chatType: "dm" });
  attachChatToSession({ sessionKey: parent.sessionKey, chatId: chat.id, role: "primary", setOutputTarget: true });
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

/** What the gateway answers to `ravi sessions create-thread` when the CLI runs inside an agent turn. */
async function createThread(body: Record<string, unknown>) {
  const result = await dispatch(
    command!,
    { session: "main-slack", ...body },
    {},
    {
      contextRecord: context,
      emitAudit: () => {},
    },
  );
  return { status: result.response.status, body: (await result.response.json()) as Record<string, any> };
}

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** A repeat tries the pending publish again, which moves the retry time; everything else must be the same. */
function withoutRetryTime(body: Record<string, any>): Record<string, any> {
  const { nextAttemptAt: _nextAttemptAt, ...rest } = body;
  return rest;
}

describe("sessions create-thread through the gateway, with the real handler", () => {
  it("answers 200 with every field the handler returns, so nothing is removed from the declared shape", async () => {
    const violations = returnContractViolationCount();

    const { status, body } = await createThread({ message: "Investigate the branch" });

    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    // The schema is strict: a field the handler returns and the schema leaves out would not parse here.
    expect(sessionCreateThreadReturnSchema.safeParse(body).error?.issues ?? []).toEqual([]);
    expect(body).toMatchObject({ status: "queued", actionId: "thread.create", origin: null, replayed: false });
    // The gateway removes an undeclared field and counts it; no field was removed.
    expect(returnContractViolationCount()).toBe(violations);
    expect(count("slack_thread_lifecycle")).toBe(1);
    // Publishing is deferred when NATS is down; the thread request still exists and the answer says so.
    expect(natsConnectAttempts).toBeGreaterThan(0);
    expect(body).toMatchObject({ publishedNow: false, publishPending: true });
  });

  it("does not turn a thread that was created into an error when the handler returns a field the schema omits", async () => {
    const original = SessionCommands.prototype.createThread;
    const handler = spyOn(SessionCommands.prototype, "createThread").mockImplementation(async function (
      this: InstanceType<typeof SessionCommands>,
      ...args: Parameters<typeof original>
    ) {
      const created = (await original.apply(this, args)) as Record<string, unknown>;
      // Typed as what the handler is declared to return: the point is a field that type does not have.
      return { ...created, undeclaredByTheSchema: { channel: "whatsapp" } } as unknown as Awaited<
        ReturnType<typeof original>
      >;
    });
    try {
      const violations = returnContractViolationCount();

      const { status, body } = await createThread({ message: "Investigate the branch" });

      // This is the incident: the thread exists, and the caller used to get a 500 "Unrecognized key" for it.
      expect(count("slack_thread_lifecycle")).toBe(1);
      expect(status).toBe(200);
      expect(body.error).toBeUndefined();
      expect(body).not.toHaveProperty("undeclaredByTheSchema");
      expect(sessionCreateThreadReturnSchema.safeParse(body).success).toBe(true);
      expect(returnContractViolationCount()).toBe(violations + 1);
    } finally {
      handler.mockRestore();
    }
  });

  it("returns the request a repeated --idempotency-key created and creates nothing the second time", async () => {
    const violations = returnContractViolationCount();

    const first = await createThread({ message: "Investigate the branch", idempotencyKey: "fix-origin" });
    const again = await createThread({ message: "Investigate the branch", idempotencyKey: "fix-origin" });

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    expect(withoutRetryTime(again.body)).toEqual({ ...withoutRetryTime(first.body), replayed: true });
    expect(sessionCreateThreadReturnSchema.safeParse(again.body).success).toBe(true);
    expect(count("slack_thread_lifecycle")).toBe(1);
    // One outbox job, whatever the number of calls: the job is keyed by the request id.
    expect(count("channel_outbound_publish_jobs")).toBe(1);
    expect(returnContractViolationCount()).toBe(violations);
  });

  it("refuses a key that already created another thread with the typed code, and creates nothing", async () => {
    await createThread({ message: "Investigate the branch", idempotencyKey: "fix-origin" });

    const reused = await createThread({ message: "Review the other branch", idempotencyKey: "fix-origin" });

    expect(reused.status).toBeGreaterThanOrEqual(400);
    expect(reused.status).toBeLessThan(500);
    expect(reused.body).toMatchObject({ success: false, error: { code: "THREAD_IDEMPOTENCY_KEY_REUSED" } });
    expect(count("slack_thread_lifecycle")).toBe(1);
    expect(count("channel_outbound_publish_jobs")).toBe(1);
  });

  it("treats the same request repeated without a key as a repeat, and another message as a new thread", async () => {
    const first = await createThread({ message: "Investigate the branch" });
    const repeat = await createThread({ message: "Investigate the branch" });
    const other = await createThread({ message: "Review the other branch" });

    expect(withoutRetryTime(repeat.body)).toEqual({ ...withoutRetryTime(first.body), replayed: true });
    expect(other.body.replayed).toBe(false);
    expect(other.body.requestId).not.toBe(first.body.requestId);
    expect(count("slack_thread_lifecycle")).toBe(2);
    expect(count("channel_outbound_publish_jobs")).toBe(2);
  });

  it("answers a repeat after the parent was renamed with the job the outbox saved, not a conflict with it", async () => {
    // The outbox fingerprints the whole request, including the name of the session that asked: a job rebuilt
    // under the new name would be refused as a different job for the same key.
    await createThread({ message: "Investigate the branch", idempotencyKey: "fix-origin" });
    renameSessionName("agent:ravi:slack:ravi-slack:D1", "main-renamed");

    const again = await createThread({
      message: "Investigate the branch",
      idempotencyKey: "fix-origin",
      session: "main-renamed",
    });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true });
    expect(count("slack_thread_lifecycle")).toBe(1);
    expect(count("channel_outbound_publish_jobs")).toBe(1);
  });
});

describe("the thread commands that follow create-thread", () => {
  it("returns, for the thread it configures, only fields its command declares", async () => {
    // The result is checked by the gateway after the change is applied, so it is checked here the same way.
    const created = await createThread({ message: "Investigate the branch" });
    const requestId = created.body.requestId as string;
    markSlackThreadRootDelivered({
      requestId,
      providerThreadId: "1713000000.000100",
      canonicalRootMessageId: `root:${requestId}`,
    });
    await finalizeSlackThreadCreation(requestId, {
      publishPrompt: async () => {},
      publishEvent: async () => {},
      publishOutbound: async () => {},
    });

    const result = configureSlackThreadRuntime(
      { parentSession: getSession("agent:ravi:slack:ravi-slack:D1")!, ref: requestId, effort: "ultra" },
      () => {},
    );

    expect(sessionThreadConfigureReturnSchema.safeParse(result).error?.issues ?? []).toEqual([]);
    expect(result).toMatchObject({ status: "configured", changed: true, thread: { requestId, status: "open" } });
  });
});
