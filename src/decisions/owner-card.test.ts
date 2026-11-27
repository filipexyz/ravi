import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { dbUpsertChat } from "../router/router-db.js";
import { getOrCreateSession, getSession } from "../router/index.js";
import { createSlackThreadLifecycle, markSlackThreadRootDelivered } from "../channels/slack/thread-lifecycle-store.js";
import { finalizeSlackThreadCreation } from "../channels/slack/thread-lifecycle.js";
import { createContact } from "../contacts.js";
import { askDecision, resolveDecisionOrigin } from "./service.js";
import { getDecision } from "./store.js";
import { answerDecisionFromOwnerCard, type OwnerCardAnswerInput } from "./owner-card.js";
import type { Decision, DecisionOrigin } from "./types.js";

let state: string | null = null;
let OWNER = "";
let STRANGER = "";
let HUMAN = "";
const PARENT = "owner-card-parent";
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-owner-card-");
  for (const key of ["RAVI_AGENT_ID", "RAVI_SESSION_KEY", "RAVI_SESSION_NAME"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  OWNER = createContact({ phone: "5511900000981", name: "Owner", tags: ["permission-owner"], status: "allowed" }).id;
  STRANGER = createContact({ phone: "5511900000982", name: "Stranger", status: "allowed" }).id;
  // A person who owns a decision but not the installation.
  HUMAN = createContact({ phone: "5511900000983", name: "Human", status: "allowed" }).id;
});
afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[key] = value;
  await cleanupIsolatedRaviState(state);
  state = null;
});

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

async function thread(): Promise<DecisionOrigin> {
  getOrCreateSession(PARENT, "main", state!, { name: PARENT, chatType: "channel" });
  const root = dbUpsertChat({
    channel: "slack",
    instanceId: "fixture-slack",
    platformChatId: "C123",
    chatType: "channel",
  });
  createSlackThreadLifecycle({
    requestId: "owner-card-thread",
    parentSessionKey: PARENT,
    parentSessionName: PARENT,
    accountId: "fixture-slack",
    instanceId: "fixture-slack",
    platformChatId: "C123",
    rootCanonicalChatId: root.id,
    initialPrompt: "Decide\nA thread that waits for a decision.",
  });
  markSlackThreadRootDelivered({
    requestId: "owner-card-thread",
    providerThreadId: "1713000000.000100",
    canonicalRootMessageId: "root-1",
  });
  const result = await finalizeSlackThreadCreation("owner-card-thread", {
    publishPrompt: async () => {},
    publishEvent: async () => {},
  });
  return resolveDecisionOrigin(undefined, result.childSessionName!);
}

async function ask(origin: DecisionOrigin, owner: string, key = "model", text = `Pergunta ${key}?`): Promise<Decision> {
  const { decision } = await runWithContext(caller(PARENT), () =>
    askDecision(origin, { key, ask: text, ownerType: "human", ownerId: owner, blocks: true }),
  );
  return decision;
}

// Senders resolve to contacts by a fixed table: the platform lookup is the channel's, not this test's.
function deps(table: Record<string, string>) {
  return {
    resolveSender: (input: { senderId?: string | null }) =>
      table[input.senderId ?? ""] ? { ownerType: "contact" as const, ownerId: table[input.senderId ?? ""]! } : null,
    answer: undefined as never,
  };
}

async function click(input: Partial<OwnerCardAnswerInput> & { decision: Decision }, table: Record<string, string>) {
  const { decision, ...rest } = input;
  const { answerDecision } = await import("./service.js");
  return answerDecisionFromOwnerCard(
    {
      decisionId: decision.id,
      revision: decision.revision,
      answer: "sonnet",
      scope: "origin",
      actor: { channel: "slack", senderId: "UOWNER", accountId: "fixture-slack", instanceId: "fixture-slack" },
      interactionRef: "slack:view:V1",
      ...rest,
    },
    { ...deps(table), answer: answerDecision },
  );
}

const PEOPLE = () => ({ UOWNER: OWNER, USTRANGER: STRANGER, UHUMAN: HUMAN });

