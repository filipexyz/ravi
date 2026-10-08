import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbCreateAgent } from "../../router/router-db.js";
import { listSessions } from "../../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

afterAll(() => mock.restore());

type BusEvent = { topic: string; data: unknown };

interface TopicChannel {
  push(event: BusEvent): void;
  close(): void;
}

const channels = new Map<string, TopicChannel>();
const subscribedTopics: string[] = [];
const publishCalls: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

function createTopicStream(topic: string): AsyncIterableIterator<BusEvent> {
  const queue: BusEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  channels.set(topic, {
    push(event) {
      queue.push(event);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
  });
  const stream: AsyncIterableIterator<BusEvent> = {
    async next() {
      while (!closed && queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const value = queue.shift();
      return value ? { value, done: false } : { value: undefined, done: true };
    },
    async return() {
      closed = true;
      notify();
      return { value: undefined, done: true };
    },
    [Symbol.asyncIterator]() {
      return stream;
    },
  };
  return stream;
}

const actualNatsModule = await import("../../nats.js");
const actualSessionStreamModule = await import("../../omni/session-stream.js");

mock.module("../../nats.js", () => ({
  ...actualNatsModule,
  publish: mock(async () => {}),
  nats: {
    emit: mock(async () => {}),
    subscribe: mock((topic: string) => {
      subscribedTopics.push(topic);
      return createTopicStream(topic);
    }),
    close: mock(async () => {}),
  },
}));

mock.module("../../omni/session-stream.js", () => ({
  ...actualSessionStreamModule,
  publishSessionPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
    publishCalls.push({ sessionName, payload });
  }),
}));

const { TriggerRunner } = await import("../runner.js");
const { dbCreateTrigger, dbGetTrigger, dbUpdateTrigger } = await import("../triggers-db.js");

let stateDir: string | null = null;
let markerDir: string | null = null;
let runner: InstanceType<typeof TriggerRunner> | null = null;

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emit(topic: string, data: unknown): void {
  const channel = channels.get(topic);
  if (!channel) throw new Error(`Runner is not subscribed to ${topic}`);
  channel.push({ topic, data });
}

function markerPath(): string {
  return join(markerDir!, "shell-fired.log");
}

function firedShellTriggerIds(): string[] {
  if (!existsSync(markerPath())) return [];
  return readFileSync(markerPath(), "utf8").split("\n").filter(Boolean);
}

function createTrigger(input: { name: string; topic: string; filter?: string; executionType?: "agent" | "shell" }) {
  const shell = input.executionType === "shell";
  return dbCreateTrigger({
    name: input.name,
    agentId: "trigger-test-agent",
    topic: input.topic,
    message: shell ? "" : `agent prompt for ${input.name}`,
    executionType: shell ? "shell" : "agent",
    shellCommand: shell ? `printf '%s\\n' "$RAVI_TRIGGER_ID" >> '${markerPath()}'` : undefined,
    shellTimeoutMs: shell ? 10_000 : undefined,
    session: "isolated",
    cooldownMs: 0,
    filter: input.filter,
  });
}

async function startRunner(): Promise<InstanceType<typeof TriggerRunner>> {
  runner = new TriggerRunner();
  await runner.start();
  return runner;
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trigger-runner-filter-test-");
  dbCreateAgent({ id: "trigger-test-agent", cwd: "/tmp/trigger-test-agent-real" });
  markerDir = mkdtempSync(join(tmpdir(), "ravi-trigger-shell-marker-"));
  channels.clear();
  subscribedTopics.length = 0;
  publishCalls.length = 0;
});

