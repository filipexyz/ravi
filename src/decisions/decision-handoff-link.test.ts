import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { dbUpsertChat, dbUpsertChatMessage, getDb } from "../router/router-db.js";
import { getOrCreateSession, getSession } from "../router/index.js";
import { createSlackThreadLifecycle, markSlackThreadRootDelivered } from "../channels/slack/thread-lifecycle-store.js";
import { finalizeSlackThreadCreation } from "../channels/slack/thread-lifecycle.js";
import { declareHandoff, acknowledgeChildHandoffs, HANDOFF_KINDS_ANSWERED_BY_MESSAGE } from "../handoffs/service.js";
import { getHandoff } from "../handoffs/store.js";
import { describeHandoff } from "../handoffs/reconcile.js";
import {
  answerDecision,
  askDecisionForWait,
  decisionKeyForWait,
  resolveDecisionAnswerSource,
  resolveDecisionOrigin,
} from "./service.js";
import { getDecision } from "./store.js";
import type { DecisionOrigin } from "./types.js";

let state: string | null = null;
beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-decision-handoff-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(state);
  state = null;
});

const OWNER = "contact-owner";
const PARENT = "decision-parent";

function caller(sessionKey: string): ToolContext {
  const session = getSession(sessionKey);
  return {
    agentId: "main",
    sessionKey,
    sessionName: session?.name ?? sessionKey,
    context: {
      contextId: `ctx_${sessionKey}`,
      contextKey: "fixture",
      kind: "agent-runtime",
      agentId: "main",
      sessionKey,
      sessionName: session?.name ?? sessionKey,
      capabilities: [{ permission: "execute", objectType: "group", objectId: "decisions" }],
      createdAt: Date.now(),
    },
  };
}

async function thread(suffix = "1"): Promise<DecisionOrigin> {
  getOrCreateSession(PARENT, "main", state!, { name: PARENT, chatType: "channel" });
  const root = dbUpsertChat({
    channel: "slack",
    instanceId: "fixture-slack",
    platformChatId: "C123",
    chatType: "channel",
  });
  const id = `thread-link-${suffix}`;
  createSlackThreadLifecycle({
    requestId: id,
    parentSessionKey: PARENT,
    parentSessionName: PARENT,
    accountId: "fixture-slack",
    instanceId: "fixture-slack",
    platformChatId: "C123",
    rootCanonicalChatId: root.id,
    initialPrompt: "Decide\nA thread that waits for a decision.",
  });
  markSlackThreadRootDelivered({
    requestId: id,
    providerThreadId: `1713000000.000${suffix.padStart(3, "0")}`,
    canonicalRootMessageId: `root-${suffix}`,
  });
  const result = await finalizeSlackThreadCreation(id, { publishPrompt: async () => {}, publishEvent: async () => {} });
  return resolveDecisionOrigin(undefined, result.childSessionName!);
}

/** A thread asks through `report --awaiting decision`: decision first, then the wait pointing at it. */
async function waitOnDecision(origin: DecisionOrigin, ref: string | null, question: string) {
  const decision = await runWithContext(caller(origin.sessionKey!), () =>
    askDecisionForWait(origin.sessionKey!, ref, question, { ownerContactIds: () => [OWNER] }),
  );
  const handoff = await declareHandoff({
    childSessionKey: origin.sessionKey!,
    parentSessionKey: PARENT,
    kind: "decision",
    ref,
    note: question,
    decisionId: decision.id,
  });
  return { decision, handoff };
}

function ownerChat() {
  return dbUpsertChat({ channel: "slack", instanceId: "fixture-slack", platformChatId: "D-owner", chatType: "dm" });
}

function message(input: { providerMessageId: string; actorType: string; contactId?: string; agentId?: string }) {
  const chat = ownerChat();
  return dbUpsertChatMessage({
    chatId: chat.id,
    channel: "slack",
    instanceId: "fixture-slack",
    providerMessageId: input.providerMessageId,
    rawChatId: "D-owner",
    actorType: input.actorType,
    contactId: input.contactId ?? null,
    agentId: input.agentId ?? null,
    content: { text: "ok" },
  }).message;
}

