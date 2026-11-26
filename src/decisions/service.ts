import { runThreadMutation } from "../threads/schema-fence.js";
import { buildSessionRelayTurnOrigin } from "../runtime/turn-origin.js";
import { CliExpectedError } from "../cli/expected-error.js";
import { canAccessSession, canModifySession, getScopeContext, isScopeEnforced } from "../permissions/scope.js";
import { assertNoUserOverlayAutomationWrite } from "../permissions/user-overlay-automation.js";
import { resolveSession } from "../router/sessions.js";
import { hasRuntimeInvocationContext } from "../cli/context.js";
import { readSpawnedAutomationPrincipal } from "../runtime/turn-origin.js";
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
import { DecisionError, formatDecisionScope, sameDecisionScope } from "./model.js";
import {
  askDecisionRecord,
  answerDecisionRecord,
  decisionWrite,
  getDecision,
  listDecisions,
  recordDecisionAnswerSource,
  setOpenDecisionScope,
  supersedeDecisionRecord,
} from "./store.js";
import type { Decision, DecisionAsk, DecisionOrigin, DecisionScope } from "./types.js";

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
  assertNotWaitingWorker(origin);
}

/** The worker waiting on an origin never answers, nor replaces, that origin's decisions. */
function assertNotWaitingWorker(origin: DecisionOrigin): void {
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

/** A message's time in ms: provider time (read as seconds below 10^12), else ingestion time. */
export function chatMessageTime(message: Pick<ChatMessageRecord, "providerTimestamp" | "createdAt">): number {
  const at = message.providerTimestamp;
  if (at === undefined || at === null) return message.createdAt;
  return at < 1_000_000_000_000 ? at * 1000 : at;
}

const SOURCE_EXCERPT_MAX = 500;
const SOURCE_QUOTE_MIN = 2;

function normalizeForQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface DecisionAnswerSource {
  contactId: string;
  messageId: string;
  /** What the owner wrote that binds the message to this decision; stored on the decision. */
  excerpt: string;
  /** The owner's message names the decision id (not only a quoted passage). */
  namesDecision: boolean;
  /** The owner's whole message, for the scope check; never stored. */
  text: string;
}

/**
 * The answer's source: one stored message written by the decision's human owner, after the question was asked,
 * in the decision's own chat or in a direct chat (the owner talking to the agent), and bound to this decision:
 * either it names the decision id, or the recorder quotes (`quote`) a passage it contains. The quote, or the
 * message itself when it names the id, is kept on the decision as the excerpt. Accepts the internal message id or
 * the provider id (looked up only among eligible messages). A decision with no human owner has no valid source.
 * Every refusal has the same code and text, so a caller cannot learn whether a message exists or who wrote it.
 */
export function resolveDecisionAnswerSource(
  decision: Decision,
  messageRef: string,
  quote?: string,
): DecisionAnswerSource {
  const refuse = (): never => {
    throw new DecisionError(
      "DECISION_SOURCE_NOT_OWNER",
      "The source must be one message the decision's owner wrote after the question, in its chat or a direct chat, naming the decision id or containing the quoted passage.",
      {
        exitCode: 2,
        suggestedAction:
          "Pass the id of the owner's message that holds the answer, and --source-quote with a passage it contains unless it names the decision id.",
      },
    );
  };
  const ref = messageRef.trim();
  if (!ref || decision.ownerType !== "human" || !decision.ownerId) return refuse();
  const ownerId = decision.ownerId;
  const eligible = (message: ChatMessageRecord): boolean => {
    if (message.actorType !== "contact" || message.contactId !== ownerId) return false;
    if (chatMessageTime(message) < decision.askedAt) return false;
    if (decision.origin.chatId && message.chatId === decision.origin.chatId) return true;
    return dbGetChat(message.chatId)?.chatType === "dm";
  };
  const direct = dbGetChatMessage(ref);
  const candidates = (
    direct
      ? [direct]
      : dbListChatMessagesByProviderId(ref, {
          contactId: ownerId,
          since: decision.askedAt,
          chatId: decision.origin.chatId,
        })
  ).filter(eligible);
  if (candidates.length !== 1) return refuse();
  const message = candidates[0]!;
  const text = typeof message.content?.text === "string" ? message.content.text : "";
  const cited = quote?.replace(/\s+/g, " ").trim() ?? "";
  let excerpt: string;
  if (cited) {
    if (cited.length < SOURCE_QUOTE_MIN || !normalizeForQuote(text).includes(normalizeForQuote(cited))) return refuse();
    excerpt = cited;
  } else {
    if (!text.includes(decision.id)) return refuse();
    excerpt = text.replace(/\s+/g, " ").trim();
  }
  return {
    contactId: message.contactId!,
    messageId: message.id,
    excerpt: excerpt.slice(0, SOURCE_EXCERPT_MAX),
    namesDecision: text.includes(decision.id),
    text,
  };
}

/** The local operator at the terminal: no agent, no runtime context, and the operator's own authority. */
export function isLocalOperatorCaller(): boolean {
  const ctx = getScopeContext();
  // Same bar as delivery recovery: a runtime invocation or a daemon-spawned automation (shell cron or trigger
  // included) is never the operator at the terminal, whatever its owner.
  if (hasRuntimeInvocationContext() || readSpawnedAutomationPrincipal()) return false;
  return !ctx.agentId && !ctx.contextId && !ctx.sessionKey && !ctx.sessionName && !isScopeEnforced(ctx);
}

/** The literal the owner writes to approve a scope: `org`, `agent:<id>` or `project:<id>`. */
export function decisionScopeLiteral(scope: DecisionScope): string {
  return scope.type === "org" ? "org" : `${scope.type}:${scope.id}`;
}

function mentionsScope(text: string, scope: DecisionScope): boolean {
  const literal = decisionScopeLiteral(scope).toLowerCase();
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_:-])${escaped}($|[^a-z0-9_:-])`).test(text.toLowerCase());
}

/**
 * A decision beyond its thread or task reaches other agents' turns, so it needs the owner's verified word (a bound
 * source) or the local operator. An agent never widens a decision on its own authority, however broad its grants.
 */
export function assertDecisionScopeAuthority(
  scope: DecisionScope,
  source: DecisionAnswerSource | null,
  decisionId: string,
): void {
  if (scope.type === "origin" || isLocalOperatorCaller()) return;
  // The owner approves the audience, not only the answer: the message names this decision and the scope.
  if (source?.namesDecision && mentionsScope(source.text, scope)) return;
  const literal = decisionScopeLiteral(scope);
  throw new DecisionError(
    "DECISION_SCOPE_NOT_AUTHORIZED",
    `A decision for ${literal} needs the owner's message naming the decision id and "${literal}" as --source-message, or the local operator.`,
    {
      exitCode: 2,
      suggestedAction: `Ask the owner to reply "${decisionId} ${literal}", or keep the default thread scope.`,
    },
  );
}

