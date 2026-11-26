import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runThreadMutation } from "../threads/schema-fence.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { dbListChatMessagesByProviderId, dbUpsertChat, dbUpsertChatMessage, getDb } from "../router/router-db.js";
import { getOrCreateSession, getSession } from "../router/index.js";
import { createSlackThreadLifecycle, markSlackThreadRootDelivered } from "../channels/slack/thread-lifecycle-store.js";
import { finalizeSlackThreadCreation } from "../channels/slack/thread-lifecycle.js";
import { createSessionGoal } from "../runtime/session-goals.js";
import {
  answerDecision,
  askDecision,
  askDecisionForWait,
  checkDecisionAnswer,
  WIDE_DECISION_ANSWER_MAX,
  resolveDecisionAnswerSource,
  resolveDecisionOrigin,
  supersedeDecision,
} from "./service.js";
import { decisionWrite, getDecision, listDecisionsInForce } from "./store.js";
import { buildDecisionsInForceSection, refreshDecisionsForTurn } from "./prompt.js";
import { parseDecisionScope } from "./model.js";
import type { Decision, DecisionOrigin } from "./types.js";

let state: string | null = null;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-decision-scopes-");
  savedEnv = {
    RAVI_AGENT_ID: process.env.RAVI_AGENT_ID,
    RAVI_SESSION_KEY: process.env.RAVI_SESSION_KEY,
    RAVI_SESSION_NAME: process.env.RAVI_SESSION_NAME,
  };
  for (const key of Object.keys(savedEnv)) delete process.env[key];
});
afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[key] = value;
  await cleanupIsolatedRaviState(state);
  state = null;
});

const OWNER = "contact-owner";
const PARENT = "decision-parent";