describe("decision waits are recorded decisions", () => {
  it("a decision wait records the question owned by the single owner; the same ref updates the same decision", async () => {
    const origin = await thread();
    const first = await waitOnDecision(origin, "rapha-grant", "Dar permissão ao Rapha?");
    expect(first.decision.ownerType).toBe("human");
    expect(first.decision.ownerId).toBe(OWNER);
    expect(first.decision.blocks).toBe(true);
    expect(first.decision.key).toBe("rapha-grant");
    expect(first.handoff.decisionId).toBe(first.decision.id);
    expect(getHandoff(first.handoff.id)?.decisionId).toBe(first.decision.id);

    const again = await waitOnDecision(origin, "rapha-grant", "Dar permissão ao Rapha só no cassia-omie?");
    expect(again.decision.id).toBe(first.decision.id);
    expect(getDecision(first.decision.id)?.revision).toBe(2);
  });

  it("no single owner leaves the decision unassigned", async () => {
    const origin = await thread();
    const decision = await runWithContext(caller(origin.sessionKey!), () =>
      askDecisionForWait(origin.sessionKey!, null, "Pergunta?", { ownerContactIds: () => ["a", "b"] }),
    );
    expect(decision.ownerType).toBe("unassigned");
    expect(decision.key).toBe("default");
  });

  it("a message to the thread does not close a recorded decision wait; a legacy decision wait still closes by message", async () => {
    const origin = await thread();
    const { handoff } = await waitOnDecision(origin, null, "Pergunta?");
    await acknowledgeChildHandoffs(
      origin.sessionKey!,
      "parent sent instructions",
      Date.now(),
      HANDOFF_KINDS_ANSWERED_BY_MESSAGE,
    );
    expect(getHandoff(handoff.id)?.status).toBe("open");

    const other = await thread("2");
    const legacy = await declareHandoff({
      childSessionKey: other.sessionKey!,
      parentSessionKey: PARENT,
      kind: "decision",
      note: "Sem decision registrada",
    });
    await acknowledgeChildHandoffs(
      other.sessionKey!,
      "parent sent instructions",
      Date.now(),
      HANDOFF_KINDS_ANSWERED_BY_MESSAGE,
    );
    expect(getHandoff(legacy.id)?.status).toBe("acknowledged");
  });

  it("the recorded answer closes exactly the wait that asked it", async () => {
    const origin = await thread();
    const other = await thread("2");
    const asked = await waitOnDecision(origin, "x", "Pergunta A?");
    const untouched = await waitOnDecision(other, "x", "Pergunta B?");
    const answered = await runWithContext(caller(PARENT), () => answerDecision(asked.decision.id, "Sim"));
    expect(answered.status).toBe("answered");
    const closed = getHandoff(asked.handoff.id)!;
    expect(closed.status).toBe("acknowledged");
    expect(closed.ackReason).toBe(`decision answered: ${asked.decision.id}`);
    expect(getHandoff(untouched.handoff.id)?.status).toBe("open");
  });

  it("the wait line names the decision id to answer", async () => {
    const origin = await thread();
    const { handoff, decision } = await waitOnDecision(origin, null, "Pergunta?");
    expect(describeHandoff(handoff, "thread", Date.now())).toContain(`decisão ${decision.id}`);
  });
});

describe("answer provenance comes from a person's stored message", () => {
  it("records the owner's message, by internal or provider id", async () => {
    const origin = await thread();
    const { decision } = await waitOnDecision(origin, null, "Pergunta?");
    const msg = message({ providerMessageId: "1795720122.922989", actorType: "contact", contactId: OWNER });
    expect(resolveDecisionAnswerSource(decision, msg.id)).toEqual({ contactId: OWNER, messageId: msg.id });
    expect(resolveDecisionAnswerSource(decision, "1795720122.922989")).toEqual({ contactId: OWNER, messageId: msg.id });
    const answered = await runWithContext(caller(PARENT), () =>
      answerDecision(decision.id, "Sim", "luis", "1795720122.922989"),
    );
    expect(answered.answeredBy).toBe(`${PARENT} (for luis, contact:${OWNER} message:${msg.id})`);
  });

  it("refuses an agent's message, another person's message and an unknown id, and records nothing", async () => {
    const origin = await thread();
    const { decision, handoff } = await waitOnDecision(origin, null, "Pergunta?");
    const agentMsg = message({ providerMessageId: "m-agent", actorType: "agent", agentId: "main" });
    const strangerMsg = message({ providerMessageId: "m-stranger", actorType: "contact", contactId: "contact-other" });
    expect(() => resolveDecisionAnswerSource(decision, agentMsg.id)).toThrow(
      expect.objectContaining({ code: "DECISION_SOURCE_NOT_HUMAN" }),
    );
    expect(() => resolveDecisionAnswerSource(decision, strangerMsg.id)).toThrow(
      expect.objectContaining({ code: "DECISION_SOURCE_NOT_OWNER" }),
    );
    expect(() => resolveDecisionAnswerSource(decision, "nope")).toThrow(
      expect.objectContaining({ code: "DECISION_SOURCE_NOT_FOUND" }),
    );
    await expect(
      runWithContext(caller(PARENT), () => answerDecision(decision.id, "Sim", undefined, strangerMsg.id)),
    ).rejects.toMatchObject({ code: "DECISION_SOURCE_NOT_OWNER" });
    expect(getDecision(decision.id)?.status).toBe("open");
    expect(getHandoff(handoff.id)?.status).toBe("open");
    expect(getDb().query("SELECT count(*) AS n FROM decision_history WHERE type='answered'").get()).toEqual({ n: 0 });
  });
});

describe("decisionKeyForWait", () => {
  it("slugs the ref and falls back to default", () => {
    expect(decisionKeyForWait(null)).toBe("default");
    expect(decisionKeyForWait("  ")).toBe("default");
    expect(decisionKeyForWait("filipexyz/ravi#1022@fb36330")).toBe("filipexyz-ravi-1022-fb36330");
    expect(decisionKeyForWait("Rapha Grant")).toBe("rapha-grant");
    expect(decisionKeyForWait("x".repeat(80))).toHaveLength(64);
  });
});
