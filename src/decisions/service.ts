import { runThreadMutation } from "../threads/schema-fence.js";
import { buildSessionRelayTurnOrigin } from "../runtime/turn-origin.js";
import { CliExpectedError } from "../cli/expected-error.js";
import { canAccessSession, canModifySession, getScopeContext, isScopeEnforced } from "../permissions/scope.js";
import { assertNoUserOverlayAutomationWrite } from "../permissions/user-overlay-automation.js";
import { resolveSession } from "../router/sessions.js";
import {
  dbGetChat,
  dbGetChatMessage,
  type ChatMessageRecord,
  dbListChatMessagesByProviderId,
  dbListSessionChatSubscriptions,
  getDb,
} from "../router/router-db.js";
import { acknowledgeHandoffsForDecision, type Handoff } from "../handoffs/store.js";
import { publishHandoffEvent } from "../handoffs/events.js";
import { findContactsByTag } from "../contacts.js";
import { OWNER_CONTACT_TAG } from "../knowledge/owner.js";
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
import {
  askDecisionRecord,
  answerDecisionRecord,
  decisionWrite,
  getDecision,
  listDecisions,
  recordDecisionAnswerSource,
} from "./store.js";
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
  const ctx = getScopeContext();
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
  const ctx = getScopeContext();
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

/**
 * The answer's source: one stored message written by the decision's human owner, after the question was asked,
 * in the decision's own chat or in a direct chat (the owner talking to the agent). Accepts the internal message
 * id or the provider id (looked up only among those chats). A decision with no human owner has no valid source.
 * Every refusal has the same code and text, so a caller cannot learn whether a message exists or who wrote it.
 * The answer text itself is still written by whoever records it: the source proves who decided, not the wording.
 */
export function resolveDecisionAnswerSource(
  decision: Decision,
  messageRef: string,
): { contactId: string; messageId: string } {
  const refuse = (): never => {
    throw new DecisionError(
      "DECISION_SOURCE_NOT_OWNER",
      "The source must be one message the decision's owner wrote after the question, in its chat or a direct chat.",
      { exitCode: 2, suggestedAction: "Pass the id of the owner's message that holds the answer." },
    );
  };
  const ref = messageRef.trim();
  if (!ref || decision.ownerType !== "human" || !decision.ownerId) return refuse();
  const eligible = (message: ChatMessageRecord): boolean => {
    if (message.actorType !== "contact" || message.contactId !== decision.ownerId) return false;
    if ((message.providerTimestamp ?? message.createdAt) < decision.askedAt) return false;
    if (decision.origin.chatId && message.chatId === decision.origin.chatId) return true;
    return dbGetChat(message.chatId)?.chatType === "dm";
  };
  const direct = dbGetChatMessage(ref);
  const candidates = (direct ? [direct] : dbListChatMessagesByProviderId(ref)).filter(eligible);
  if (candidates.length !== 1) return refuse();
  const message = candidates[0]!;
  return { contactId: message.contactId!, messageId: message.id };
}

/** A free-text label is provenance only: brackets are dropped so it cannot imitate the verified source marker. */
function answerLabel(by: string | undefined): string | null {
  const label = by?.replace(/[[\]]/g, "").trim();
  return label ? label : null;
}

export async function answerDecision(id: string, text: string, by?: string, sourceMessage?: string) {
  const decision = requireVisibleDecision(id);
  const who = actor();
  // A supplied source must resolve, even when blank: absence is valid, an unusable source is not.
  if (sourceMessage !== undefined) resolveDecisionAnswerSource(decision, sourceMessage);
  const label = answerLabel(by);
  let closedWaits: Handoff[] = [];
  const now = Date.now();
  const result = decisionWrite((db) => {
    const current = requireVisibleDecision(id);
    validateDecisionMutation(current.origin, "answer", current);
    // Rechecked against the decision this transaction commits: its owner may have changed since the check above.
    const source = sourceMessage !== undefined ? resolveDecisionAnswerSource(current, sourceMessage) : null;
    const subject = [
      label ? `for ${label}` : null,
      source ? `[source contact:${source.contactId} message:${source.messageId}]` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const provenance = subject ? `${who.actor} (${subject})` : who.actor;
    if (current.origin.type === "task")
      return answerTaskDecision(current.origin.id, { key: current.key, answer: text, ...who, actor: provenance });
    const answered = answerDecisionRecord(id, text, provenance);
    if (source) recordDecisionAnswerSource(answered, source, who.actor);
    const { record, chat } = requireDecisionThread(current.origin);
    const deliveryId = `decision:${id}:answer:${answered.revision}`;
    const scope = getScopeContext();
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
      _decisionSessionKey: current.origin.sessionKey,
      _turnOrigin: buildSessionRelayTurnOrigin("answer", {
        ...scope,
        contextId: scope.contextId ?? scope.context?.contextId,
      }),
    };
    runThreadMutation(
      getDb(),
      "UPDATE decision_deliveries SET payload_json=? WHERE id=?",
      JSON.stringify(payload),
      deliveryId,
    );
    // The wait that asked this question closes with the answer, in the same transaction.
    closedWaits = acknowledgeHandoffsForDecision(db, id, `decision answered: ${id}`, now);
    return { decision: answered };
  });
  if ("event" in result) await emitTaskEvent(result.task, result.event);
  for (const handoff of closedWaits) await publishHandoffEvent("acknowledged", handoff, now);
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

/** A stable decision key from a wait's ref: lowercase slug, or `default` when the wait names nothing. */
export function decisionKeyForWait(ref: string | null | undefined): string {
  const slug = (ref ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64)
    .replace(/[-._]+$/g, "");
  return slug || "default";
}

/**
 * `sessions report --awaiting decision` from a thread: record the question as a decision of that thread, owned
 * by the installation's owner (the single `permission-owner` contact) when there is exactly one. Asked again
 * with the same ref, it updates the same open decision instead of opening another.
 */
export async function askDecisionForWait(
  childSessionKey: string,
  ref: string | null | undefined,
  question: string,
  deps: { ownerContactIds?: () => string[] } = {},
): Promise<Decision> {
  const origin = resolveDecisionOrigin(undefined, childSessionKey);
  const owners = [...new Set((deps.ownerContactIds ?? defaultOwnerContactIds)())];
  const owner =
    owners.length === 1 ? { ownerType: "human" as const, ownerId: owners[0]! } : { ownerType: "unassigned" as const };
  const { decision } = await askDecision(origin, {
    key: decisionKeyForWait(ref),
    ask: question,
    blocks: true,
    ...owner,
  });
  return decision;
}

function defaultOwnerContactIds(): string[] {
  return findContactsByTag(OWNER_CONTACT_TAG).map((contact) => contact.id);
}
