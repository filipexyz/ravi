import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { getDb, dbUpsertChat } from "../router/router-db.js";
import { getOrCreateSession, getSession, deleteSession, updateSessionName } from "../router/index.js";
import {
  createSlackThreadLifecycle,
  markSlackThreadRootDelivered,
  closeSlackThreadLifecycle,
} from "../channels/slack/thread-lifecycle-store.js";
import { finalizeSlackThreadCreation, summarizeSlackThread } from "../channels/slack/thread-lifecycle.js";
import { getSlackThreadLifecycle } from "../channels/slack/thread-lifecycle-store.js";
import { migrateDecisions } from "./schema.js";
import {
  askDecision,
  answerDecision,
  requireVisibleDecision,
  resolveDecisionOrigin,
  visibleDecisions,
} from "./service.js";
import { getDecision, listDecisions, askDecisionRecord, answerDecisionRecord } from "./store.js";
import {
  admitDecisionAnswer as admit,
  decisionDeliveries,
  reconcileDecisionDeliveries,
  resetFailedDecisionDeliveries,
  resolveUncertainDecisionDelivery,
  type DecisionDeliveryDeps,
} from "./delivery.js";
import type { RuntimeLaunchPrompt } from "../runtime/message-types.js";
import type { DecisionOrigin } from "./types.js";

let state: string | null = null;
beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-generic-decisions-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(state);
  state = null;
});

function caller(sessionKey: string, agentId = "main"): ToolContext {
  const session = getSession(sessionKey);
  return {
    agentId,
    sessionKey,
    sessionName: session?.name ?? sessionKey,
    context: {
      contextId: `ctx_${sessionKey}`,
      contextKey: "fixture",
      kind: "agent-runtime",
      agentId,
      sessionKey,
      sessionName: session?.name ?? sessionKey,
      capabilities: [{ permission: "execute", objectType: "group", objectId: "decisions" }],
      createdAt: Date.now(),
    },
  };
}

async function thread(suffix = "1"): Promise<DecisionOrigin> {
  getOrCreateSession("decision-parent", "main", state!, { name: "decision-parent", chatType: "channel" });
  const root = dbUpsertChat({
    channel: "slack",
    instanceId: "fixture-slack",
    platformChatId: "C123",
    chatType: "channel",
  });
  const id = `thread-fixture-${suffix}`;
  createSlackThreadLifecycle({
    requestId: id,
    parentSessionKey: "decision-parent",
    parentSessionName: "decision-parent",
    accountId: "fixture-slack",
    instanceId: "fixture-slack",
    platformChatId: "C123",
    rootCanonicalChatId: root.id,
    initialPrompt: "Publish report\nPrepare the report for review.",
  });
  markSlackThreadRootDelivered({
    requestId: id,
    providerThreadId: `1713000000.000${suffix.padStart(3, "0")}`,
    canonicalRootMessageId: `root-${suffix}`,
  });
  const result = await finalizeSlackThreadCreation(id, { publishPrompt: async () => {}, publishEvent: async () => {} });
  return resolveDecisionOrigin(undefined, result.childSessionName!);
}

const deps = (published: RuntimeLaunchPrompt[], fail = false): DecisionDeliveryDeps => ({
  publishPrompt: async (_name, payload) => {
    if (fail) throw new Error("offline");
    published.push(payload as unknown as RuntimeLaunchPrompt);
  },
  publishOutbound: async () => ({ ok: true }),
});
const admitDecisionAnswer = (
  name: string,
  prompt: RuntimeLaunchPrompt,
  handle: (prompt: RuntimeLaunchPrompt) => Promise<void>,
) => admit(name, prompt, handle, deps([]));

