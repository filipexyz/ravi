import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { buildChannelChatActionJob } from "../channels/outbound-stream.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbGetActiveCloudThreadByKey } from "./chat-db.js";
import type { CloudChatDeliveryReply, CloudChatTarget } from "./chat-target.js";
import {
  bindCloudThread,
  type CloudThreadPlan,
  openCloudThreadRoot,
  planCloudThread,
  slackThreadKey,
  updateCloudRunCard,
  whatsappThreadKey,
} from "./thread-binding.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-cloud-thread-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

type Job = ReturnType<typeof buildChannelChatActionJob>;
type Sent = { target: CloudChatTarget; text: string; blocks?: readonly Record<string, unknown>[] };

function recorder(reply: (sent: Sent, index: number) => { messageId: string | null } | Error) {
  const sent: Sent[] = [];
  const edits: Job[] = [];
  return {
    sent,
    edits,
    deps: {
      now: () => 1_760_000_000_000,
      deliverToChat: async (target: CloudChatTarget, message: Omit<Sent, "target">) => {
        const entry = { target, ...message };
        sent.push(entry);
        const result = reply(entry, sent.length - 1);
        if (result instanceof Error) throw result;
        return { messageId: result.messageId, deliveries: [] } satisfies CloudChatDeliveryReply;
      },
      publishCardEdit: async (job: Job) => {
        edits.push(job);
      },
    },
  };
}

const SLACK_SOURCE = { channel: "slack", accountId: "slack-main", instanceId: "slack-main", chatId: "C0ABC123" };
const WA_GROUP = "120363012345678901@g.us";

function bindInput(plan: CloudThreadPlan, threadKey: string, cardMessageId: string | null = null) {
  return {
    plan,
    threadKey,
    cardMessageId,
    runId: "run_1",
    status: "running",
    agentName: "triage",
    prompt: "Resume os tickets",
    sessionName: "dev-main",
    actorUserId: "user-1",
    actorContactId: "contact-ana",
    personName: "Ana",
  };
}

describe("planCloudThread", () => {
  it("Slack inside a thread: the key is known up front", () => {
    expect(planCloudThread({ ...SLACK_SOURCE, threadId: "1712345678.123456" })).toEqual({
      channel: "slack",
      accountId: "slack-main",
      instanceId: "slack-main",
      chatId: "C0ABC123",
      threadTs: "1712345678.123456",
      threadKey: "slack:slack-main:C0ABC123:1712345678.123456",
    });
  });

  it("Slack at the top level: the run card will open the thread", () => {
    expect(planCloudThread(SLACK_SOURCE)).toMatchObject({ channel: "slack", threadTs: null, threadKey: null });
  });

  it("WhatsApp: groups only, keyed by the group", () => {
    expect(
      planCloudThread({ channel: "whatsapp", accountId: "wa-main", instanceId: "inst-wa", chatId: WA_GROUP }),
    ).toEqual({
      channel: "whatsapp",
      accountId: "wa-main",
      instanceId: "inst-wa",
      chatId: WA_GROUP,
      threadKey: whatsappThreadKey("inst-wa", WA_GROUP),
    });
    const dm = planCloudThread({ channel: "whatsapp", accountId: "wa-main", chatId: "5511999999999@s.whatsapp.net" });
    expect(dm).toEqual({ error: "--bind-thread works in a WhatsApp group, not in a private chat." });
  });

  it("refuses other channels, a missing chat and malformed Slack ids", () => {
    expect("error" in planCloudThread({ channel: "telegram", accountId: "tg", chatId: "123" })).toBe(true);
    expect("error" in planCloudThread(null)).toBe(true);
    expect("error" in planCloudThread({ ...SLACK_SOURCE, chatId: "general" })).toBe(true);
    expect("error" in planCloudThread({ ...SLACK_SOURCE, threadId: "not-a-ts" })).toBe(true);
    expect(slackThreadKey("i", "C1", "1.2")).toBe("slack:i:C1:1.2");
  });
});

