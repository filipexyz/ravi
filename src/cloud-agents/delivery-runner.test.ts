import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { InboxNatsPayload } from "../inbox/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  dbBindCloudThreadRun,
  dbGetActiveCloudThreadByKey,
  dbGetCloudChatApproval,
  dbGetCloudDeliveryItem,
  dbPendingCloudChatQuestion,
} from "./chat-db.js";
import type { CloudChatTarget } from "./chat-target.js";
import { acceptCloudInboxItem, CLOUD_DELIVERY_MAX_ATTEMPTS, CloudDeliveryRunner } from "./delivery-runner.js";
import {
  createFakeCloudConsole,
  type FakeCloudConsole,
  fakeCloudRun,
  fakeCloudSessionOpener,
} from "./test-fixtures.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-cloud-delivery-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const DELIVERY = { kind: "session", installationId: "inst-1", sessionName: "dev-main" };
const WHATSAPP_CHAT: CloudChatTarget = {
  channel: "whatsapp",
  accountId: "wa-main",
  instanceId: "inst-wa",
  chatId: "5511999999999@s.whatsapp.net",
};
const SLACK_CHAT: CloudChatTarget = {
  channel: "slack",
  accountId: "slack-main",
  instanceId: "slack-main",
  chatId: "C0ABC",
};

let itemSeq = 0;

function inboxItem(eventType: string, payload: Record<string, unknown>, overrides: Partial<InboxNatsPayload> = {}) {
  itemSeq += 1;
  return {
    version: 1,
    eventId: `item_${itemSeq}`,
    sequence: itemSeq,
    dedupeKey: `key_${itemSeq}`,
    eventType,
    category: "cloud_agents",
    severity: "info",
    sensitivity: "customer_data",
    title: null,
    summary: null,
    organization: { id: "org-1" },
    project: { id: "p-clinica" },
    source: { type: "cloud_agents", id: "run_1" },
    actor: { type: "system", id: null },
    target: { type: "local_installation", id: "inst-1" },
    payload: { delivery: DELIVERY, runId: "run_1", agentName: "triage", projectId: "p-clinica", ...payload },
    links: null,
    delivery: {
      subscriptionId: "sub-1",
      installationId: "inst-1",
      pollId: "poll-1",
      leaseId: null,
      localDeliveredAt: "2026-10-23T10:00:00.000Z",
    },
    occurredAt: "2026-10-23T10:00:00.000Z",
    createdAt: "2026-10-23T10:00:00.000Z",
    ...overrides,
  } satisfies InboxNatsPayload;
}

interface SetupOptions {
  chat?: CloudChatTarget | null;
  contact?: string | null;
  slackUsers?: string[];
  personWroteFirst?: boolean;
  taskRuns?: string[];
  informFails?: () => boolean;
  deliverFails?: () => boolean;
  loggedIn?: boolean;
}

