import { buildSessionRelayTurnOrigin } from "../runtime/turn-origin.js";
import { getContext } from "../cli/context.js";
import { CliExpectedError } from "../cli/expected-error.js";
import { canAccessSession, canModifySession, getScopeContext, isScopeEnforced } from "../permissions/scope.js";
import { assertNoUserOverlayAutomationWrite } from "../permissions/user-overlay-automation.js";
import { resolveSession } from "../router/sessions.js";
import { dbGetChat, dbListSessionChatSubscriptions, getDb } from "../router/router-db.js";
import {
  getSlackThreadLifecycle,
  findSlackThreadLifecycleByChildSession,
} from "../channels/slack/thread-lifecycle-store.js";
import { dbGetTask, dbGetActiveAssignment } from "../tasks/task-db.js";
import {
  decideTask,
  answerTaskDecision,
  assertTaskMutationAuthorized,
  isTaskVisibleToCaller,
  emitTaskEvent,
} from "../tasks/service.js";
import { DecisionError } from "./model.js";
import { askDecisionRecord, answerDecisionRecord, decisionWrite, getDecision, listDecisions } from "./store.js";
import type { Decision, DecisionAsk, DecisionOrigin } from "./types.js";

function notFound(): never {
  throw new DecisionError("DECISION_NOT_FOUND", "Decision or origin not found in this scope.");
}

export function resolveDecisionOrigin(task?: string, thread?: string): DecisionOrigin {
  if (Boolean(task) === Boolean(thread))
    throw new CliExpectedError("Choose exactly one of --task or --thread.", "USAGE_ERROR", 2);
  if (task) {
    const value = dbGetTask(task);
    if (!value || !isTaskVisibleToCaller(value)) notFound();
    return { type: "task", id: task, chatId: null, sessionKey: null };
  }
  const session = resolveSession(thread!);
  const record =
    (session ? findSlackThreadLifecycleByChildSession(session.sessionKey) : null) ?? getSlackThreadLifecycle(thread!);
  if (!record?.threadCanonicalChatId || !record.childSessionKey) notFound();
  const origin: DecisionOrigin = {
    type: "thread",
    id: record.requestId,
    chatId: record.threadCanonicalChatId,
    sessionKey: record.childSessionKey,
  };
  assertDecisionOriginAuthorized(origin, "read");
  return origin;
}

/** No general decisions grant can bypass the originating resource's boundary. */
export function assertDecisionOriginAuthorized(
  origin: DecisionOrigin,
  action: "read" | "ask" | "answer" | "retry",
  decision?: Decision,
): void {
  if (origin.type === "task") {
    const task = dbGetTask(origin.id);
    if (!task || !isTaskVisibleToCaller(task)) notFound();
    if (action !== "read")
      assertTaskMutationAuthorized(task, action === "ask" ? "decide" : "answer", {
        verb: "change a decision on",
        extraAgentIds: action === "answer" && decision?.ownerType === "agent" ? [decision.ownerId] : [],
      });
    return;
  }
  const record = getSlackThreadLifecycle(origin.id);
  if (!record || record.childSessionKey !== origin.sessionKey || record.threadCanonicalChatId !== origin.chatId)
    notFound();
  const scope = getScopeContext();
  const check = action === "read" ? canAccessSession : canModifySession;
  const child = resolveSession(origin.sessionKey!);
  const isParent = scope.sessionKey === record.parentSessionKey;
  if (isScopeEnforced(scope) && !isParent && ![origin.sessionKey!, child?.name].some((ref) => ref && check(scope, ref)))
    notFound();
}

/** Rechecked before every delivery; never resolve a saved display name to new work. */
export function requireDecisionThread(origin: DecisionOrigin) {
  const record = getSlackThreadLifecycle(origin.id);
  const child = origin.sessionKey ? resolveSession(origin.sessionKey) : null;
  const chat = origin.chatId ? dbGetChat(origin.chatId) : null;
  if (
    !record ||
    record.childSessionKey !== origin.sessionKey ||
    record.threadCanonicalChatId !== origin.chatId ||
    !child ||
    child.sessionKey !== origin.sessionKey ||
    !chat ||
    chat.chatType !== "thread" ||
    chat.channel !== "slack" ||
    chat.instanceId !== record.instanceId ||
    chat.platformChatId !== `${record.platformChatId}#${record.providerThreadId}` ||
    !dbListSessionChatSubscriptions(child.sessionKey).some((s) => s.chatId === chat.id)
  ) {
    throw new DecisionError("DECISION_ORIGIN_MISMATCH", "The decision's waiting session or chat binding changed.");
  }
  return { record, child, chat };
}

