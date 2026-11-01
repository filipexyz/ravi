import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  capUtf16,
  claimGapsForNotification,
  dropGapsForContact,
  insertKnowledgeGap,
  knowledgeGapQuestionHash,
  listAnsweredGaps,
  listGapsByStatus,
  listGapsForProposal,
  updateGap,
} from "./store.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-gaps-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function gapInput(question: string, overrides: Partial<Parameters<typeof insertKnowledgeGap>[0]> = {}) {
  return {
    agentId: "kagent",
    instanceId: "wa-main",
    channel: "whatsapp",
    accountId: "wa-main",
    chatId: "5511999990000@s.whatsapp.net",
    contactId: "contact-1",
    sessionName: "kagent-dm-1",
    question,
    ...overrides,
  };
}

describe("knowledge gaps store", () => {
  it("dedupes the same question (folded) while pending or uploaded", () => {
    const first = insertKnowledgeGap(gapInput("Vocês dão desconto pra ONG?"));
    expect(first).toMatchObject({ created: true, capped: false });
    expect(first.gap.instanceId).toBe("wa-main");
    expect(first.gap.questionHash).toBe(knowledgeGapQuestionHash("wa-main", "Vocês dão desconto pra ONG?"));

    const again = insertKnowledgeGap(gapInput("voces dao desconto pra ong"));
    expect(again).toMatchObject({ created: false, capped: false });
    expect(again.gap.id).toBe(first.gap.id);

    updateGap(first.gap.id, { status: "uploaded", proposalId: "p1", uploadedAt: 1 });
    expect(insertKnowledgeGap(gapInput("Vocês dão desconto pra ONG?")).created).toBe(false);

    updateGap(first.gap.id, { status: "answered" });
    expect(insertKnowledgeGap(gapInput("Vocês dão desconto pra ONG?")).created).toBe(true);
  });

  it("caps at 5 gaps per contact per local day", () => {
    const now = new Date(2026, 9, 17, 12, 0, 0).getTime();
    for (let index = 0; index < 5; index++) {
      expect(insertKnowledgeGap(gapInput(`pergunta ${index}`), { now }).created).toBe(true);
    }
    const sixth = insertKnowledgeGap(gapInput("pergunta 6"), { now });
    expect(sixth).toMatchObject({ created: false, capped: true });
    expect(insertKnowledgeGap(gapInput("pergunta 7", { contactId: "contact-2" }), { now }).created).toBe(true);
    const tomorrow = new Date(2026, 9, 18, 0, 5, 0).getTime();
    expect(insertKnowledgeGap(gapInput("pergunta 6"), { now: tomorrow }).created).toBe(true);
    expect(listGapsByStatus("pending", 100)).toHaveLength(7);
  });

  it("keeps each recipient while deduplicating retries in the same conversation", () => {
    const question = "Qual o prazo?";
    const first = insertKnowledgeGap(gapInput(question)).gap;
    const secondInput = gapInput(question, { contactId: "contact-2", chatId: "chat-2" });
    const second = insertKnowledgeGap(secondInput);
    const otherChat = insertKnowledgeGap({ ...secondInput, chatId: "chat-3" });
    const otherInstance = insertKnowledgeGap(gapInput(question, { instanceId: "wa-other", accountId: "wa-other" }));
    const otherChannel = insertKnowledgeGap(gapInput(question, { channel: "slack" }));
    const otherAccount = insertKnowledgeGap(gapInput(question, { accountId: "other-account" }));

    expect(second).toMatchObject({ created: true, capped: false, gap: { contactId: "contact-2", chatId: "chat-2" } });
    expect(second.gap.questionHash).toBe(first.questionHash);
    expect(
      new Set([
        first.id,
        second.gap.id,
        otherChat.gap.id,
        otherInstance.gap.id,
        otherChannel.gap.id,
        otherAccount.gap.id,
      ]).size,
    ).toBe(6);
    updateGap(second.gap.id, { status: "uploaded", proposalId: "shared-proposal" });
    expect(insertKnowledgeGap(secondInput)).toMatchObject({ created: false, gap: { id: second.gap.id } });
  });

  it("forgetting one recipient preserves another recipient's identical question", () => {
    const first = insertKnowledgeGap(gapInput("Qual o prazo?")).gap;
    const second = insertKnowledgeGap(gapInput("Qual o prazo?", { contactId: "contact-2", chatId: "chat-2" })).gap;
    updateGap(first.id, { status: "uploaded", proposalId: "shared-proposal" });
    updateGap(second.id, { status: "uploaded", proposalId: "shared-proposal" });

    expect(dropGapsForContact("contact-1")).toBe(1);
    expect(listGapsByStatus("uploaded", 10).map((gap) => gap.id)).toEqual([second.id]);
    expect(claimGapsForNotification("shared-proposal").map((gap) => gap.id)).toEqual([second.id]);
  });

  it("drops every undelivered gap on forget and preserves delivered history and other contacts", () => {
    const a = insertKnowledgeGap(gapInput("a?")).gap;
    const b = insertKnowledgeGap(gapInput("b?")).gap;
    const c = insertKnowledgeGap(gapInput("c?")).gap;
    const delivered = insertKnowledgeGap(gapInput("already delivered?")).gap;
    const other = insertKnowledgeGap(gapInput("d?", { contactId: "contact-2" })).gap;
    updateGap(b.id, { status: "uploaded", proposalId: "p1" });
    updateGap(c.id, { status: "answered", proposalId: "p1" });
    updateGap(delivered.id, { status: "notified", proposalId: "p1", notifiedAt: 1 });
    expect(dropGapsForContact("contact-1")).toBe(3);
    expect(
      listGapsByStatus("dropped", 10)
        .map((gap) => gap.id)
        .sort(),
    ).toEqual([a.id, b.id, c.id].sort());
    expect(listAnsweredGaps(10)).toEqual([]);
    expect(listGapsByStatus("notified", 10).map((gap) => gap.id)).toEqual([delivered.id]);
    expect(listGapsByStatus("pending", 10).map((gap) => gap.id)).toEqual([other.id]);
    expect(dropGapsForContact("contact-1")).toBe(0);
    expect(claimGapsForNotification("p1")).toEqual([]);
  });

  it("claims gaps for notification once, optionally by instance", () => {
    const a = insertKnowledgeGap(gapInput("a?")).gap;
    const b = insertKnowledgeGap(gapInput("b?", { instanceId: "wa-other" })).gap;
    const c = insertKnowledgeGap(gapInput("c?")).gap;
    updateGap(a.id, { status: "answered", proposalId: "p1" });
    updateGap(b.id, { status: "uploaded", proposalId: "p1" });
    updateGap(c.id, { status: "pending", proposalId: "p1" });

    expect(
      listGapsForProposal("p1")
        .map((gap) => gap.id)
        .sort(),
    ).toEqual([a.id, b.id, c.id].sort());
    expect(listAnsweredGaps(10).map((gap) => gap.id)).toEqual([a.id]);

    expect(claimGapsForNotification("p1", [])).toEqual([]);
    const claimed = claimGapsForNotification("p1", ["wa-main"]);
    expect(claimed.map((gap) => gap.id)).toEqual([a.id]);
    expect(claimed[0]?.status).toBe("notified");
    expect(claimed[0]?.notifiedAt).not.toBeNull();
    expect(claimGapsForNotification("p1", ["wa-main"])).toEqual([]);
    expect(claimGapsForNotification("p1").map((gap) => gap.id)).toEqual([b.id]);
    expect(claimGapsForNotification("p1")).toEqual([]);
  });
});

describe("capUtf16", () => {
  it("caps by UTF-16 length without splitting a surrogate pair", () => {
    expect(capUtf16("abc", 1000)).toBe("abc");
    const emoji = "😀"; // two UTF-16 units
    const text = `${"a".repeat(999)}${emoji}`;
    expect(text.length).toBe(1001);
    expect(capUtf16(text, 1000)).toBe("a".repeat(999));
    expect(capUtf16(emoji.repeat(600), 1000).length).toBe(1000);
  });
});