function caller(
  sessionKey: string,
  capabilities = [{ permission: "execute", objectType: "group", objectId: "decisions" }],
): ToolContext {
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
      capabilities,
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
  const id = `thread-scope-${suffix}`;
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

async function ask(origin: DecisionOrigin, key: string, scope?: string): Promise<Decision> {
  const { decision } = await runWithContext(caller(origin.sessionKey!), () =>
    askDecision(origin, {
      key,
      ask: `Pergunta ${key}?`,
      ownerType: "human",
      ownerId: OWNER,
      blocks: true,
      scope: parseDecisionScope(scope),
    }),
  );
  return decision;
}

function ownerDm() {
  return dbUpsertChat({ channel: "slack", instanceId: "fixture-slack", platformChatId: "D-owner", chatType: "dm" });
}

let messageSeq = 0;
function ownerSays(
  text: string,
  input: { chatId?: string; providerMessageId?: string; providerTimestamp?: number; contactId?: string } = {},
) {
  messageSeq += 1;
  return dbUpsertChatMessage({
    chatId: input.chatId ?? ownerDm().id,
    channel: "slack",
    instanceId: "fixture-slack",
    providerMessageId: input.providerMessageId ?? `m-${messageSeq}`,
    providerTimestamp: input.providerTimestamp ?? null,
    rawChatId: "D-owner",
    actorType: "contact",
    contactId: input.contactId ?? OWNER,
    content: { text },
  }).message;
}

const asParent = <T>(fn: () => Promise<T> | T) => runWithContext(caller(PARENT), fn);

describe("the source is bound to the decision it answers (N1)", () => {
  it("refuses an owner message that neither names the decision nor contains the quoted passage", async () => {
    const decision = await ask(await thread(), "deploy");
    const msg = ownerSays("sim, pode fazer o deploy hoje");
    for (const quote of [undefined, "amanhã", " "])
      expect(() => resolveDecisionAnswerSource(decision, msg.id, quote)).toThrow(
        expect.objectContaining({ code: "DECISION_SOURCE_NOT_OWNER" }),
      );
    expect(resolveDecisionAnswerSource(decision, msg.id, "Pode   fazer o DEPLOY").excerpt).toBe("Pode fazer o DEPLOY");
  });

  it("stores the quoted passage on the answered decision", async () => {
    const decision = await ask(await thread(), "deploy");
    const msg = ownerSays("sim, pode fazer o deploy hoje");
    const answered = await asParent(() =>
      answerDecision(decision.id, "Deploy hoje", undefined, msg.id, { sourceQuote: "pode fazer o deploy hoje" }),
    );
    expect(answered).toMatchObject({ sourceMessageId: msg.id, sourceExcerpt: "pode fazer o deploy hoje" });
  });

  it("a provider id repeated in more ineligible chats than the lookup limit still finds the owner's message (N5)", async () => {
    const decision = await ask(await thread(), "deploy");
    for (let i = 0; i < 25; i += 1) {
      const group = dbUpsertChat({
        channel: "slack",
        instanceId: "fixture-slack",
        platformChatId: `C-g${i}`,
        chatType: "group",
      });
      ownerSays("sim", { chatId: group.id, providerMessageId: "same-ts" });
    }
    const inDm = ownerSays("sim", { providerMessageId: "same-ts" });
    const strangerDm = dbUpsertChat({
      channel: "slack",
      instanceId: "fixture-slack",
      platformChatId: "D-stranger",
      chatType: "dm",
    });
    ownerSays("sim", { chatId: strangerDm.id, providerMessageId: "same-ts", contactId: "someone-else" });
    expect(resolveDecisionAnswerSource(decision, "same-ts", "sim").messageId).toBe(inDm.id);
    // The eligibility filter runs in the query itself, before the row limit.
    expect(
      dbListChatMessagesByProviderId("same-ts", {
        contactId: OWNER,
        since: decision.askedAt,
        chatId: decision.origin.chatId,
      }).map((m) => m.id),
    ).toEqual([inDm.id]);
  });

  it("reads a provider timestamp in seconds as seconds (N2)", async () => {
    const decision = await ask(await thread(), "deploy");
    const after = ownerSays("sim", { providerTimestamp: Math.floor(decision.askedAt / 1000) + 5 });
    expect(resolveDecisionAnswerSource(decision, after.id, "sim").messageId).toBe(after.id);
    const before = ownerSays("sim", { providerTimestamp: Math.floor(decision.askedAt / 1000) - 60 });
    expect(() => resolveDecisionAnswerSource(decision, before.id, "sim")).toThrow(
      expect.objectContaining({ code: "DECISION_SOURCE_NOT_OWNER" }),
    );
  });
});

describe("a decision's scope", () => {
  it("an agent cannot widen a decision on its own; the owner's bound message can", async () => {
    const origin = await thread();
    const decision = await ask(origin, "deploy");
    for (const scope of ["org", "agent:main", "project:p1"])
      await expect(
        asParent(() => answerDecision(decision.id, "Sim", undefined, undefined, { scope: parseDecisionScope(scope) })),
      ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    expect(getDecision(decision.id)?.status).toBe("open");

    const quoteOnly = ownerSays("sim, vale pra org");
    await expect(
      asParent(() =>
        answerDecision(decision.id, "Sim", undefined, quoteOnly.id, {
          scope: parseDecisionScope("org"),
          sourceQuote: "vale pra org",
        }),
      ),
    ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    const noScope = ownerSays(`${decision.id}: sim`);
    await expect(
      asParent(() => answerDecision(decision.id, "Sim", undefined, noScope.id, { scope: parseDecisionScope("org") })),
    ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    const otherScope = ownerSays(`${decision.id} agent:main`);
    await expect(
      asParent(() =>
        answerDecision(decision.id, "Sim", undefined, otherScope.id, { scope: parseDecisionScope("org") }),
      ),
    ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    const msg = ownerSays(`${decision.id}: sim, vale pra org`);
    const answered = await asParent(() =>
      answerDecision(decision.id, "Sim", undefined, msg.id, { scope: parseDecisionScope("org") }),
    );
    expect(answered.scope).toEqual({ type: "org", id: null });
  });

  it("an agent with every grant still needs the owner's message to widen", async () => {
    const decision = await ask(await thread(), "deploy");
    await expect(
      runWithContext(caller(PARENT, [{ permission: "admin", objectType: "system", objectId: "*" }]), () =>
        answerDecision(decision.id, "Sim", undefined, undefined, { scope: parseDecisionScope("org") }),
      ),
    ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
  });

  it("a proposed scope binds the answer unless the answer narrows it", async () => {
    const origin = await thread();
    const proposed = await ask(origin, "deploy", "org");
    expect(proposed.scope).toEqual({ type: "org", id: null });
    expect(() => runWithContext(caller(PARENT), () => checkDecisionAnswer(proposed, undefined))).toThrow(
      expect.objectContaining({ code: "DECISION_SCOPE_NOT_AUTHORIZED" }),
    );
    const narrowed = await asParent(() =>
      answerDecision(proposed.id, "Só nesta thread", undefined, undefined, { scope: parseDecisionScope("thread") }),
    );
    expect(narrowed.scope).toEqual({ type: "origin", id: null });
  });

  it("the local operator widens without a message", async () => {
    const decision = await ask(await thread(), "deploy");
    const answered = await answerDecision(decision.id, "Sim", undefined, undefined, {
      scope: parseDecisionScope("agent:main"),
    });
    expect(answered.scope).toEqual({ type: "agent", id: "main" });
  });
});

async function operatorAnswer(origin: DecisionOrigin, key: string, scope: string): Promise<Decision> {
  const decision = await ask(origin, key);
  return answerDecision(decision.id, `Resposta ${key}`, undefined, undefined, { scope: parseDecisionScope(scope) });
}

describe("decisions in force for a turn", () => {
  it("a turn carries org, its agent and its own thread; not projects, other agents, threads or open questions", async () => {
    const origin = await thread();
    const other = await thread("2");
    const org = await operatorAnswer(origin, "org-rule", "org");
    const mine = await operatorAnswer(origin, "agent-main", "agent:main");
    await operatorAnswer(origin, "agent-other", "agent:other");
    const project = await operatorAnswer(origin, "project-p1", "project:p1");
    await operatorAnswer(origin, "project-p2", "project:p2");
    const ownThread = await operatorAnswer(origin, "own-thread", "thread");
    await operatorAnswer(other, "other-thread", "thread");
    await ask(origin, "still-open", "org");
    createSessionGoal({ sessionKey: origin.sessionKey!, objective: "Ship it", projectId: "p1" });

    const ids = listDecisionsInForce({ agentId: "main", projectId: "p1", sessionKey: origin.sessionKey! }).map(
      (d) => d.id,
    );
    expect(new Set(ids)).toEqual(new Set([org.id, mine.id, project.id, ownThread.id]));

    const section = buildDecisionsInForceSection({ agentId: "main", sessionKey: origin.sessionKey! })!;
    for (const d of [org, mine, ownThread]) expect(section).toContain(d.id);
    // The goal's project is a label the session can write itself: project decisions are not mounted in turns.
    expect(section).not.toContain(project.id);
    expect(section).toContain('"answer":"Resposta org-rule"');
    expect(section).not.toContain("Resposta agent-other");
    expect(section).not.toContain("Resposta project-p2");
    expect(section).not.toContain("Resposta other-thread");
    expect(section).not.toContain("still-open");
    expect(section).not.toContain(OWNER);
    expect(buildDecisionsInForceSection({ agentId: "other-agent" })).toContain(org.id);
  });

  it("keeps the 20 newest", async () => {
    const origin = await thread();
    const all: Decision[] = [];
    for (let i = 0; i < 22; i += 1) all.push(await operatorAnswer(origin, `org-${i}`, "org"));
    for (const [i, d] of all.entries())
      decisionWrite((db) => runThreadMutation(db, "UPDATE decisions SET answered_at=? WHERE id=?", 1_000 + i, d.id));
    const ids = listDecisionsInForce({ agentId: "main" }).map((d) => d.id);
    expect(ids).toEqual(
      all
        .slice(2)
        .reverse()
        .map((d) => d.id),
    );
  });

  it("no decision in force means no section", async () => {
    await thread();
    expect(buildDecisionsInForceSection({ agentId: "main" })).toBeNull();
  });
});

describe("superseding a decision", () => {
  it("an answer that replaces an older decision takes it out of every turn and keeps its history", async () => {
    const origin = await thread();
    const old = await operatorAnswer(origin, "old", "thread");
    const next = await ask(origin, "new");
    const answered = await asParent(() =>
      answerDecision(next.id, "Nova regra", undefined, undefined, { supersedes: old.id }),
    );
    expect(getDecision(old.id)).toMatchObject({
      status: "superseded",
      supersededBy: answered.id,
      answer: "Resposta old",
    });
    expect(listDecisionsInForce({ sessionKey: origin.sessionKey! }).map((d) => d.id)).toEqual([answered.id]);
    const history = getDb()
      .query("SELECT type FROM decision_history WHERE decision_id=? ORDER BY id")
      .all(old.id) as Array<{ type: string }>;
    expect(history.map((h) => h.type)).toEqual(["asked", "answered", "superseded"]);
  });

  it("an agent cannot replace an org decision without the owner's message on the replacement", async () => {
    const origin = await thread();
    const old = await operatorAnswer(origin, "old", "org");
    const next = await ask(origin, "new");
    await expect(
      asParent(() => answerDecision(next.id, "Troca", undefined, undefined, { supersedes: old.id })),
    ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    expect(getDecision(old.id)?.status).toBe("answered");
    expect(getDecision(next.id)?.status).toBe("open");

    const msg = ownerSays(`${next.id}: troca a regra da org`);
    await asParent(() =>
      answerDecision(next.id, "Troca", undefined, msg.id, { scope: parseDecisionScope("org"), supersedes: old.id }),
    );
    expect(getDecision(old.id)?.status).toBe("superseded");
  });

  it("decisions supersede: only answered decisions, never itself, and an org one needs an owner-sourced replacement", async () => {
    const origin = await thread();
    const old = await operatorAnswer(origin, "old", "org");
    const open = await ask(origin, "open");
    const plain = await operatorAnswer(origin, "plain", "thread");
    await expect(asParent(async () => supersedeDecision(old.id, open.id))).rejects.toMatchObject({
      code: "DECISION_NOT_ANSWERED",
    });
    await expect(asParent(async () => supersedeDecision(plain.id, plain.id))).rejects.toMatchObject({
      code: "DECISION_NOT_ANSWERED",
    });
    await expect(asParent(async () => supersedeDecision(old.id, plain.id))).rejects.toMatchObject({
      code: "DECISION_SCOPE_NOT_AUTHORIZED",
    });
    const orgWithoutOwner = await operatorAnswer(origin, "org-2", "org");
    await expect(asParent(async () => supersedeDecision(old.id, orgWithoutOwner.id))).rejects.toMatchObject({
      code: "DECISION_SCOPE_NOT_AUTHORIZED",
    });
    expect(supersedeDecision(old.id, plain.id).supersededBy).toBe(plain.id);
  });
});

describe("decision waits keep the thread scope", () => {
  it("a wait's decision is proposed for its thread", async () => {
    const origin = await thread();
    const decision = await runWithContext(caller(origin.sessionKey!), () =>
      askDecisionForWait(origin.sessionKey!, null, "Pergunta?", { ownerContactIds: () => [OWNER] }),
    );
    expect(decision.scope).toEqual({ type: "origin", id: null });
  });
});

describe("review follow-ups (#1030)", () => {
  it("a daemon-spawned automation is not the local operator, even an operator-owned shell cron", async () => {
    const decision = await ask(await thread(), "deploy");
    process.env.RAVI_AUTOMATION_PRINCIPAL = "automation:cron:job-1";
    try {
      await expect(
        answerDecision(decision.id, "Sim", undefined, undefined, { scope: parseDecisionScope("org") }),
      ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    } finally {
      delete process.env.RAVI_AUTOMATION_PRINCIPAL;
    }
  });

  it("an answer beyond its thread must fit the turn context; a long thread answer is marked as cut", async () => {
    const origin = await thread();
    const decision = await ask(origin, "deploy");
    await expect(
      answerDecision(decision.id, "x".repeat(WIDE_DECISION_ANSWER_MAX + 1), undefined, undefined, {
        scope: parseDecisionScope("org"),
      }),
    ).rejects.toMatchObject({ code: "DECISION_INVALID_ANSWER" });
    await answerDecision(decision.id, "y".repeat(WIDE_DECISION_ANSWER_MAX + 50));
    const section = buildDecisionsInForceSection({ agentId: "main", sessionKey: origin.sessionKey! })!;
    expect(section).toContain(
      "[the answer continues; its full text was delivered to this thread when it was answered]",
    );
  });

  it("an older answer cannot replace a newer one", async () => {
    const origin = await thread();
    const older = await operatorAnswer(origin, "older", "thread");
    const newer = await operatorAnswer(origin, "newer", "thread");
    decisionWrite((db) => runThreadMutation(db, "UPDATE decisions SET answered_at=? WHERE id=?", 1_000, older.id));
    decisionWrite((db) => runThreadMutation(db, "UPDATE decisions SET answered_at=? WHERE id=?", 2_000, newer.id));
    expect(() => supersedeDecision(newer.id, older.id)).toThrow(
      expect.objectContaining({ code: "DECISION_NOT_ANSWERED" }),
    );
    expect(getDecision(newer.id)?.status).toBe("answered");
  });

  it("a replaced answer not yet handed to its thread is withdrawn", async () => {
    const origin = await thread();
    const old = await operatorAnswer(origin, "old", "thread");
    const deliveries = () =>
      (
        getDb()
          .query("SELECT status FROM decision_deliveries WHERE decision_id=? AND kind='answer'")
          .all(old.id) as Array<{ status: string }>
      ).map((d) => d.status);
    expect(deliveries()).toEqual(["pending"]);
    const next = await operatorAnswer(origin, "next", "thread");
    supersedeDecision(old.id, next.id);
    expect(deliveries()).toEqual(["superseded"]);
  });

  it("the waiting worker cannot replace its own thread's decision", async () => {
    const origin = await thread();
    const old = await operatorAnswer(origin, "old", "thread");
    const next = await operatorAnswer(origin, "next", "thread");
    await expect(
      runWithContext(caller(origin.sessionKey!), async () => supersedeDecision(old.id, next.id)),
    ).rejects.toMatchObject({ code: "DECISION_SELF_ANSWER" });
    expect(getDecision(old.id)?.status).toBe("answered");
  });

  it("a live runtime's next turn gets the current list only when it changed", async () => {
    const origin = await thread();
    const input = { agentId: "main", sessionKey: origin.sessionKey! };
    const first = refreshDecisionsForTurn(input, null);
    expect(first.block).toBeNull();
    const org = await operatorAnswer(origin, "org-rule", "org");
    const changed = refreshDecisionsForTurn(input, first.current);
    expect(changed.block).toContain("Decisions in force changed");
    expect(changed.block).toContain(org.id);
    expect(refreshDecisionsForTurn(input, changed.current).block).toBeNull();
    const next = await operatorAnswer(origin, "org-next", "org");
    supersedeDecision(org.id, next.id);
    const replaced = refreshDecisionsForTurn(input, changed.current);
    expect(replaced.block).toContain(next.id);
    expect(replaced.block).not.toContain(org.id);
  });
});