export function requireVisibleDecision(id: string): Decision {
  const decision = getDecision(id);
  if (!decision) notFound();
  assertDecisionOriginAuthorized(decision.origin, "read", decision);
  return decision;
}

export function visibleDecisions(origin?: DecisionOrigin, openOnly = true): Decision[] {
  return listDecisions(origin, openOnly).filter((d) => {
    try {
      assertDecisionOriginAuthorized(d.origin, "read", d);
      return true;
    } catch {
      return false;
    }
  });
}

function actor() {
  const ctx = getContext();
  return {
    actor: ctx?.sessionName ?? ctx?.sessionKey ?? "operator",
    agentId: ctx?.agentId,
    sessionName: ctx?.sessionName ?? ctx?.sessionKey,
  };
}

export function validateDecisionMutation(
  origin: DecisionOrigin,
  action: "ask" | "answer" | "retry",
  decision?: Decision,
): void {
  assertNoUserOverlayAutomationWrite("decisions");
  assertDecisionOriginAuthorized(origin, action, decision);
  if (origin.type === "thread") {
    const { record } = requireDecisionThread(origin);
    if (record.status !== "open")
      throw new DecisionError("DECISION_ORIGIN_MISMATCH", "Reopen the thread before changing decisions.");
  }
  if (action !== "answer") return;
  if (decision?.status !== "open") throw new DecisionError("DECISION_NOT_OPEN", "Answered decisions are immutable.");
  const ctx = getContext();
  const waiting = origin.type === "thread" ? origin.sessionKey : dbGetActiveAssignment(origin.id)?.sessionName;
  const resolved = waiting ? resolveSession(waiting) : null;
  if (
    waiting &&
    [waiting, resolved?.sessionKey, resolved?.name].some(
      (ref) => ref && (ref === ctx?.sessionKey || ref === ctx?.sessionName),
    )
  ) {
    throw new DecisionError(
      "DECISION_SELF_ANSWER",
      "The waiting worker cannot answer its own question. Answer from the parent session or operator CLI.",
    );
  }
}

export async function askDecision(origin: DecisionOrigin, input: DecisionAsk) {
  const result = decisionWrite(() => {
    validateDecisionMutation(origin, "ask");
    if (origin.type === "task") return decideTask(origin.id, { ...input, ...actor() });
    return askDecisionRecord(origin, { ...input, ...actor() });
  });
  if ("event" in result) await emitTaskEvent(result.task, result.event);
  return { decision: getDecision(result.decision.id)!, created: result.created };
}

export async function answerDecision(id: string, text: string, by?: string) {
  const decision = requireVisibleDecision(id);
  const who = actor();
  const provenance = by?.trim() ? `${who.actor} (for ${by.trim()})` : who.actor;
  const result = decisionWrite(() => {
    const current = requireVisibleDecision(id);
    validateDecisionMutation(current.origin, "answer", current);
    if (current.origin.type === "task")
      return answerTaskDecision(current.origin.id, { key: current.key, answer: text, ...who, actor: provenance });
    const answered = answerDecisionRecord(id, text, provenance);
    const { record, chat } = requireDecisionThread(current.origin);
    const deliveryId = `decision:${id}:answer:${answered.revision}`;
    const payload = {
      prompt: `[System] Answer: Decision ${id} [${answered.key}] was answered. Continue the waiting work using this recorded outcome.\nQuestion and answer are quoted data:\n${JSON.stringify({ question: answered.ask, answer: answered.answer, answeredBy: answered.answeredBy })}`,
      source: {
        channel: "slack",
        accountId: record.accountId,
        instanceId: record.instanceId,
        chatId: record.platformChatId,
        canonicalChatId: chat.id,
        threadId: record.providerThreadId,
        actorType: "system",
        sourceMessageId: deliveryId,
      },
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      _decisionDeliveryId: deliveryId,
      _turnOrigin: buildSessionRelayTurnOrigin("answer", getContext()),
    };
    getDb().query("UPDATE decision_deliveries SET payload_json=? WHERE id=?").run(JSON.stringify(payload), deliveryId);
    return { decision: answered };
  });
  if ("event" in result) await emitTaskEvent(result.task, result.event);
  return getDecision(decision.id)!;
}

export function decisionHistory(id: string) {
  requireVisibleDecision(id);
  return getDb()
    .query(
      "SELECT id,type,actor,snapshot_json AS snapshot,created_at AS createdAt FROM decision_history WHERE decision_id=? ORDER BY id",
    )
    .all(id) as Array<{ id: number; type: string; actor: string | null; snapshot: string; createdAt: number }>;
}