describe("generic decisions and managed threads", () => {
  it("binds canonical chat and waiting session; re-asks preserve age and audit; identical retry sends no second question", async () => {
    const origin = await thread();
    const first = await runWithContext(caller(origin.sessionKey!), () =>
      askDecision(origin, {
        key: "Window",
        ask: "When?",
        ownerType: "human",
        ownerId: "contact-fixture",
        blocks: true,
      }),
    );
    const second = await runWithContext(caller(origin.sessionKey!), () =>
      askDecision(origin, {
        key: "window",
        ask: "When exactly?",
        ownerType: "human",
        ownerId: "contact-fixture",
        blocks: true,
      }),
    );
    expect(second.decision.id).toBe(first.decision.id);
    expect(second.decision.askedAt).toBe(first.decision.askedAt);
    expect(second.decision.askedBy).toBe(first.decision.askedBy);
    expect(second.decision.origin).toEqual(origin);
    await runWithContext(caller(origin.sessionKey!), () =>
      askDecision(origin, {
        key: "window",
        ask: "When exactly?",
        ownerType: "human",
        ownerId: "contact-fixture",
        blocks: true,
      }),
    );
    expect(decisionDeliveries(first.decision.id)).toHaveLength(2);
    expect(getDb().query("SELECT * FROM decision_history WHERE decision_id=?").all(first.decision.id)).toHaveLength(2);
    expect(summarizeSlackThread(getSlackThreadLifecycle(origin.id)!).openDecisionCount).toBe(1);
  });

  it("hides a sibling thread and refuses self-answer even with a forged provenance label", async () => {
    const origin = await thread();
    const sibling = await thread("2");
    const { decision } = await runWithContext(caller(origin.sessionKey!), () =>
      askDecision(origin, { key: "window", ask: "When?" }),
    );
    await expect(
      runWithContext(caller(origin.sessionKey!), () => answerDecision(decision.id, "Now", "operator")),
    ).rejects.toMatchObject({ code: "DECISION_SELF_ANSWER" });
    await expect(
      runWithContext(caller(sibling.sessionKey!), () => answerDecision(decision.id, "Now")),
    ).rejects.toMatchObject({ code: "DECISION_NOT_FOUND" });
    expect(() => runWithContext(caller(sibling.sessionKey!), () => requireVisibleDecision(decision.id))).toThrow(
      "not found",
    );
    expect(runWithContext(caller(sibling.sessionKey!), () => visibleDecisions())).toEqual([]);
    expect(getDecision(decision.id)?.status).toBe("open");
  });

  it("blocks closure for every open decision and until an answer is admitted, then delivers once across duplicate publications", async () => {
    const origin = await thread();
    const { decision } = await runWithContext(caller(origin.sessionKey!), () =>
      askDecision(origin, { key: "owner", ask: "Who?", ownerType: "agent", ownerId: "main", blocks: false }),
    );
    expect(() => closeSlackThreadLifecycle({ childSessionKey: origin.sessionKey! })).toThrow("open decision");
    await runWithContext(caller("decision-parent"), () => answerDecision(decision.id, "Team A"));
    await expect(
      runWithContext(caller("decision-parent"), () => answerDecision(decision.id, "Team B")),
    ).rejects.toMatchObject({ code: "DECISION_NOT_OPEN" });
    expect(() => closeSlackThreadLifecycle({ childSessionKey: origin.sessionKey! })).toThrow("undelivered answer");
    const published: RuntimeLaunchPrompt[] = [];
    await reconcileDecisionDeliveries(deps(published), decision.id);
    expect(published).toHaveLength(1);
    let admissions = 0;
    const name = getSession(origin.sessionKey!)!.name!;
    await admitDecisionAnswer(name, published[0]!, async () => {
      admissions++;
    });
    await admitDecisionAnswer(name, published[0]!, async () => {
      admissions++;
    });
    resetFailedDecisionDeliveries(decision.id);
    await reconcileDecisionDeliveries(deps(published), decision.id);
    expect(admissions).toBe(1);
    expect(published).toHaveLength(1);
    expect(decisionDeliveries(decision.id).find((d) => d.kind === "answer")?.status).toBe("delivered");
    expect(closeSlackThreadLifecycle({ childSessionKey: origin.sessionKey! }).changed).toBe(true);
  });

  it("retries confirmed publication failure with the same id and rejects cross-session or altered envelopes", async () => {
    const origin = await thread();
    const sibling = await thread("2");
    const { decision } = await askDecision(origin, { key: "window", ask: "When?" });
    await answerDecision(decision.id, "After 18h");
    await reconcileDecisionDeliveries(deps([], true), decision.id);
    const first = decisionDeliveries(decision.id).find((d) => d.kind === "answer")!;
    expect(first.status).toBe("failed");
    resetFailedDecisionDeliveries(decision.id);
    const published: RuntimeLaunchPrompt[] = [];
    await reconcileDecisionDeliveries(deps(published), decision.id);
    expect(published[0]?._decisionDeliveryId).toBe(first.id);
    await expect(
      admitDecisionAnswer(getSession(sibling.sessionKey!)!.name!, published[0]!, async () => {}),
    ).rejects.toMatchObject({ code: "DECISION_ORIGIN_MISMATCH" });
    await expect(
      admitDecisionAnswer(
        getSession(origin.sessionKey!)!.name!,
        { ...published[0]!, prompt: "forged" },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "DECISION_ORIGIN_MISMATCH" });
    expect(getDecision(decision.id)?.answer).toBe("After 18h");
  });

  it("does not repeat ambiguous runtime admission and preserves the answer after failure", async () => {
    const origin = await thread();
    const { decision } = await askDecision(origin, { key: "window", ask: "When?" });
    await answerDecision(decision.id, "Now");
    const published: RuntimeLaunchPrompt[] = [];
    await reconcileDecisionDeliveries(deps(published), decision.id);
    await expect(
      admitDecisionAnswer(getSession(origin.sessionKey!)!.name!, published[0]!, async () => {
        throw new Error("started then crashed");
      }),
    ).rejects.toThrow("crashed");
    expect(decisionDeliveries(decision.id).find((d) => d.kind === "answer")?.status).toBe("uncertain");
    expect(() => resetFailedDecisionDeliveries(decision.id)).toThrow("uncertain");
    let repeat = false;
    await admitDecisionAnswer(getSession(origin.sessionKey!)!.name!, published[0]!, async () => {
      repeat = true;
    });
    expect(() =>
      runWithContext(caller(origin.sessionKey!), () =>
        resolveUncertainDecisionDelivery(decision.id, "received", "trace fixture"),
      ),
    ).toThrow("local operator");
    resolveUncertainDecisionDelivery(decision.id, "received", "Trace fixture confirms runtime admission");
    expect(decisionDeliveries(decision.id).find((d) => d.kind === "answer")?.status).toBe("delivered");
    expect(repeat).toBe(false);
    expect(getDecision(decision.id)?.answer).toBe("Now");
  });

  it("follows a renamed session key but refuses a deleted/replaced child or changed chat binding", async () => {
    const origin = await thread();
    const { decision } = await askDecision(origin, { key: "window", ask: "When?" });
    await answerDecision(decision.id, "Now");
    updateSessionName(origin.sessionKey!, "renamed-child");
    const published: RuntimeLaunchPrompt[] = [];
    await reconcileDecisionDeliveries(deps(published), decision.id);
    expect(published).toHaveLength(1);
    deleteSession(origin.sessionKey!);
    getOrCreateSession("unrelated-key", "main", state!, { name: "replacement-child" });
    await expect(admitDecisionAnswer("replacement-child", published[0]!, async () => {})).rejects.toMatchObject({
      code: "DECISION_ORIGIN_MISMATCH",
    });
    expect(getDecision(decision.id)?.origin.sessionKey).toBe(origin.sessionKey);
  });

  it("rejects user-overlay automation writes and changed canonical chat bindings", async () => {
    const origin = await thread();
    const ctx = caller(origin.sessionKey!);
    ctx.context!.metadata = { actorAuthorizationMode: "user-overlay" };
    await expect(runWithContext(ctx, () => askDecision(origin, { key: "k", ask: "Question" }))).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(listDecisions(origin)).toEqual([]);
    const { decision } = await askDecision(origin, { key: "k", ask: "Question" });
    await answerDecision(decision.id, "Yes");
    getDb().query("UPDATE chats SET platform_chat_id='C_OTHER#123' WHERE id=?").run(origin.chatId!);
    const published: RuntimeLaunchPrompt[] = [];
    await reconcileDecisionDeliveries(deps(published), decision.id);
    expect(published).toEqual([]);
    expect(decisionDeliveries(decision.id).find((d) => d.kind === "answer")?.status).toBe("failed");
  });

  it("keeps question publication identical across failure and rename; clears the card after admission", async () => {
    const origin = await thread();
    const { decision } = await askDecision(origin, { key: "k", ask: "Question" });
    const jobs: Array<Parameters<DecisionDeliveryDeps["publishOutbound"]>[0]> = [];
    const published: RuntimeLaunchPrompt[] = [];
    const transport: DecisionDeliveryDeps = {
      ...deps(published),
      publishOutbound: async (job) => {
        jobs.push(job);
        return { ok: false };
      },
    };
    await reconcileDecisionDeliveries(transport, decision.id);
    updateSessionName(origin.sessionKey!, "renamed-question-child");
    transport.publishOutbound = async (job) => {
      jobs.push(job);
      return { ok: true };
    };
    resetFailedDecisionDeliveries(decision.id);
    await reconcileDecisionDeliveries(transport, decision.id);
    // The question job is frozen; card edits have independent ids.
    const questions = jobs.filter((job) => JSON.stringify(job).includes("Decisão pendente: k"));
    expect(questions).toHaveLength(2);
    expect(questions[1]).toEqual(questions[0]);
    await answerDecision(decision.id, "Yes");
    await reconcileDecisionDeliveries(transport, decision.id);
    await admit("renamed-question-child", published[0]!, async () => {}, transport);
    expect(JSON.stringify(jobs.at(-1))).not.toContain("entrega pendente");
    expect(JSON.stringify(jobs.at(-1))).not.toContain('"waiting"');
  });

  it("allows an evidenced operator retry after an expired admission lease, retaining the delivery id and audit", async () => {
    const origin = await thread();
    const { decision } = await askDecision(origin, { key: "k", ask: "Question" });
    await answerDecision(decision.id, "Yes");
    const published: RuntimeLaunchPrompt[] = [];
    await reconcileDecisionDeliveries(deps(published), decision.id);
    const id = published[0]!._decisionDeliveryId!;
    getDb().query("UPDATE decision_deliveries SET status='accepting',claim_until=0 WHERE id=?").run(id);
    await reconcileDecisionDeliveries(deps(published), decision.id);
    expect(() => resetFailedDecisionDeliveries(decision.id)).toThrow("uncertain");
    resolveUncertainDecisionDelivery(decision.id, "not_received", "fixture trace has no admission");
    await reconcileDecisionDeliveries(deps(published), decision.id);
    expect(published[1]!._decisionDeliveryId).toBe(id);
    let admitted = 0;
    await admitDecisionAnswer(getSession(origin.sessionKey!)!.name!, published[1]!, async () => {
      admitted++;
    });
    await admitDecisionAnswer(getSession(origin.sessionKey!)!.name!, published[0]!, async () => {
      admitted++;
    });
    expect(admitted).toBe(1);
    expect(
      getDb().query("SELECT * FROM decision_history WHERE type='delivery_resolved' AND decision_id=?").all(decision.id),
    ).toHaveLength(1);
  });

  it("retains old answered rows when a key is reused and prevents stale ids from answering the new question", () => {
    const origin: DecisionOrigin = { type: "task", id: "fixture", chatId: null, sessionKey: null };
    const first = askDecisionRecord(origin, { key: "k", ask: "First?" }).decision;
    answerDecisionRecord(first.id, "One", "actor");
    const second = askDecisionRecord(origin, { key: "k", ask: "Second?" }).decision;
    expect(() => answerDecisionRecord(first.id, "Two", "other")).toThrow("immutable");
    expect(getDecision(second.id)?.status).toBe("open");
    expect(listDecisions(origin)).toHaveLength(2);
  });
});