describe("owner answers a decision on its card", () => {
  it("records the owner's answer for the thread, with the click as its source", async () => {
    const decision = await ask(await thread(), OWNER);
    const outcome = await click({ decision }, PEOPLE());
    expect(outcome.kind).toBe("answered");
    const stored = getDecision(decision.id)!;
    expect(stored.status).toBe("answered");
    expect(stored.answer).toBe("sonnet");
    expect(stored.scope.type).toBe("origin");
    expect(stored.sourceMessageId).toBe("slack:view:V1");
    expect(stored.answeredBy).toContain(`[card contact:${OWNER} interaction:slack:view:V1]`);
  });

  it("widens to the org when the installation owner chooses it", async () => {
    const decision = await ask(await thread(), OWNER);
    const outcome = await click({ decision, scope: "org" }, PEOPLE());
    expect(outcome.kind).toBe("answered");
    expect(getDecision(decision.id)!.scope.type).toBe("org");
  });

  it("refuses a click by anyone but the decision's owner", async () => {
    const decision = await ask(await thread(), OWNER);
    const outcome = await click(
      { decision, actor: { channel: "slack", senderId: "USTRANGER", accountId: "fixture-slack" } },
      PEOPLE(),
    );
    expect(outcome).toEqual({ kind: "refused", reason: "not_owner" });
    expect(getDecision(decision.id)!.status).toBe("open");
  });

  it("refuses a sender the platform does not resolve", async () => {
    const decision = await ask(await thread(), OWNER);
    const outcome = await click(
      { decision, actor: { channel: "slack", senderId: "UNOBODY", accountId: "fixture-slack" } },
      PEOPLE(),
    );
    expect(outcome).toEqual({ kind: "refused", reason: "unknown_actor" });
    expect(getDecision(decision.id)!.status).toBe("open");
  });

  it("refuses a sender that resolves to an agent, not a person", async () => {
    const decision = await ask(await thread(), OWNER);
    const { answerDecision } = await import("./service.js");
    const outcome = await answerDecisionFromOwnerCard(
      {
        decisionId: decision.id,
        revision: decision.revision,
        answer: "sonnet",
        scope: "origin",
        actor: { channel: "slack", senderId: "UBOT" },
        interactionRef: "slack:view:V2",
      },
      { resolveSender: () => ({ ownerType: "agent", ownerId: OWNER }), answer: answerDecision },
    );
    expect(outcome).toEqual({ kind: "refused", reason: "unknown_actor" });
    expect(getDecision(decision.id)!.status).toBe("open");
  });

  it("refuses a card that shows an older revision of the question", async () => {
    const origin = await thread();
    const first = await ask(origin, OWNER);
    // Asked again with the same key: the same decision, a newer wording.
    const revised = await ask(origin, OWNER, "model", "Pergunta reformulada?");
    expect(revised.id).toBe(first.id);
    expect(revised.revision).toBeGreaterThan(first.revision);
    const outcome = await click({ decision: first }, PEOPLE());
    expect(outcome).toEqual({ kind: "refused", reason: "stale" });
    expect(getDecision(first.id)!.status).toBe("open");
  });

  it("refuses a card whose decision was already answered", async () => {
    const decision = await ask(await thread(), OWNER);
    expect((await click({ decision }, PEOPLE())).kind).toBe("answered");
    const again = await click({ decision, answer: "opus" }, PEOPLE());
    expect(again).toEqual({ kind: "refused", reason: "stale" });
    expect(getDecision(decision.id)!.answer).toBe("sonnet");
  });

  it("does not let a decision owner who is not the installation owner widen it, even from the operator's process", async () => {
    // No tool context here: the process counts as the local operator, whose authority a card never borrows.
    const decision = await ask(await thread(), HUMAN);
    const outcome = await click(
      { decision, scope: "org", actor: { channel: "slack", senderId: "UHUMAN", accountId: "fixture-slack" } },
      PEOPLE(),
    );
    expect(outcome).toEqual({ kind: "refused", reason: "scope_not_authorized" });
    expect(getDecision(decision.id)!.status).toBe("open");
    // The same person answers for the thread.
    const forThread = await click(
      { decision, actor: { channel: "slack", senderId: "UHUMAN", accountId: "fixture-slack" } },
      PEOPLE(),
    );
    expect(forThread).toMatchObject({ kind: "answered" });
  });

  it("refuses an empty answer and a malformed decision id", async () => {
    const decision = await ask(await thread(), OWNER);
    expect(await click({ decision, answer: "   " }, PEOPLE())).toEqual({ kind: "refused", reason: "invalid_answer" });
    expect(await click({ decision, decisionId: "not-a-decision" }, PEOPLE())).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(getDecision(decision.id)!.status).toBe("open");
  });
});