/**
 * Replacing an answered decision takes the authority of the one replaced. A thread or task decision: whoever may
 * answer on its origin. A wider one: the local operator, or a replacement the owner verifiably decided (bound
 * source) at the same breadth or the org.
 */
export function assertSupersedeAuthority(
  old: Decision,
  replacement: { scope: DecisionScope; hasOwnerSource: boolean; answeredAt: number | null },
): void {
  if (old.status !== "answered")
    throw new DecisionError("DECISION_NOT_ANSWERED", "Only an answered decision can be replaced.", { exitCode: 2 });
  if (replacement.answeredAt === null || (old.answeredAt !== null && replacement.answeredAt < old.answeredAt))
    throw new DecisionError(
      "DECISION_NOT_ANSWERED",
      "The replacement must be answered after the decision it replaces.",
      { exitCode: 2 },
    );
  if (old.scope.type === "origin") {
    assertDecisionOriginAuthorized(old.origin, "answer", old);
    assertNotWaitingWorker(old.origin);
    return;
  }
  if (isLocalOperatorCaller()) return;
  if (
    replacement.hasOwnerSource &&
    (replacement.scope.type === "org" || sameDecisionScope(replacement.scope, old.scope))
  )
    return;
  throw new DecisionError(
    "DECISION_SCOPE_NOT_AUTHORIZED",
    "Replacing a decision beyond its thread or task needs the owner's message on the replacement, at the same breadth or the org, or the local operator.",
    { exitCode: 2 },
  );
}

/** A free-text label is provenance only: brackets are dropped so it cannot imitate the verified source marker. */
function answerLabel(by: string | undefined): string | null {
  const label = by?.replace(/[[\]]/g, "").trim();
  return label ? label : null;
}

export interface DecisionAnswerOptions {
  /** Final scope; defaults to the scope the question proposed. */
  scope?: DecisionScope;
  /** Passage of the source message that holds the answer; needed unless the message names the decision id. */
  sourceQuote?: string;
  /** An answered decision this answer replaces. */
  supersedes?: string;
}

/**
 * Every check the answer makes before writing, on the decision as it is now. The CLI runs it before the dry-run
 * so a preview fails the same way; `answerDecision` runs it again inside its transaction.
 */
/** A decision read by turns beyond its thread stays whole in their context; longer text belongs in the thread. */
export const WIDE_DECISION_ANSWER_MAX = 2000;

