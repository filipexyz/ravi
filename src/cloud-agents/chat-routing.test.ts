import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  dbBindCloudThreadRun,
  dbGetActiveCloudThreadByKey,
  CLOUD_CHAT_APPROVAL_CLAIM_TTL_MS,
  dbClaimCloudChatApproval,
  dbGetCloudChatApproval,
  dbMarkCloudChatApprovalCardSent,
  dbPendingCloudChatQuestion,
  dbRecordCloudChatApproval,
  dbRecordCloudChatQuestion,
} from "./chat-db.js";
import {
  type CloudChatInbound,
  handleCloudApprovalClick,
  interceptCloudChatMessage,
  routeCloudChatMessage,
} from "./chat-routing.js";
import {
  createFakeCloudConsole,
  type FakeCloudConsole,
  fakeCloudApproval,
  fakeCloudRun,
  fakeCloudSessionOpener,
} from "./test-fixtures.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-cloud-chat-routing-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const APPROVAL_ID = "ab12cd34-0000-4000-8000-000000000001";

function waitingRun(): FakeCloudConsole {
  return createFakeCloudConsole({
    runs: [fakeCloudRun({ status: "waiting_approval", approvals: [fakeCloudApproval({ id: APPROVAL_ID })] })],
  });
}

function recordApproval(actorContactId: string | null = "contact-ana") {
  dbRecordCloudChatApproval({
    approvalId: APPROVAL_ID,
    runId: "run_1",
    sessionName: "dev-main",
    agentName: "triage",
    tool: "create_issue",
    actorUserId: "user-ana",
    actorContactId,
    actorName: "Ana",
  });
}

describe("cloud chat approvals table", () => {
  it("adds the card marker to a table an earlier build created", () => {
    getDb().exec(`CREATE TABLE cloud_chat_approvals (
      approval_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, code TEXT NOT NULL, session_name TEXT, agent_name TEXT,
      tool TEXT NOT NULL, actor_user_id TEXT, actor_contact_id TEXT, actor_name TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, decided_at INTEGER
    )`);
    recordApproval();
    expect(dbGetCloudChatApproval(APPROVAL_ID)?.cardSentAt).toBeNull();
    dbMarkCloudChatApprovalCardSent(APPROVAL_ID, 1234);
    expect(dbGetCloudChatApproval(APPROVAL_ID)?.cardSentAt).toBe(1234);
  });
});

function whatsapp(text: string, overrides: Partial<CloudChatInbound> = {}): CloudChatInbound {
  return {
    channel: "whatsapp-baileys",
    accountId: "wa-main",
    instanceId: "inst-wa",
    chatId: "5511999999999@s.whatsapp.net",
    isGroup: false,
    contactId: "contact-ana",
    text,
    ...overrides,
  };
}

const SLACK_KEY = "slack:slack-main:C0ABC:1712345678.123456";
const GROUP = "120363012345678901@g.us";
const WHATSAPP_KEY = `whatsapp:inst-wa:${GROUP}`;

function bind(channel: "slack" | "whatsapp", runId = "run_1") {
  return dbBindCloudThreadRun({
    threadKey: channel === "slack" ? SLACK_KEY : WHATSAPP_KEY,
    runId,
    channel,
    accountId: channel === "slack" ? "slack-main" : "wa-main",
    instanceId: channel === "slack" ? "slack-main" : "inst-wa",
    chatId: channel === "slack" ? "C0ABC" : GROUP,
    threadTs: channel === "slack" ? "1712345678.123456" : null,
    sessionName: "dev-main",
    agentName: "triage",
    promptSummary: "Resume",
    actorUserId: "user-ana",
    actorContactId: "contact-ana",
    actorName: "Ana",
    cardMessageId: channel === "slack" ? "1712345679.000001" : "wa-card-1",
    status: "running",
  });
}

