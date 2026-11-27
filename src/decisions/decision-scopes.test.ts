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
import { answerDecisionRecord, decisionWrite, getDecision, listDecisionsInForce } from "./store.js";
import { admitDecisionAnswer, reconcileDecisionDeliveries } from "./delivery.js";
import { ORG_DECISIONS_AGENT_TAG, buildDecisionsInForceSection, refreshDecisionsForTurn } from "./prompt.js";
import { createContact } from "../contacts.js";
import { attachTagSlugsToAsset, canonicalTagSlugsForAsset } from "../tags/helpers.js";
import { dbDeleteTagBinding } from "../tags/tag-db.js";
import { assertOrgInternalTagWriteAllowed, seedOrgInternalTagOnce } from "./org-tag.js";
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
  // The installation's owner (tag `permission-owner`), and `main` working for the org.
  OWNER = createContact({ phone: "5511900000990", name: "Owner", tags: ["permission-owner"], status: "allowed" }).id;
  attachTagSlugsToAsset({ assetType: "agent", assetId: "main", tags: [ORG_DECISIONS_AGENT_TAG], source: "test" });
});
afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[key] = value;
  await cleanupIsolatedRaviState(state);
  state = null;
});

let OWNER = "";
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
    const msg = ownerSays(`${decision.id} org: sim`);
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
    // An agent not tagged as working for the org (a client-facing one) never carries org decisions.
    expect(buildDecisionsInForceSection({ agentId: "other-agent" }) ?? "").not.toContain(org.id);
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

    const msg = ownerSays(`${next.id} org: troca`);
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

  it("an answer beyond its thread must fit the turn context; a thread's own long answer reaches it whole", async () => {
    const origin = await thread();
    const decision = await ask(origin, "deploy");
    await expect(
      answerDecision(decision.id, "x".repeat(WIDE_DECISION_ANSWER_MAX + 1), undefined, undefined, {
        scope: parseDecisionScope("org"),
      }),
    ).rejects.toMatchObject({ code: "DECISION_INVALID_ANSWER" });
    const long = `${"y".repeat(WIDE_DECISION_ANSWER_MAX + 50)} exceto em produção`;
    await answerDecision(decision.id, long);
    const section = buildDecisionsInForceSection({ agentId: "main", sessionKey: origin.sessionKey! })!;
    expect(section).toContain(JSON.stringify(long));
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

describe("CodeRabbit follow-ups (#1030)", () => {
  it("a source must not predate the current wording of the question", async () => {
    const origin = await thread();
    const decision = await ask(origin, "deploy");
    decisionWrite((db) =>
      runThreadMutation(
        db,
        "UPDATE decisions SET asked_at=asked_at-10000,revised_at=revised_at-10000 WHERE id=?",
        decision.id,
      ),
    );
    const beforeRevision = ownerSays(`${decision.id} sim`, { providerTimestamp: decision.askedAt - 5000 });
    const reasked = await runWithContext(caller(origin.sessionKey!), () =>
      askDecision(origin, { key: "deploy", ask: "Pergunta nova?", ownerType: "human", ownerId: OWNER, blocks: true }),
    );
    expect(reasked.decision.revisedAt).toBeGreaterThan(reasked.decision.askedAt);
    expect(() => resolveDecisionAnswerSource(reasked.decision, beforeRevision.id)).toThrow(
      expect.objectContaining({ code: "DECISION_SOURCE_NOT_OWNER" }),
    );
    const after = ownerSays(`${decision.id} sim`);
    expect(resolveDecisionAnswerSource(reasked.decision, after.id).messageId).toBe(after.id);
  });

  it("reads the owner's text from content blocks", async () => {
    const decision = await ask(await thread(), "deploy");
    const msg = dbUpsertChatMessage({
      chatId: ownerDm().id,
      channel: "slack",
      instanceId: "fixture-slack",
      providerMessageId: "m-blocks",
      rawChatId: "D-owner",
      actorType: "contact",
      contactId: OWNER,
      content: { blocks: [{ type: "text", text: `${decision.id} org` }] },
    }).message;
    expect(resolveDecisionAnswerSource(decision, msg.id)).toMatchObject({ namesDecision: true });
  });

  it("keeps the exact whitespace of an answer in the turn", async () => {
    const origin = await thread();
    const decision = await ask(origin, "pattern");
    await answerDecision(decision.id, 'Use "^a  b$".\nSó isso.');
    const section = buildDecisionsInForceSection({ agentId: "main", sessionKey: origin.sessionKey! })!;
    expect(section).toContain(JSON.stringify('Use "^a  b$".\nSó isso.'));
  });

  it("an answer recorded without a checked scope stays in its origin, whatever was proposed", async () => {
    const origin = await thread();
    const proposed = await ask(origin, "deploy", "org");
    const answered = decisionWrite(() => answerDecisionRecord(proposed.id, "Sim", "someone"));
    expect(answered.scope).toEqual({ type: "origin", id: null });
  });

  it("a replaced decision's published answer is withdrawn and never admitted", async () => {
    const origin = await thread();
    const old = await operatorAnswer(origin, "old", "thread");
    decisionWrite((db) =>
      runThreadMutation(db, "UPDATE decision_deliveries SET status='published' WHERE decision_id=?", old.id),
    );
    const row = getDb()
      .query("SELECT id,payload_json AS payload FROM decision_deliveries WHERE decision_id=? AND kind='answer'")
      .get(old.id) as { id: string; payload: string };
    const next = await operatorAnswer(origin, "next", "thread");
    supersedeDecision(old.id, next.id);
    expect(
      (getDb().query("SELECT status FROM decision_deliveries WHERE id=?").get(row.id) as { status: string }).status,
    ).toBe("superseded");
    let handled = 0;
    const session = getSession(origin.sessionKey!)!;
    expect(
      await admitDecisionAnswer(session.name ?? session.sessionKey, JSON.parse(row.payload), async () => {
        handled += 1;
      }),
    ).toBe(true);
    expect(handled).toBe(0);
  });

  it("decisions list filters by a normalized scope and by origin type", async () => {
    const origin = await thread();
    const agentScoped = await operatorAnswer(origin, "agent-main", "agent:main");
    const inThread = await operatorAnswer(origin, "in-thread", "thread");
    const { DecisionsCommands } = await import("../cli/commands/decisions.js");
    const command = new DecisionsCommands();
    const ids = async (scope: string) =>
      (await command.list(undefined, undefined, true, scope, undefined, true)).decisions.map((d) => d.id);
    expect(await ids("agent: main")).toEqual([agentScoped.id]);
    expect(await ids("thread")).toEqual([inThread.id]);
    expect(await ids("task")).toEqual([]);
  });
});

describe("CodeRabbit second round (#1030)", () => {
  it("a decision re-asked before revised_at existed takes its last change as the source cutoff", async () => {
    const origin = await thread();
    const decision = await ask(origin, "legacy");
    decisionWrite((db) =>
      runThreadMutation(
        db,
        "UPDATE decisions SET revised_at=NULL,revision=2,asked_at=asked_at-20000,updated_at=asked_at-5000 WHERE id=?",
        decision.id,
      ),
    );
    const legacy = getDecision(decision.id)!;
    expect(legacy.revisedAt).toBe(legacy.askedAt + 15000);
    const between = ownerSays(`${decision.id} sim`, { providerTimestamp: legacy.askedAt + 10000 });
    expect(() => resolveDecisionAnswerSource(legacy, between.id)).toThrow(
      expect.objectContaining({ code: "DECISION_SOURCE_NOT_OWNER" }),
    );
  });

  it("an answer whose publication is in flight when it is replaced ends superseded and is never admitted", async () => {
    const origin = await thread();
    const old = await operatorAnswer(origin, "old", "thread");
    let release: () => void = () => {};
    let published: Record<string, unknown> | null = null;
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reconcile = reconcileDecisionDeliveries(
      {
        publishPrompt: (async (_name: string, payload: Record<string, unknown>) => {
          if ((payload as { _decisionDeliveryId?: string })._decisionDeliveryId?.startsWith(`decision:${old.id}:`)) {
            published = payload;
            entered();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
        }) as never,
        publishOutbound: async () => ({ ok: true }),
      },
      old.id,
    );
    await inFlight;
    const statusOf = () =>
      (
        getDb().query("SELECT status FROM decision_deliveries WHERE decision_id=? AND kind='answer'").get(old.id) as {
          status: string;
        }
      ).status;
    expect(statusOf()).toBe("publishing");
    const next = await operatorAnswer(origin, "next", "thread");
    supersedeDecision(old.id, next.id);
    release();
    await reconcile;
    expect(statusOf()).toBe("superseded");
    let handled = 0;
    const session = getSession(origin.sessionKey!)!;
    expect(
      await admitDecisionAnswer(session.name ?? session.sessionKey, published as never, async () => {
        handled += 1;
      }),
    ).toBe(true);
    expect(handled).toBe(0);
  });
});

describe("independent review of c67913f (#1030)", () => {
  it("B1: a designated owner who is not the installation owner never widens", async () => {
    const origin = await thread();
    const stranger = createContact({ phone: "5511900000991", name: "Cliente", status: "allowed" }).id;
    const { decision } = await runWithContext(caller(origin.sessionKey!), () =>
      askDecision(origin, {
        key: "client-rule",
        ask: "Vale pra todos?",
        ownerType: "human",
        ownerId: stranger,
        scope: parseDecisionScope("org"),
      }),
    );
    const msg = ownerSays(`${decision.id} org: sim`, { contactId: stranger });
    await expect(
      asParent(() => answerDecision(decision.id, "sim", undefined, msg.id, { scope: parseDecisionScope("org") })),
    ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    // Their word still answers the decision in its own thread.
    const answered = await asParent(() =>
      answerDecision(decision.id, "sim", undefined, msg.id, { scope: parseDecisionScope("thread") }),
    );
    expect(answered.scope).toEqual({ type: "origin", id: null });
  });

  it("B1: a replacement sourced by a non-owner cannot replace an org decision", async () => {
    const origin = await thread();
    const old = await operatorAnswer(origin, "old", "org");
    const stranger = createContact({ phone: "5511900000992", name: "Cliente", status: "allowed" }).id;
    const { decision: next } = await runWithContext(caller(origin.sessionKey!), () =>
      askDecision(origin, { key: "next", ask: "Troca?", ownerType: "human", ownerId: stranger }),
    );
    const msg = ownerSays(`${next.id} org: troca`, { contactId: stranger });
    await expect(
      asParent(() => answerDecision(next.id, "troca", undefined, msg.id, { supersedes: old.id })),
    ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    const replacement = await asParent(() => answerDecision(next.id, "troca", undefined, msg.id));
    await expect(asParent(async () => supersedeDecision(old.id, replacement.id))).rejects.toMatchObject({
      code: "DECISION_SCOPE_NOT_AUTHORIZED",
    });
    expect(getDecision(old.id)?.status).toBe("answered");
  });

  it("B1: an operator-widened replacement whose source is not the installation owner does not let an agent replace", async () => {
    const origin = await thread();
    const old = await operatorAnswer(origin, "old", "org");
    const stranger = createContact({ phone: "5511900000993", name: "Cliente", status: "allowed" }).id;
    const { decision: next } = await runWithContext(caller(origin.sessionKey!), () =>
      askDecision(origin, { key: "next", ask: "Troca?", ownerType: "human", ownerId: stranger }),
    );
    const msg = ownerSays(`${next.id} org: troca`, { contactId: stranger });
    // The operator may widen with any source; the source still is not the installation owner's word.
    const replacement = await answerDecision(next.id, "troca", undefined, msg.id, { scope: parseDecisionScope("org") });
    expect(replacement.sourceMessageId).toBe(msg.id);
    await expect(asParent(async () => supersedeDecision(old.id, replacement.id))).rejects.toMatchObject({
      code: "DECISION_SCOPE_NOT_AUTHORIZED",
    });
  });

  it("N1: the owner's message must contain the recorded answer", async () => {
    const decision = await ask(await thread(), "deploy");
    const msg = ownerSays(`${decision.id} org: sem confirmação em grupos`);
    await expect(
      asParent(() =>
        answerDecision(decision.id, "Confirmar sempre em grupos", undefined, msg.id, {
          scope: parseDecisionScope("org"),
        }),
      ),
    ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    const answered = await asParent(() =>
      answerDecision(decision.id, "Sem confirmação em grupos", undefined, msg.id, {
        scope: parseDecisionScope("org"),
      }),
    );
    expect(answered.scope).toEqual({ type: "org", id: null });
  });

  it("N2/N5: a negation word before the id or a scope away from it never widens", async () => {
    const decision = await ask(await thread(), "deploy");
    for (const text of [
      `não ${decision.id} org: sim`,
      `nunca, ${decision.id} org: sim`,
      `${decision.id}, não org: sim`,
      `${decision.id} sim, mas org fica de fora`,
    ]) {
      const msg = ownerSays(text);
      await expect(
        asParent(() => answerDecision(decision.id, "sim", undefined, msg.id, { scope: parseDecisionScope("org") })),
      ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    }
  });

  it("N2: a negation before the id refuses even when the answer is the rest of the message", async () => {
    const decision = await ask(await thread(), "deploy");
    const msg = ownerSays(`não ${decision.id} org: sim`);
    await expect(
      asParent(() => answerDecision(decision.id, "não sim", undefined, msg.id, { scope: parseDecisionScope("org") })),
    ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
  });

  it("N5: a prohibition after the colon is the answer; text before the pair never widens", async () => {
    const origin = await thread();
    const prohibition = await ask(origin, "api");
    const msg = ownerSays(`${prohibition.id} org: não use a api v1`);
    const answered = await asParent(() =>
      answerDecision(prohibition.id, "Não use a API v1", undefined, msg.id, { scope: parseDecisionScope("org") }),
    );
    expect(answered.scope).toEqual({ type: "org", id: null });
    // Text before the pair never widens, whatever it says.
    const plan = await ask(origin, "plan");
    const planMsg = ownerSays(`aprovado no plano ${plan.id} org: use B`);
    await expect(
      asParent(() =>
        answerDecision(plan.id, "aprovado no plano use B", undefined, planMsg.id, { scope: parseDecisionScope("org") }),
      ),
    ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
  });

  it("N7: a negation right after the scope, without a colon, never widens", async () => {
    const decision = await ask(await thread(), "deploy");
    for (const [text, answer] of [
      [`${decision.id} org não, só desta thread`, "não, só desta thread"],
      [`${decision.id} org? não`, "? não"],
      [`${decision.id} org nunca`, "nunca"],
    ] as const) {
      const msg = ownerSays(text);
      await expect(
        asParent(() => answerDecision(decision.id, answer, undefined, msg.id, { scope: parseDecisionScope("org") })),
      ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    }
  });

  it("N8: the answer is cut from the original text even when lowercasing changes its length", async () => {
    const decision = await ask(await thread(), "city");
    const msg = ownerSays(`  ${decision.id} ORG : İstanbul ok, não use X`);
    const answered = await asParent(() =>
      answerDecision(decision.id, "İstanbul ok, não use X", undefined, msg.id, { scope: parseDecisionScope("org") }),
    );
    expect(answered.scope).toEqual({ type: "org", id: null });
  });

  it("N9: words glued to the scope without a colon never widen, whatever they mean", async () => {
    const decision = await ask(await thread(), "deploy");
    for (const [text, answer] of [
      [`${decision.id} org jamais`, "jamais"],
      [`${decision.id} org só desta thread`, "só desta thread"],
      [`${decision.id} org sem confirmar`, "sem confirmar"],
      [`${decision.id} org`, "org"],
    ] as const) {
      const msg = ownerSays(text);
      await expect(
        asParent(() => answerDecision(decision.id, answer, undefined, msg.id, { scope: parseDecisionScope("org") })),
      ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    }
  });

  it("N4: a wide answer is the owner's whole message, never a fragment of it", async () => {
    const decision = await ask(await thread(), "tool");
    const msg = ownerSays(`${decision.id} org: sim, mas não deve usar X`);
    for (const fragment of ["deve usar X", "sim"])
      await expect(
        asParent(() => answerDecision(decision.id, fragment, undefined, msg.id, { scope: parseDecisionScope("org") })),
      ).rejects.toMatchObject({ code: "DECISION_SCOPE_NOT_AUTHORIZED" });
    const whole = await asParent(() =>
      answerDecision(decision.id, "sim, mas não deve usar X", undefined, msg.id, { scope: parseDecisionScope("org") }),
    );
    expect(whole.answer).toBe("sim, mas não deve usar X");
  });

  it("N6: only the installation owner or the local operator sets org-internal", async () => {
    await thread();
    const deny = () => assertOrgInternalTagWriteAllowed("tags attach", "org-internal");
    expect(() => runWithContext(caller(PARENT), deny)).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() =>
      runWithContext(caller(PARENT), () => assertOrgInternalTagWriteAllowed("tags attach", "other")),
    ).not.toThrow();
    const withAuthority = (contactId: string): ToolContext => {
      const base = caller(PARENT);
      return { ...base, context: { ...base.context!, metadata: { ownerAuthority: `contact:${contactId}` } } };
    };
    expect(() => runWithContext(withAuthority(OWNER), deny)).not.toThrow();
    const stranger = createContact({ phone: "5511900000994", name: "Cliente", status: "allowed" }).id;
    expect(() => runWithContext(withAuthority(stranger), deny)).toThrow(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
    expect(deny).not.toThrow();
    const { TagCommands } = await import("../cli/commands/tags.js");
    expect(() =>
      runWithContext(caller(PARENT), () => new TagCommands().attach("org-internal", "client-agent")),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("N6: main is tagged org-internal once; removing it afterwards is respected", async () => {
    await thread();
    dbDeleteTagBinding({ slug: ORG_DECISIONS_AGENT_TAG, assetType: "agent", assetId: "main" });
    seedOrgInternalTagOnce();
    expect(canonicalTagSlugsForAsset("agent", "main")).toContain(ORG_DECISIONS_AGENT_TAG);
    dbDeleteTagBinding({ slug: ORG_DECISIONS_AGENT_TAG, assetType: "agent", assetId: "main" });
    seedOrgInternalTagOnce();
    expect(canonicalTagSlugsForAsset("agent", "main")).not.toContain(ORG_DECISIONS_AGENT_TAG);
  });

  it("N3: org decisions reach only agents tagged as working for the org", async () => {
    const origin = await thread();
    const org = await operatorAnswer(origin, "org-rule", "org");
    const clientOwn = await operatorAnswer(origin, "client-own", "agent:client-agent");
    const clientSection = buildDecisionsInForceSection({ agentId: "client-agent" })!;
    expect(clientSection).toContain(clientOwn.id);
    expect(clientSection).not.toContain(org.id);
    expect(buildDecisionsInForceSection({ agentId: "main" })).toContain(org.id);
  });
});