export function checkDecisionAnswer(
  decision: Decision,
  sourceMessage: string | undefined,
  options: DecisionAnswerOptions = {},
  text?: string,
): { source: DecisionAnswerSource | null; scope: DecisionScope; replaced: Decision | null } {
  // A supplied source must resolve, even when blank: absence is valid, an unusable source is not.
  const source =
    sourceMessage !== undefined ? resolveDecisionAnswerSource(decision, sourceMessage, options.sourceQuote) : null;
  const scope = options.scope ?? decision.scope;
  assertDecisionScopeAuthority(scope, source, decision.id);
  if (scope.type !== "origin" && text !== undefined && text.trim().length > WIDE_DECISION_ANSWER_MAX)
    throw new DecisionError(
      "DECISION_INVALID_ANSWER",
      `An answer beyond its thread or task must fit ${WIDE_DECISION_ANSWER_MAX} characters: every turn in scope carries it whole.`,
      { exitCode: 2 },
    );
  let replaced: Decision | null = null;
  if (options.supersedes !== undefined) {
    replaced = getDecision(options.supersedes.trim());
    if (!replaced) notFound();
    if (replaced.id === decision.id)
      throw new DecisionError("DECISION_NOT_ANSWERED", "A decision cannot replace itself.", { exitCode: 2 });
    assertSupersedeAuthority(replaced, { scope, hasOwnerSource: Boolean(source), answeredAt: Date.now() });
  }
  return { source, scope, replaced };
}

export async function answerDecision(
  id: string,
  text: string,
  by?: string,
  sourceMessage?: string,
  options: DecisionAnswerOptions = {},
) {
  const decision = requireVisibleDecision(id);
  const who = actor();
  checkDecisionAnswer(decision, sourceMessage, options, text);
  const label = answerLabel(by);
  let closedWaits: Handoff[] = [];
  const now = Date.now();
  const result = decisionWrite((db) => {
    const current = requireVisibleDecision(id);
    validateDecisionMutation(current.origin, "answer", current);
    // Rechecked against the decision this transaction commits: its owner or scope may have changed since.
    const { source, scope, replaced } = checkDecisionAnswer(current, sourceMessage, options, text);
    const subject = [
      label ? `for ${label}` : null,
      source ? `[source contact:${source.contactId} message:${source.messageId}]` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const provenance = subject ? `${who.actor} (${subject})` : who.actor;
    setOpenDecisionScope(id, scope);
    const finish = () => {
      if (source)
        recordDecisionAnswerSource(
          getDecision(id)!,
          { contactId: source.contactId, messageId: source.messageId, excerpt: source.excerpt },
          who.actor,
        );
      if (replaced) supersedeDecisionRecord(replaced.id, id, who.actor, now);
    };
    if (current.origin.type === "task") {
      const answeredTask = answerTaskDecision(current.origin.id, {
        key: current.key,
        answer: text,
        ...who,
        actor: provenance,
      });
      finish();
      return answeredTask;
    }
    const answered = answerDecisionRecord(id, text, provenance);
    finish();
    const { record, chat } = requireDecisionThread(current.origin);
    const deliveryId = `decision:${id}:answer:${answered.revision}`;
    const scopeContext = getScopeContext();
    const payload = {
      prompt: `[System] Answer: Decision ${id} [${answered.key}] was answered. Continue the waiting work using this recorded outcome.\nQuestion and answer are quoted data:\n${JSON.stringify({ question: answered.ask, answer: answered.answer, answeredBy: answered.answeredBy, scope: formatDecisionScope(answered) })}`,
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
        ...scopeContext,
        contextId: scopeContext.contextId ?? scopeContext.context?.contextId,
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

/** Check, without writing, that `replacement` may replace `old`; both answered, the replacement visible. */
export function checkSupersede(oldId: string, replacementId: string): { old: Decision; replacement: Decision } {
  const replacement = requireVisibleDecision(replacementId);
  const old = getDecision(oldId.trim());
  if (!old) notFound();
  if (old.id === replacement.id)
    throw new DecisionError("DECISION_NOT_ANSWERED", "A decision cannot replace itself.", { exitCode: 2 });
  if (replacement.status !== "answered")
    throw new DecisionError("DECISION_NOT_ANSWERED", "The replacement must be answered first.", { exitCode: 2 });
  assertSupersedeAuthority(old, {
    scope: replacement.scope,
    hasOwnerSource: Boolean(replacement.sourceMessageId),
    answeredAt: replacement.answeredAt,
  });
  return { old, replacement };
}

/** `decisions supersede <old> --by <new>`: the old one leaves every turn's context and keeps its history. */
export function supersedeDecision(oldId: string, replacementId: string): Decision {
  assertNoUserOverlayAutomationWrite("decisions");
  return decisionWrite(() => {
    const { old, replacement } = checkSupersede(oldId, replacementId);
    return supersedeDecisionRecord(old.id, replacement.id, actor().actor);
  });
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