describe("approval codes typed in chat", () => {
  it("the run's person approves as their own contact", async () => {
    const fake = waitingRun();
    recordApproval();
    const result = await routeCloudChatMessage(whatsapp("aprovar AB12CD"), {
      openSession: fakeCloudSessionOpener(fake),
    });
    expect(result).toEqual({ handled: true, kind: "approval", reply: "Aprovado: create_issue na run run_1." });
    expect(fake.writes()).toHaveLength(1);
    expect(fake.writes()[0]).toMatchObject({
      path: `/runs/run_1/approvals/${APPROVAL_ID}`,
      body: { decision: "approve" },
      actorContact: "contact-ana",
    });
    expect(dbGetCloudChatApproval(APPROVAL_ID)?.status).toBe("approved");
    // Decided once: the same reply again is no longer a pending code.
    expect(
      await routeCloudChatMessage(whatsapp("aprovar ab12cd"), { openSession: fakeCloudSessionOpener(fake) }),
    ).toEqual({ handled: false });
  });

  it("deny carries the reason", async () => {
    const fake = waitingRun();
    recordApproval();
    const result = await routeCloudChatMessage(whatsapp("negar ab12cd, não agora"), {
      openSession: fakeCloudSessionOpener(fake),
    });
    expect(result).toMatchObject({ handled: true, reply: "Negado: create_issue na run run_1." });
    expect(fake.writes()[0]!.body).toEqual({ decision: "deny", reason: "não agora" });
  });

  it("from anyone else, an unknown code or an unlinked person, the message goes to the agent", async () => {
    const fake = waitingRun();
    recordApproval();
    const opener = fakeCloudSessionOpener(fake);
    expect(
      await routeCloudChatMessage(whatsapp("aprovar ab12cd", { contactId: "contact-bob" }), { openSession: opener }),
    ).toEqual({ handled: false });
    expect(await routeCloudChatMessage(whatsapp("aprovar ffffff"), { openSession: opener })).toEqual({
      handled: false,
    });
    expect(
      await routeCloudChatMessage(whatsapp("aprovar ab12cd", { contactId: null }), { openSession: opener }),
    ).toEqual({
      handled: false,
    });
    expect(fake.writes()).toHaveLength(0);
    expect(dbGetCloudChatApproval(APPROVAL_ID)?.status).toBe("pending");
  });

  it("a claim a stopped Ravi left behind opens again after a while", async () => {
    const fake = waitingRun();
    recordApproval();
    const claimedAt = Date.now();
    expect(dbClaimCloudChatApproval(APPROVAL_ID, claimedAt)).toBe(true);
    // Mid-decision: another answer cannot take it.
    const opener = fakeCloudSessionOpener(fake);
    expect(await routeCloudChatMessage(whatsapp("aprovar ab12cd"), { openSession: opener })).toEqual({
      handled: false,
    });
    // Ravi restarted before recording the decision: later the person can answer again.
    const later = () => claimedAt + CLOUD_CHAT_APPROVAL_CLAIM_TTL_MS + 1;
    const result = await routeCloudChatMessage(whatsapp("aprovar ab12cd"), { openSession: opener, now: later });
    expect(result).toMatchObject({ handled: true, kind: "approval" });
    expect(dbGetCloudChatApproval(APPROVAL_ID)?.status).toBe("approved");
  });

  it("a decision the Console refuses reopens the approval and tells why", async () => {
    const fake = waitingRun();
    fake.failures.push({
      path: `/runs/run_1/approvals/${APPROVAL_ID}`,
      status: 500,
      body: { error: { code: "internal", message: "boom" } },
      times: 1,
    });
    recordApproval();
    const result = await routeCloudChatMessage(whatsapp("aprovar ab12cd"), {
      openSession: fakeCloudSessionOpener(fake),
    });
    expect(result).toMatchObject({ handled: true, kind: "approval" });
    expect((result as { reply: string }).reply).toContain("Não consegui registrar a decisão");
    expect(dbGetCloudChatApproval(APPROVAL_ID)?.status).toBe("pending");
  });

  it("interceptCloudChatMessage sends the reply in the chat and keeps the message from the agent", async () => {
    const fake = waitingRun();
    recordApproval();
    const replies: string[] = [];
    const handled = await interceptCloudChatMessage(
      whatsapp("aprovar ab12cd"),
      async (text) => {
        replies.push(text);
      },
      { openSession: fakeCloudSessionOpener(fake) },
    );
    expect(handled).toBe(true);
    expect(replies).toEqual(["Aprovado: create_issue na run run_1."]);
    expect(await interceptCloudChatMessage(whatsapp("bom dia"), async () => {})).toBe(false);
  });
});

describe("Slack approval card clicks", () => {
  function click(userId: string, actionId = "ravi.cloud.approval.v1.approve") {
    return {
      provider: "slack",
      actionId,
      value: APPROVAL_ID,
      userId,
      instanceId: "slack-main",
      responseUrlId: "resp-1",
    };
  }

  it("decides only for the run's person and answers privately", async () => {
    const fake = waitingRun();
    recordApproval();
    const responses: Array<Record<string, unknown>> = [];
    const deps = {
      openSession: fakeCloudSessionOpener(fake),
      respond: async (input: { responseUrlId: string; payload: Record<string, unknown> }) => {
        responses.push(input.payload);
      },
      slackUserContactId: (userId: string) => (userId === "U0ANA" ? "contact-ana" : "contact-bob"),
    };
    expect(await handleCloudApprovalClick(click("U0BOB"), deps)).toBe("not_person");
    expect(responses[0]).toMatchObject({ response_type: "ephemeral", replace_original: false });
    expect(responses[0]!.text).toBe("Só Ana pode decidir este pedido.");
    expect(fake.writes()).toHaveLength(0);

    expect(await handleCloudApprovalClick(click("U0ANA", "ravi.cloud.approval.v1.deny"), deps)).toBe("denied");
    expect(responses[1]).toMatchObject({ replace_original: true, text: "Negado: create_issue na run run_1." });
    expect(fake.writes()[0]).toMatchObject({ body: { decision: "deny" }, actorContact: "contact-ana" });

    expect(await handleCloudApprovalClick(click("U0ANA"), deps)).toBe("already_decided");
    expect(fake.writes()).toHaveLength(1);
  });

  it("ignores other interactions", async () => {
    expect(
      await handleCloudApprovalClick({ provider: "slack", actionId: "ravi.approval.v1.approve", value: "x" }),
    ).toBeNull();
    expect(
      await handleCloudApprovalClick({ provider: "discord", actionId: "ravi.cloud.approval.v1.approve" }),
    ).toBeNull();
  });
});