describe("decision schema migration (memory fixtures only)", () => {
  it("rolls back a colliding legacy import without losing either ledger", () => {
    const db = new Database(":memory:");
    migrateDecisions(db);
    db.exec(`INSERT INTO decisions(id,origin_type,origin_id,key,status,owner_type,ask,asked_at,created_at,updated_at) VALUES('same','task','t','k','open','unassigned','Existing',1,1,1);
      CREATE TABLE task_decisions AS SELECT id,origin_id AS task_id,key,status,owner_type,owner_id,ask,asked_by,asked_at,answer,answered_by,answered_at,blocks,created_at,updated_at FROM decisions;`);
    expect(() => migrateDecisions(db)).toThrow();
    expect(db.query("SELECT ask FROM task_decisions").get()).toEqual({ ask: "Existing" });
    expect(db.query("SELECT * FROM decisions").all()).toHaveLength(1);
    expect(db.query("SELECT * FROM decision_history").all()).toEqual([]);
    db.close();
  });
  it("preserves every legacy field and audit row and is idempotent", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE task_decisions(id TEXT PRIMARY KEY,task_id TEXT,key TEXT,status TEXT,owner_type TEXT,owner_id TEXT,ask TEXT,asked_by TEXT,asked_at INTEGER,answer TEXT,answered_by TEXT,answered_at INTEGER,blocks INTEGER,created_at INTEGER,updated_at INTEGER);
      CREATE TABLE task_events(id INTEGER,type TEXT); INSERT INTO task_events VALUES(1,'task.decision.answered');`);
    const rows = [
      ["dec_open", "task_1", "k", "open", "human", "person", "Question", "worker", 1, null, null, null, 1, 1, 2],
      [
        "dec_answer",
        "task_1",
        "k",
        "answered",
        "agent",
        "main",
        "Old question",
        "old-worker",
        3,
        "Outcome",
        "operator",
        4,
        0,
        3,
        4,
      ],
      ["dec_sup", "task_2", "k", "superseded", "unassigned", null, "Retired", "worker", 5, null, null, null, 0, 5, 6],
    ];
    for (const row of rows)
      db.query("INSERT INTO task_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        ...(row as (string | number | null)[]),
      );
    migrateDecisions(db);
    migrateDecisions(db);
    const actual = db
      .query(
        "SELECT id,origin_id,key,status,owner_type,owner_id,ask,asked_by,asked_at,answer,answered_by,answered_at,blocks,created_at,updated_at FROM decisions ORDER BY id",
      )
      .values() as unknown[][];
    expect(actual).toEqual([...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect(db.query("SELECT * FROM decision_history").all()).toHaveLength(3);
    expect(db.query("SELECT * FROM task_events").all()).toHaveLength(1);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='task_decisions'").get()).toBeNull();
    expect(db.query("SELECT * FROM decision_deliveries").all()).toEqual([]);
    db.close();
  });
});
