import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { renameSessionName } from "../router/sessions.js";
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
  validateDecisionMutation,
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
import { resolveRuntimeSessionIdentity } from "../runtime/session-resolver.js";
import type { RuntimeLaunchPrompt } from "../runtime/message-types.js";
import { DecisionDispatchRejectedError } from "./model.js";
import { dbCreateTask, dbDispatchTask, dbDecideTask } from "../tasks/task-db.js";
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

  it("uses nested authenticated identity for self-answer and actor provenance", async () => {
    const origin = await thread();
    const worker = { context: caller(origin.sessionKey!).context };
    const { decision } = await runWithContext(worker, () => askDecision(origin, { key: "k", ask: "Question" }));
    await expect(
      runWithContext(worker, () => answerDecision(decision.id, "My guess", "operator")),
    ).rejects.toMatchObject({ code: "DECISION_SELF_ANSWER" });
    expect(decision.askedBy).toBe(getSession(origin.sessionKey!)!.name!);
    const parent = { context: caller("decision-parent").context };
    const answered = await runWithContext(parent, () => answerDecision(decision.id, "Recorded outcome"));
    expect(answered.answeredBy).toBe("decision-parent");
    const payload = JSON.parse(
      (
        getDb()
          .query("SELECT payload_json FROM decision_deliveries WHERE decision_id=? AND kind='answer'")
          .get(decision.id) as { payload_json: string }
      ).payload_json,
    );
    expect(payload._turnOrigin.principal).toEqual({ type: "agent", id: "main" });
    expect(payload._turnOrigin.callerContextId).toBe(parent.context!.contextId);
  });

  it("retains task authorization and nested active-assignment self-answer denial", async () => {
    const { task } = dbCreateTask({ title: "Owned work", instructions: "fixture", createdByAgentId: "owner" });
    dbDispatchTask(task.id, { agentId: "owner", sessionName: "task-worker" });
    const { decision } = dbDecideTask(task.id, { key: "k", ask: "Question" });
    const outsider = caller("outsider", "outsider");
    expect(() => runWithContext(outsider, () => requireVisibleDecision(decision.id))).toThrow("not found");
    await expect(runWithContext(outsider, () => answerDecision(decision.id, "Guess"))).rejects.toMatchObject({
      code: "DECISION_NOT_FOUND",
    });
    const readonly = caller("reader", "reader");
    readonly.context!.capabilities.push({ permission: "read", objectType: "task", objectId: task.id });
    expect(runWithContext(readonly, () => requireVisibleDecision(decision.id)).id).toBe(decision.id);
    await expect(runWithContext(readonly, () => answerDecision(decision.id, "Guess"))).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    const worker = { context: caller("task-worker", "owner").context };
    await expect(runWithContext(worker, () => answerDecision(decision.id, "Guess", "human"))).rejects.toMatchObject({
      code: "DECISION_SELF_ANSWER",
    });
    readonly.context!.capabilities.push({ permission: "mutate", objectType: "task", objectId: task.id });
    runWithContext(readonly, () =>
      validateDecisionMutation(
        { type: "task", id: task.id, chatId: null, sessionKey: null },
        "answer",
        getDecision(decision.id)!,
      ),
    );
    expect(getDecision(decision.id)!.status).toBe("open");
  });

  it("keeps active task self-answer protection when its existing runtime session is renamed", async () => {
    getOrCreateSession("canonical-worker-key", "main", state!, { name: "task-worker-alias" });
    const { task } = dbCreateTask({ title: "Owned work", instructions: "fixture", createdByAgentId: "main" });
    dbDispatchTask(task.id, { agentId: "main", sessionName: "task-worker-alias" });
    const { decision } = dbDecideTask(task.id, { key: "k", ask: "Question" });
    const before = getDb()
      .query("SELECT assigned_at,checkpoint_due_at,checkpoint_overdue_count FROM task_assignments WHERE task_id=?")
      .get(task.id);
    renameSessionName("canonical-worker-key", "renamed-task-worker");
    expect(getDb().query("SELECT assignee_session_name FROM tasks WHERE id=?").get(task.id)).toEqual({
      assignee_session_name: "renamed-task-worker",
    });
    expect(
      getDb()
        .query("SELECT assigned_at,checkpoint_due_at,checkpoint_overdue_count FROM task_assignments WHERE task_id=?")
        .get(task.id),
    ).toEqual(before);
    expect(() =>
      runWithContext(caller("canonical-worker-key"), () =>
        validateDecisionMutation(
          { type: "task", id: task.id, chatId: null, sessionKey: null },
          "answer",
          getDecision(decision.id)!,
        ),
      ),
    ).toThrow("waiting worker");
    expect(getDecision(decision.id)!.askedBy).toBeNull();
  });

  it("requires modify as well as read access for a non-parent session", async () => {
    const origin = await thread();
    const sibling = await thread("2");
    const { decision } = await askDecision(origin, { key: "k", ask: "Question" });
    const allowed = caller(sibling.sessionKey!);
    allowed.context!.capabilities.push({ permission: "access", objectType: "session", objectId: origin.sessionKey! });
    expect(runWithContext(allowed, () => requireVisibleDecision(decision.id)).id).toBe(decision.id);
    await expect(runWithContext(allowed, () => answerDecision(decision.id, "Guess"))).rejects.toMatchObject({
      code: "DECISION_NOT_FOUND",
    });
    allowed.context!.capabilities.push({ permission: "modify", objectType: "session", objectId: origin.sessionKey! });
    expect(
      (await runWithContext(allowed, () => answerDecision(decision.id, "Explicit authorized outcome"))).status,
    ).toBe("answered");
  });

  it("claims concurrent deliveries once and keeps closure blocked during admission", async () => {
    const origin = await thread();
    const { decision } = await askDecision(origin, { key: "k", ask: "Question" });
    await answerDecision(decision.id, "Outcome");
    const published: RuntimeLaunchPrompt[] = [];
    await reconcileDecisionDeliveries(deps(published), decision.id);
    let release!: () => void;
    let admissions = 0;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const name = getSession(origin.sessionKey!)!.name!;
    const first = admitDecisionAnswer(name, published[0]!, async () => {
      admissions++;
      await barrier;
    });
    await admitDecisionAnswer(name, published[0]!, async () => {
      admissions++;
    });
    expect(admissions).toBe(1);
    expect(() => closeSlackThreadLifecycle({ childSessionKey: origin.sessionKey! })).toThrow("undelivered answer");
    release();
    await first;
    expect(decisionDeliveries(decision.id).find((d) => d.kind === "answer")?.status).toBe("delivered");
  });

  it("records a verified pre-dispatch rejection as retryable rather than delivered or uncertain", async () => {
    const origin = await thread();
    const { decision } = await askDecision(origin, { key: "k", ask: "Question" });
    await answerDecision(decision.id, "Outcome");
    const published: RuntimeLaunchPrompt[] = [];
    await reconcileDecisionDeliveries(deps(published), decision.id);
    const name = getSession(origin.sessionKey!)!.name!;
    await expect(
      admitDecisionAnswer(name, published[0]!, async () => {
        throw new DecisionDispatchRejectedError();
      }),
    ).rejects.toThrow("not admitted");
    expect(decisionDeliveries(decision.id).find((d) => d.kind === "answer")).toMatchObject({
      status: "failed",
      lastError: "DECISION_AGENT_MISSING",
    });
    expect(() => closeSlackThreadLifecycle({ childSessionKey: origin.sessionKey! })).toThrow("undelivered answer");
    resetFailedDecisionDeliveries(decision.id);
    await admitDecisionAnswer(name, published[0]!, async () => {});
    expect(decisionDeliveries(decision.id).find((d) => d.kind === "answer")?.status).toBe("delivered");
  });

  it("re-reads a frozen payload when another reconciler overtakes its batch", async () => {
    const origin = await thread();
    const first = (await askDecision(origin, { key: "a", ask: "First?" })).decision;
    const second = (await askDecision(origin, { key: "b", ask: "Second?" })).decision;
    // Stable FIFO order for the deterministic interleaving below.
    getDb().query("UPDATE decision_deliveries SET created_at=0 WHERE decision_id=?").run(first.id);
    const firstId = decisionDeliveries(first.id)[0]!.id;
    const secondId = decisionDeliveries(second.id)[0]!.id;
    const attempts: unknown[] = [];
    let overtaken = false;
    const transport: DecisionDeliveryDeps = {
      ...deps([]),
      publishOutbound: async (job) => {
        if (job.request.idempotencyKey === secondId) {
          attempts.push(job);
          return { ok: false };
        }
        if (job.request.idempotencyKey === firstId && !overtaken) {
          overtaken = true;
          await reconcileDecisionDeliveries(transport, second.id);
          updateSessionName(origin.sessionKey!, "renamed-between-claims");
          resetFailedDecisionDeliveries(second.id);
        }
        return { ok: true };
      },
    };
    await reconcileDecisionDeliveries(transport);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
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
    const automation = process.env.RAVI_AUTOMATION_PRINCIPAL;
    try {
      process.env.RAVI_AUTOMATION_PRINCIPAL = "automation:cron:fixture";
      expect(() => resolveUncertainDecisionDelivery(decision.id, "received", "untrusted worker claim")).toThrow(
        "local operator",
      );
    } finally {
      if (automation === undefined) delete process.env.RAVI_AUTOMATION_PRINCIPAL;
      else process.env.RAVI_AUTOMATION_PRINCIPAL = automation;
    }
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

  it("rechecks the pinned session after async preflight before runtime launch", async () => {
    const origin = await thread();
    const { decision } = await askDecision(origin, { key: "k", ask: "Question" });
    await answerDecision(decision.id, "Outcome");
    const published: RuntimeLaunchPrompt[] = [];
    await reconcileDecisionDeliveries(deps(published), decision.id);
    const name = getSession(origin.sessionKey!)!.name!;
    await expect(
      admitDecisionAnswer(name, published[0]!, async (frozen) => {
        updateSessionName(origin.sessionKey!, "renamed-during-preflight");
        getOrCreateSession("replacement-key", "main", state!, { name });
        resolveRuntimeSessionIdentity({ sessionName: name, prompt: frozen });
      }),
    ).rejects.toMatchObject({ code: "DECISION_ORIGIN_MISMATCH" });
    expect(decisionDeliveries(decision.id).find((d) => d.kind === "answer")?.status).toBe("uncertain");
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