describe("thread = run", () => {
  it("Slack: the run's person's replies in the bound thread go to the run", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ threadKey: SLACK_KEY })] });
    bind("slack");
    const opener = fakeCloudSessionOpener(fake);
    const inbound: CloudChatInbound = {
      channel: "slack",
      accountId: "slack-main",
      instanceId: "slack-main",
      chatId: "C0ABC",
      threadTs: "1712345678.123456",
      isGroup: true,
      contactId: "contact-ana",
      text: "Inclua os de ontem também",
    };
    expect(await routeCloudChatMessage(inbound, { openSession: opener })).toEqual({
      handled: true,
      kind: "thread_message",
      reply: null,
    });
    expect(fake.writes()[0]).toMatchObject({
      path: "/runs/by-thread/messages",
      body: { key: SLACK_KEY, text: "Inclua os de ontem também" },
      actorContact: "contact-ana",
    });
    // Someone else, another thread, or the channel root: the agent.
    expect(await routeCloudChatMessage({ ...inbound, contactId: "contact-bob" }, { openSession: opener })).toEqual({
      handled: false,
    });
    expect(await routeCloudChatMessage({ ...inbound, threadTs: "1712345678.000000" }, { openSession: opener })).toEqual(
      { handled: false },
    );
    expect(await routeCloudChatMessage({ ...inbound, threadTs: null }, { openSession: opener })).toEqual({
      handled: false,
    });
  });

  it("a pending question takes the reply as its answer", async () => {
    const fake = createFakeCloudConsole({
      runs: [
        fakeCloudRun({
          status: "waiting_input",
          threadKey: SLACK_KEY,
          questions: [{ id: "q_1", question: "Qual fila?", options: [], status: "pending" }],
        }),
      ],
    });
    bind("slack");
    dbRecordCloudChatQuestion({
      questionId: "q_1",
      runId: "run_1",
      sessionName: "dev-main",
      actorContactId: "contact-ana",
    });
    const result = await routeCloudChatMessage(
      {
        channel: "slack",
        accountId: "slack-main",
        instanceId: "slack-main",
        chatId: "C0ABC",
        threadTs: "1712345678.123456",
        isGroup: true,
        contactId: "contact-ana",
        text: "Suporte",
      },
      { openSession: fakeCloudSessionOpener(fake) },
    );
    expect(result).toEqual({ handled: true, kind: "question_answer", reply: "Resposta enviada para a run." });
    expect(fake.writes()[0]).toMatchObject({ path: "/runs/run_1/questions/q_1", body: { answer: "Suporte" } });
    expect(dbPendingCloudChatQuestion("run_1")).toBeNull();
  });

  it("WhatsApp group: only @run messages and replies to the run card go to the run", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ threadKey: WHATSAPP_KEY })] });
    bind("whatsapp");
    const opener = fakeCloudSessionOpener(fake);
    const group = (text: string, replyToId: string | null = null) =>
      whatsapp(text, { chatId: GROUP, isGroup: true, replyToId });
    expect(await routeCloudChatMessage(group("bom dia pessoal"), { openSession: opener })).toEqual({ handled: false });
    expect(await routeCloudChatMessage(group("@run e o relatório?"), { openSession: opener })).toEqual({
      handled: true,
      kind: "thread_message",
      reply: "Enviado para a run.",
    });
    expect(fake.writes()[0]!.body).toEqual({ key: WHATSAPP_KEY, text: "e o relatório?" });
    expect(await routeCloudChatMessage(group("pode seguir", "wa-card-1"), { openSession: opener })).toMatchObject({
      handled: true,
    });
    expect(fake.writes()[1]!.body).toEqual({ key: WHATSAPP_KEY, text: "pode seguir" });
    // In a private chat there is no binding.
    expect(await routeCloudChatMessage(whatsapp("@run oi"), { openSession: opener })).toEqual({ handled: false });
    // Another instance in the same group has its own bindings: this one is not its.
    expect(
      await routeCloudChatMessage(
        whatsapp("@run oi", { chatId: GROUP, isGroup: true, instanceId: "inst-wa-2", accountId: "wa-two" }),
        { openSession: opener },
      ),
    ).toEqual({ handled: false });
    expect(fake.writes()).toHaveLength(2);
  });

  it("a conversation no run follows any more ends the binding; the agent gets the message", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun()] });
    bind("whatsapp");
    const result = await routeCloudChatMessage(whatsapp("@run oi", { chatId: GROUP, isGroup: true }), {
      openSession: fakeCloudSessionOpener(fake),
    });
    expect(result).toEqual({ handled: false });
    expect(dbGetActiveCloudThreadByKey(WHATSAPP_KEY)).toBeNull();
  });
});