describe("bindCloudThread", () => {
  it("Slack thread: posts the card as a reply in it and records the binding", async () => {
    const plan = planCloudThread({ ...SLACK_SOURCE, threadId: "1712345678.123456" }) as CloudThreadPlan;
    const rec = recorder(() => ({ messageId: "1712345679.000100" }));
    const thread = await bindCloudThread(bindInput(plan, plan.threadKey as string), rec.deps);
    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0].target).toMatchObject({ channel: "slack", chatId: "C0ABC123", threadId: "1712345678.123456" });
    expect(rec.sent[0].text).toBe("Run na nuvem: triage");
    expect(rec.sent[0].blocks?.length).toBeGreaterThan(0);
    expect(thread).toMatchObject({
      threadKey: "slack:slack-main:C0ABC123:1712345678.123456",
      runId: "run_1",
      threadTs: "1712345678.123456",
      cardMessageId: "1712345679.000100",
      actorContactId: "contact-ana",
    });
    expect(dbGetActiveCloudThreadByKey(thread.threadKey)?.runId).toBe("run_1");
  });

  it("Slack: a workspace that rejects the card block gets the classic blocks", async () => {
    const plan = planCloudThread({ ...SLACK_SOURCE, threadId: "1712345678.123456" }) as CloudThreadPlan;
    const rec = recorder((_, index) =>
      index === 0 ? new Error("slack: invalid_blocks") : { messageId: "1712345679.2" },
    );
    const thread = await bindCloudThread(bindInput(plan, plan.threadKey as string), rec.deps);
    expect(rec.sent).toHaveLength(2);
    expect(rec.sent[1].blocks).not.toEqual(rec.sent[0].blocks);
    expect(thread.cardMessageId).toBe("1712345679.2");
  });

  it("a card that cannot be posted still binds, without a card", async () => {
    const plan = planCloudThread({ ...SLACK_SOURCE, threadId: "1712345678.123456" }) as CloudThreadPlan;
    const rec = recorder(() => new Error("channel_not_found"));
    const thread = await bindCloudThread(bindInput(plan, plan.threadKey as string), rec.deps);
    expect(thread.cardMessageId).toBeNull();
    expect(dbGetActiveCloudThreadByKey(thread.threadKey)).not.toBeNull();
  });

  it("Slack root: the card opened the thread, so it is edited with the run's status, not re-posted", async () => {
    const plan = planCloudThread(SLACK_SOURCE) as Extract<CloudThreadPlan, { channel: "slack" }>;
    const rec = recorder(() => ({ messageId: "1712345680.000200" }));
    const root = await openCloudThreadRoot(
      plan,
      { runId: "pending", agentName: "triage", prompt: "Resume", status: "queued", personName: "Ana" },
      rec.deps,
    );
    expect(root).toEqual({
      threadKey: "slack:slack-main:C0ABC123:1712345680.000200",
      cardMessageId: "1712345680.000200",
    });
    expect(rec.sent[0].target.threadId).toBeUndefined();

    const thread = await bindCloudThread(bindInput(plan, root.threadKey, root.cardMessageId), rec.deps);
    expect(rec.sent).toHaveLength(1);
    expect(rec.edits).toHaveLength(1);
    expect(rec.edits[0].request.content).toMatchObject({
      actionId: "message.edit",
      providerMessageId: "1712345680.000200",
    });
    expect(thread.threadTs).toBe("1712345680.000200");
  });

  it("Slack root: a reply without a timestamp is an error", async () => {
    const plan = planCloudThread(SLACK_SOURCE) as Extract<CloudThreadPlan, { channel: "slack" }>;
    const rec = recorder(() => ({ messageId: null }));
    await expect(
      openCloudThreadRoot(
        plan,
        { runId: "x", agentName: "a", prompt: "p", status: "queued", personName: null },
        rec.deps,
      ),
    ).rejects.toThrow("timestamp");
  });

  it("WhatsApp group: one text card in the group", async () => {
    const plan = planCloudThread({
      channel: "whatsapp",
      accountId: "wa-main",
      instanceId: "inst-wa",
      chatId: WA_GROUP,
    }) as CloudThreadPlan;
    const rec = recorder(() => ({ messageId: "wa-card-1" }));
    const thread = await bindCloudThread(bindInput(plan, plan.threadKey as string), rec.deps);
    expect(rec.sent[0].blocks).toBeUndefined();
    expect(rec.sent[0].text).toContain("@run");
    expect(thread).toMatchObject({ channel: "whatsapp", threadTs: null, cardMessageId: "wa-card-1" });
  });
});

describe("updateCloudRunCard", () => {
  it("Slack: queues a message.edit with the thread card; WhatsApp is never re-posted", async () => {
    const plan = planCloudThread({ ...SLACK_SOURCE, threadId: "1712345678.123456" }) as CloudThreadPlan;
    const rec = recorder(() => ({ messageId: "1712345679.000100" }));
    const thread = await bindCloudThread(bindInput(plan, plan.threadKey as string), rec.deps);
    expect(await updateCloudRunCard(thread, { status: "completed", summary: "Pronto" }, rec.deps)).toBe(true);
    const job = rec.edits[0];
    expect(job.request.channelId).toBe("slack");
    expect(job.request.targetChatId).toBe("C0ABC123");
    expect(job.request.requestId).toBe("cloud-run-card:run_1:completed:1760000000000");
    expect(job.request.content).toMatchObject({
      type: "chat_action",
      actionId: "message.edit",
      providerMessageId: "1712345679.000100",
      text: "Run na nuvem: triage\nResume os tickets",
      threadCard: { status: "closed" },
    });

    expect(
      await updateCloudRunCard({ ...thread, cardMessageId: null }, { status: "failed", summary: null }, rec.deps),
    ).toBe(false);
    expect(
      await updateCloudRunCard({ ...thread, channel: "whatsapp" }, { status: "failed", summary: null }, rec.deps),
    ).toBe(false);
    expect(rec.edits).toHaveLength(1);
  });
});