function setup(fake: FakeCloudConsole, options: SetupOptions = {}) {
  let offset = 0;
  const informs: Array<{ session: string; prompt: string; messageId: string }> = [];
  const sent: Array<{ target: CloudChatTarget; message: Record<string, unknown> }> = [];
  const cards: Array<{ threadKey: string; status: string; summary: string | null }> = [];
  const runner = new CloudDeliveryRunner({
    openSession: fakeCloudSessionOpener(fake, { loggedIn: options.loggedIn }),
    now: () => Date.now() + offset,
    resolveSessionName: (name) => (name === "missing" ? null : name),
    informSession: async (session, prompt, messageId) => {
      if (options.informFails?.()) throw new Error("NATS down");
      informs.push({ session, prompt, messageId });
    },
    resolveSessionChat: () => (options.chat === undefined ? WHATSAPP_CHAT : options.chat),
    deliverToChat: async (target, message) => {
      if (options.deliverFails?.()) throw new Error("gateway down");
      sent.push({ target, message: message as Record<string, unknown> });
      return { messageId: "msg-1", deliveries: [] };
    },
    personWroteFirst: () => options.personWroteFirst ?? true,
    resolveActorContact: async () => (options.contact === undefined ? "contact-ana" : options.contact),
    slackUserIdsForContact: () => options.slackUsers ?? [],
    contactName: () => "Ana Local",
    updateRunCard: async (thread, update) => {
      cards.push({ threadKey: thread.threadKey, ...update });
    },
    isTaskRun: (runId) => options.taskRuns?.includes(runId) ?? false,
  });
  return {
    runner,
    informs,
    sent,
    cards,
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

const RESULT = {
  status: "completed",
  costUsd: 0.08,
  costBrl: 0.42,
  result: "Três tickets abertos.",
  outputs: [{ id: "out_1", name: "report.md", size: 10 }],
  url: "https://console.example/run_1",
};

describe("acceptCloudInboxItem", () => {
  it("records a session delivery once and ignores everything else", () => {
    const item = inboxItem("cloud_agents.run.result", RESULT);
    expect(acceptCloudInboxItem(item)).toBe("recorded");
    expect(acceptCloudInboxItem(item)).toBe("duplicate");
    expect(dbGetCloudDeliveryItem(item.eventId)).toMatchObject({ runId: "run_1", sessionName: "dev-main" });
    // The user-targeted notification of the same type carries no delivery.
    expect(acceptCloudInboxItem(inboxItem("cloud_agents.approval.requested", { delivery: null }))).toBe("ignored");
    expect(acceptCloudInboxItem(inboxItem("cloud_agents.run.ended", {}))).toBe("ignored");
    expect(acceptCloudInboxItem(inboxItem("cloud_agents.run.result", {}, { category: "mail" }))).toBe("ignored");
    expect(acceptCloudInboxItem(inboxItem("cloud_agents.run.result", { delivery: { kind: "none" } }))).toBe("ignored");
  });
});

describe("CloudDeliveryRunner", () => {
  it("run.result: informs the session with the cost line, then acknowledges once", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ status: "completed" })] });
    const { runner, informs } = setup(fake);
    const item = inboxItem("cloud_agents.run.result", RESULT);
    acceptCloudInboxItem(item);
    const first = await runner.tickOnce();
    expect(first).toMatchObject({ status: "ran", processed: 1, done: 1 });
    expect(informs).toHaveLength(1);
    expect(informs[0]).toMatchObject({ session: "dev-main", messageId: `cloud-delivery:${item.eventId}` });
    expect(informs[0]!.prompt).toContain("Esta run custou R$ 0,42 (US$ 0,08).");
    expect(informs[0]!.prompt).toContain("report.md");
    expect(fake.writes().map((request) => [request.path, request.body])).toEqual([
      ["/runs/run_1/delivered", { kind: "result" }],
    ]);
    expect(dbGetCloudDeliveryItem(item.eventId)?.state).toBe("done");
    // Idempotent: the same item again, or another pass, delivers nothing more.
    expect(acceptCloudInboxItem(item)).toBe("duplicate");
    expect(await runner.tickOnce()).toMatchObject({ status: "idle", processed: 0 });
    expect(informs).toHaveLength(1);
  });

  it("run.result: only US$ when the Console has no rate", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ status: "completed" })] });
    const { runner, informs } = setup(fake);
    acceptCloudInboxItem(inboxItem("cloud_agents.run.result", { ...RESULT, costBrl: null }));
    await runner.tickOnce();
    expect(informs[0]!.prompt).toContain("Esta run custou US$ 0,08.");
  });

  it("run.result: a failed acknowledgement retries the acknowledgement only", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ status: "completed" })] });
    fake.failures.push({ path: "/runs/run_1/delivered", status: 500, body: { error: { code: "x" } }, times: 1 });
    const { runner, informs, advance } = setup(fake);
    const item = inboxItem("cloud_agents.run.result", RESULT);
    acceptCloudInboxItem(item);
    expect(await runner.tickOnce()).toMatchObject({ retried: 1 });
    expect(dbGetCloudDeliveryItem(item.eventId)).toMatchObject({ state: "pending", attempts: 1 });
    advance(60_000);
    expect(await runner.tickOnce()).toMatchObject({ done: 1 });
    expect(informs).toHaveLength(1);
    expect(fake.writes().filter((request) => request.path === "/runs/run_1/delivered")).toHaveLength(2);
  });

  it("task runs keep the task watcher: no inform and no acknowledgement", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ status: "completed" })] });
    const { runner, informs } = setup(fake, { taskRuns: ["run_1"] });
    const result = inboxItem("cloud_agents.run.result", RESULT);
    const approval = inboxItem("cloud_agents.approval.requested", { approvalId: "ap_1", tool: "create_issue" });
    acceptCloudInboxItem(result);
    acceptCloudInboxItem(approval);
    expect(await runner.tickOnce()).toMatchObject({ skipped: 2 });
    expect(informs).toHaveLength(0);
    expect(fake.writes()).toHaveLength(0);
  });

  it("an event for another installation, or a missing session, is not delivered", async () => {
    const fake = createFakeCloudConsole();
    const { runner, informs } = setup(fake);
    const other = inboxItem("cloud_agents.run.result", {
      ...RESULT,
      delivery: { ...DELIVERY, installationId: "inst-9" },
    });
    const missing = inboxItem("cloud_agents.run.result", {
      ...RESULT,
      delivery: { ...DELIVERY, sessionName: "missing" },
    });
    acceptCloudInboxItem(other);
    acceptCloudInboxItem(missing);
    expect(await runner.tickOnce()).toMatchObject({ skipped: 1, failed: 1 });
    expect(informs).toHaveLength(0);
    expect(dbGetCloudDeliveryItem(missing.eventId)?.lastError).toContain("not found");
  });

  it("without a login nothing is claimed", async () => {
    const fake = createFakeCloudConsole();
    const { runner } = setup(fake, { loggedIn: false });
    const item = inboxItem("cloud_agents.run.result", RESULT);
    acceptCloudInboxItem(item);
    expect(await runner.tickOnce()).toMatchObject({ status: "skipped", reason: "no_login" });
    expect(dbGetCloudDeliveryItem(item.eventId)).toMatchObject({ state: "pending", attempts: 0 });
  });

  it("gives up after the last attempt", async () => {
    const fake = createFakeCloudConsole();
    const { runner, advance } = setup(fake, { informFails: () => true });
    const item = inboxItem("cloud_agents.run.result", RESULT);
    acceptCloudInboxItem(item);
    for (let attempt = 0; attempt < CLOUD_DELIVERY_MAX_ATTEMPTS; attempt += 1) {
      await runner.tickOnce();
      advance(60 * 60_000);
    }
    expect(dbGetCloudDeliveryItem(item.eventId)).toMatchObject({ state: "failed", lastError: "NATS down" });
  });

  it("approval on Slack: a private card to the person's Slack user, and the session is told", async () => {
    const fake = createFakeCloudConsole();
    const { runner, informs, sent } = setup(fake, { chat: SLACK_CHAT, slackUsers: ["U0ANA"] });
    acceptCloudInboxItem(
      inboxItem("cloud_agents.approval.requested", {
        approvalId: "ab12cd34-ffff",
        tool: "create_issue",
        server: "github",
        inputPreview: '{"title":"Fix"}',
        actorUserId: "user-ana",
        actorContact: { name: "Ana", email: "ana@example.test" },
      }),
    );
    await runner.tickOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toEqual(SLACK_CHAT);
    expect(sent[0]!.message.privateTo).toEqual(["U0ANA"]);
    expect(JSON.stringify(sent[0]!.message.blocks)).toContain("ravi.cloud.approval.v1.approve");
    expect(informs[0]!.prompt).toContain("Só Ana pode decidir");
    expect(informs[0]!.prompt).toContain("botões Aprovar e Negar");
    expect(dbGetCloudChatApproval("ab12cd34-ffff")).toMatchObject({
      code: "ab12cd",
      actorContactId: "contact-ana",
      actorName: "Ana",
      status: "pending",
    });
  });

  it("approval on WhatsApp asks for the reply code; a card that fails falls back to it too", async () => {
    const fake = createFakeCloudConsole();
    const whatsapp = setup(fake);
    acceptCloudInboxItem(inboxItem("cloud_agents.approval.requested", { approvalId: "ff00aa11", tool: "send_mail" }));
    await whatsapp.runner.tickOnce();
    expect(whatsapp.sent).toHaveLength(0);
    expect(whatsapp.informs[0]!.prompt).toContain("`aprovar ff00aa` ou `negar ff00aa`");
    // The Console gave no name: the local contact's.
    expect(whatsapp.informs[0]!.prompt).toContain("Só Ana Local pode decidir");

    const slack = setup(fake, { chat: SLACK_CHAT, slackUsers: ["U0ANA"], deliverFails: () => true });
    acceptCloudInboxItem(inboxItem("cloud_agents.approval.requested", { approvalId: "ee00aa11", tool: "send_mail" }));
    await slack.runner.tickOnce();
    expect(slack.informs[0]!.prompt).toContain("`aprovar ee00aa`");
  });

  it("approval without a linked person: the decision stays in the Console", async () => {
    const fake = createFakeCloudConsole();
    const { runner, informs } = setup(fake, { contact: null });
    acceptCloudInboxItem(inboxItem("cloud_agents.approval.requested", { approvalId: "dd00aa11", tool: "send_mail" }));
    await runner.tickOnce();
    expect(informs[0]!.prompt).toContain("a decisão fica no Console");
    expect(dbGetCloudChatApproval("dd00aa11")?.actorContactId).toBeNull();
  });

  it("question: the session asks the person, with the options and the answer command", async () => {
    const fake = createFakeCloudConsole();
    const { runner, informs } = setup(fake);
    acceptCloudInboxItem(
      inboxItem("cloud_agents.question.asked", {
        questionId: "q_1",
        question: "Qual fila?",
        options: ["Suporte", "Vendas"],
        actorUserId: "user-ana",
      }),
    );
    await runner.tickOnce();
    expect(informs[0]!.prompt).toContain('ravi cloud runs answer run_1 q_1 "<resposta>" --execute');
    expect(informs[0]!.prompt).toContain("2. Vendas");
    expect(dbPendingCloudChatQuestion("run_1")).toMatchObject({ questionId: "q_1", actorContactId: "contact-ana" });
  });

  it("delivery.message: into the session's chat, only where a person wrote first on WhatsApp", async () => {
    const fake = createFakeCloudConsole();
    const ok = setup(fake);
    const item = inboxItem("cloud_agents.delivery.message", { text: "O relatório está pronto." });
    acceptCloudInboxItem(item);
    await ok.runner.tickOnce();
    expect(ok.sent).toEqual([{ target: WHATSAPP_CHAT, message: { text: "O relatório está pronto." } }]);
    expect(ok.informs).toHaveLength(0);

    const cold = setup(fake, { personWroteFirst: false });
    const refused = inboxItem("cloud_agents.delivery.message", { text: "Oi" });
    acceptCloudInboxItem(refused);
    await cold.runner.tickOnce();
    expect(cold.sent).toHaveLength(0);
    expect(dbGetCloudDeliveryItem(refused.eventId)).toMatchObject({ state: "failed" });

    const none = setup(fake, { chat: null });
    const nowhere = inboxItem("cloud_agents.delivery.message", { text: "Oi" });
    acceptCloudInboxItem(nowhere);
    await none.runner.tickOnce();
    expect(dbGetCloudDeliveryItem(nowhere.eventId)?.lastError).toBe("the session has no chat");
  });

  it("run.thread: updates the card; the binding ends with the run", async () => {
    const fake = createFakeCloudConsole();
    const { runner, cards } = setup(fake);
    const key = "slack:slack-main:C0ABC:1712345678.123456";
    dbBindCloudThreadRun({
      threadKey: key,
      runId: "run_1",
      channel: "slack",
      accountId: "slack-main",
      instanceId: "slack-main",
      chatId: "C0ABC",
      threadTs: "1712345678.123456",
      sessionName: "dev-main",
      agentName: "triage",
      promptSummary: "Resume",
      actorUserId: "user-ana",
      actorContactId: "contact-ana",
      actorName: "Ana",
      cardMessageId: "1712345678.999999",
      status: "starting",
    });
    acceptCloudInboxItem(
      inboxItem("cloud_agents.run.thread", { threadKey: key, status: "running", summary: "Running." }),
    );
    await runner.tickOnce();
    expect(cards).toEqual([{ threadKey: key, status: "running", summary: "Running." }]);
    expect(dbGetActiveCloudThreadByKey(key)?.status).toBe("running");

    acceptCloudInboxItem(
      inboxItem("cloud_agents.run.thread", { threadKey: key, status: "completed", summary: "Feito." }),
    );
    await runner.tickOnce();
    expect(cards.at(-1)).toEqual({ threadKey: key, status: "completed", summary: "Feito." });
    expect(dbGetActiveCloudThreadByKey(key)).toBeNull();

    // A late update never reopens the card.
    acceptCloudInboxItem(inboxItem("cloud_agents.run.thread", { threadKey: key, status: "running", summary: null }));
    expect(await runner.tickOnce()).toMatchObject({ skipped: 1 });
    expect(cards).toHaveLength(2);
  });
});