afterEach(async () => {
  await runner?.stop();
  runner = null;
  for (const channel of channels.values()) channel.close();
  channels.clear();
  if (markerDir) rmSync(markerDir, { recursive: true, force: true });
  markerDir = null;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("TriggerRunner invalid filters fail closed", () => {
  it("does not subscribe to a topic whose only trigger has an invalid filter", async () => {
    const invalid = createTrigger({
      name: "legacy-shell",
      topic: "ravi.test.invalid-only",
      filter: "data.branch == main",
      executionType: "shell",
    });

    await startRunner();

    expect(subscribedTopics).toContain("ravi.triggers.refresh");
    expect(subscribedTopics).not.toContain("ravi.test.invalid-only");
    expect(dbGetTrigger(invalid.id)?.fireCount).toBe(0);
    expect(firedShellTriggerIds()).toEqual([]);
  });

  it("keeps valid filters filtering while an invalid-filter sibling never fires (agent + shell)", async () => {
    const topic = "ravi.test.shared";
    const validAgent = createTrigger({ name: "valid-agent", topic, filter: `data.kind == "match"` });
    const validShell = createTrigger({
      name: "valid-shell",
      topic,
      filter: `data.kind == "match"`,
      executionType: "shell",
    });
    const invalidShell = createTrigger({
      name: "invalid-shell",
      topic,
      filter: "data.kind == match",
      executionType: "shell",
    });
    const invalidAgent = createTrigger({ name: "invalid-agent", topic, filter: "data.kind contains match" });

    await startRunner();
    expect(subscribedTopics).toContain(topic);

    emit(topic, { kind: "other", eventId: "evt-no-match" });
    emit(topic, { kind: "match", eventId: "evt-match" });

    await waitFor(() => publishCalls.length >= 1 && firedShellTriggerIds().length >= 1);
    await waitFor(() => (dbGetTrigger(validShell.id)?.fireCount ?? 0) >= 1);
    // Both events were evaluated in order in one loop; give any stray dispatch time to land.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(publishCalls.map((call) => call.payload._triggerId)).toEqual([validAgent.id]);
    expect(String(publishCalls[0]?.payload.prompt)).toContain("evt-match");
    expect(firedShellTriggerIds()).toEqual([validShell.id]);
    expect(dbGetTrigger(validAgent.id)?.fireCount).toBe(1);
    expect(dbGetTrigger(validShell.id)?.fireCount).toBe(1);
    expect(dbGetTrigger(invalidShell.id)?.fireCount).toBe(0);
    expect(dbGetTrigger(invalidAgent.id)?.fireCount).toBe(0);
  });

  it("activates the trigger once its filter is fixed and the runner refreshes", async () => {
    const topic = "ravi.test.recover";
    const trigger = createTrigger({ name: "recoverable", topic, filter: "data.kind == match" });

    await startRunner();
    expect(subscribedTopics).not.toContain(topic);

    dbUpdateTrigger(trigger.id, { filter: `data.kind == "match"` });
    emit("ravi.triggers.refresh", {});
    await waitFor(() => channels.has(topic));

    emit(topic, { kind: "match", eventId: "evt-after-fix" });
    await waitFor(() => publishCalls.length === 1);
    expect(publishCalls[0]?.payload._triggerId).toBe(trigger.id);
  });

  it("drops a subscribed trigger on refresh when its persisted filter becomes invalid", async () => {
    const topic = "ravi.test.regress";
    const trigger = createTrigger({ name: "regressed", topic, filter: `data.kind == "match"` });

    await startRunner();
    expect(subscribedTopics).toContain(topic);

    dbUpdateTrigger(trigger.id, { filter: "data.kind == match" });
    emit("ravi.triggers.refresh", {});
    await waitFor(() => (runner as unknown as { topicSubs: Map<string, unknown> }).topicSubs.size === 0);

    expect(publishCalls).toEqual([]);
    expect(dbGetTrigger(trigger.id)?.fireCount).toBe(0);
  });
});

describe("TriggerRunner filter reject diagnostics", () => {
  it("counts rejected events per trigger and leaves matching siblings untouched", async () => {
    const topic = "message.received.whatsapp-baileys.inst-1";
    const wrongPath = createTrigger({ name: "wrong-path", topic, filter: `data.payload.chatUuid == "chat-1"` });
    const rightPath = createTrigger({
      name: "right-path",
      topic,
      filter: `data.payload.chatId == "123@s.whatsapp.net"`,
    });

    await startRunner();
    emit(topic, { id: "evt-1", type: "message.received", payload: { chatId: "123@s.whatsapp.net" }, metadata: {} });
    emit(topic, { id: "evt-2", type: "message.received", payload: { chatId: "123@s.whatsapp.net" }, metadata: {} });
    await waitFor(() => publishCalls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(dbGetTrigger(wrongPath.id)?.filterRejectCount).toBeUndefined();
    await runner?.stop();

    const rejected = dbGetTrigger(wrongPath.id);
    expect(rejected?.fireCount).toBe(0);
    expect(rejected?.filterRejectCount).toBe(2);
    expect(rejected?.lastFilterRejectAt).toBeGreaterThan(0);
    expect(dbGetTrigger(rightPath.id)?.filterRejectCount).toBeUndefined();
  });

  it("resets the counters when the filter changes and ignores a late flush for the old filter", async () => {
    const topic = "ravi.test.reject-reset";
    const trigger = createTrigger({ name: "reset", topic, filter: `data.kind == "match"` });

    await startRunner();
    emit(topic, { kind: "other", eventId: "evt-a" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Edited before the runner flushes: the stale batch must not land on the new filter.
    dbUpdateTrigger(trigger.id, { filter: `data.kind == "other"` });
    await runner?.stop();
    expect(dbGetTrigger(trigger.id)?.filterRejectCount).toBeUndefined();
    expect(dbGetTrigger(trigger.id)?.lastFilterRejectAt).toBeUndefined();
  });
});

describe("page comment wake", () => {
  it("wakes the bound creator and does not open a session for a deleted agent", async () => {
    const { ensurePageCommentTrigger, pageCommentFilter } = await import("../../pages/comment-follow.js");
    const { watchEventFromInboxPayload } = await import("../../watch/events.js");
    dbCreateAgent({ id: "page-creator", cwd: "/tmp/page-creator-home" });
    const live = await ensurePageCommentTrigger(
      { pageId: "site_live", orgId: "org_1", projectId: "proj_1" },
      { agentId: "page-creator" },
      { emitTriggersRefresh: async () => {}, agentExists: () => true },
    );
    const gone = await ensurePageCommentTrigger(
      { pageId: "site_gone", orgId: "org_1", projectId: "proj_1" },
      { agentId: "gone-creator" },
      { emitTriggersRefresh: async () => {}, agentExists: () => false },
    );
    if (!live.ok || !gone.ok) throw new Error("expected both triggers to persist");

    await startRunner();

    const topic = "ravi.watch.console.page.comment.created";
    expect(subscribedTopics).toContain(topic);
    const liveEvent = watchEventFromInboxPayload(pageCommentInbox("site_live", "ship the chart"));
    const goneEvent = watchEventFromInboxPayload(pageCommentInbox("site_gone", "ghost"));
    const otherEvent = watchEventFromInboxPayload(pageCommentInbox("site_other", "nope"));
    if (!liveEvent || !goneEvent || !otherEvent) throw new Error("expected watch events");

    emit(topic, goneEvent);
    emit(topic, otherEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(publishCalls).toEqual([]);
    expect(
      listSessions().some(
        (session) => session.agentId === "gone-creator" || session.agentCwd.includes("/tmp/ravi-gone"),
      ),
    ).toBe(false);

    emit(topic, liveEvent);
    await waitFor(() => publishCalls.length === 1);
    expect(publishCalls[0]?.payload._triggerId).toBe(live.trigger.id);
    expect(String(publishCalls[0]?.payload.prompt)).toContain("ship the chart");
    expect(String(publishCalls[0]?.payload.prompt).includes("Data:")).toBe(false);
    expect(
      listSessions().some(
        (session) => session.agentId === "page-creator" && session.agentCwd === "/tmp/page-creator-home",
      ),
    ).toBe(true);
    expect(listSessions().some((session) => session.agentCwd.includes("/tmp/ravi-"))).toBe(false);
    expect(live.trigger.filter).toBe(pageCommentFilter({ pageId: "site_live", orgId: "org_1", projectId: "proj_1" }));
  });
});

function pageCommentInbox(pageId: string, body: string) {
  return {
    version: 1 as const,
    eventId: `item_${pageId}`,
    sequence: 1,
    dedupeKey: `page-comment:${pageId}`,
    eventType: "page.comment.created",
    category: "pages",
    severity: "info",
    sensitivity: "private",
    title: "Comment",
    summary: body,
    organization: { id: "org_1" },
    project: { id: "proj_1" },
    source: { type: "console" },
    actor: { type: "user", id: "user_1" },
    target: { type: "page", id: pageId },
    payload: { pageId, orgId: "org_1", projectId: "proj_1", body, url: `https://${pageId}.ravi.page/` },
    links: [],
    delivery: {
      subscriptionId: "sub_1",
      installationId: "ins_1",
      pollId: "poll_1",
      leaseId: "lease_1",
      localDeliveredAt: "2026-09-26T00:00:00.000Z",
    },
    occurredAt: "2026-09-26T00:00:00.000Z",
    createdAt: "2026-09-26T00:00:00.000Z",
  };
}

describe("TriggerRunner main-session reply routing", () => {
  it("replies where the main session last talked when no reply session is set", async () => {
    const { getOrCreateSession, updateSessionSource } = await import("../../router/sessions.js");
    getOrCreateSession("agent:trigger-test-agent:main", "trigger-test-agent", "/tmp/trigger-test-agent-real", {
      name: "trigger-main",
    });
    updateSessionSource("agent:trigger-test-agent:main", {
      channel: "whatsapp",
      accountId: "main-account",
      chatId: "chat-a",
    });
    const topic = "ravi.test.main-reply";
    const trigger = dbCreateTrigger({
      name: "main-no-reply-session",
      agentId: "trigger-test-agent",
      topic,
      message: "agent prompt",
      session: "main",
      cooldownMs: 0,
    });
    expect(trigger.replySession).toBeUndefined();

    await startRunner();
    emit(topic, { eventId: "evt-main" });
    await waitFor(() => publishCalls.length >= 1);

    expect(publishCalls[0]?.sessionName).toBe("trigger-main");
    expect(publishCalls[0]?.payload.source).toEqual({
      channel: "whatsapp",
      accountId: "main-account",
      chatId: "chat-a",
    });
  });
});
