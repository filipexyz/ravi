import { runThreadMutation } from "../threads/schema-fence.js";
import { buildSessionRelayTurnOrigin } from "../runtime/turn-origin.js";
import { CliExpectedError } from "../cli/expected-error.js";
import { canAccessSession, canModifySession, getScopeContext, isScopeEnforced } from "../permissions/scope.js";
import { assertNoUserOverlayAutomationWrite } from "../permissions/user-overlay-automation.js";
import { resolveSession } from "../router/sessions.js";
import { hasRuntimeInvocationContext } from "../cli/context.js";
import { readSpawnedAutomationPrincipal } from "../runtime/turn-origin.js";
import {
  dbFindChat,
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
import { isInstallationOwner } from "./org-tag.js";
import {
  askDecisionRecord,
  answerDecisionRecord,
  decisionWrite,
  getDecision,
  listDecisions,
  recordDecisionAnswerSource,
  settleAnsweredDecisionScope,
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

/** A stored message's text: `content.text`, else its text blocks (the channel backend's shape). */
export function chatMessageText(message: Pick<ChatMessageRecord, "content">): string {
  const content = message.content;
  if (typeof content?.text === "string") return content.text;
  const blocks = Array.isArray(content?.blocks) ? (content.blocks as unknown[]) : [];
  return blocks
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
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
/**
 * Keep in step with the provider-id query in `dbListChatMessagesByProviderId` (src/router/router-db.ts), which
 * narrows to the same chats in SQL before its row limit; this check runs after it, so a mismatch fails closed.
 *
 * A direct chat with a person: the DM itself or a thread inside it. A Slack thread of a DM is stored as its own
 * chat (`chat_type = thread`, platform id `<dm>#<thread ts>`); the owner writing in it is still writing directly.
 */
function isDirectChat(chatId: string): boolean {
  const chat = dbGetChat(chatId);
  if (!chat) return false;
  if (chat.chatType === "dm") return true;
  if (chat.chatType !== "thread") return false;
  const hash = chat.platformChatId.lastIndexOf("#");
  if (hash <= 0) return false;
  // The channel adapter records the parent's kind on the thread chat; older thread chats rely on the parent row.
  if (chat.metadata?.parentChatType === "dm") return true;
  const parent = dbFindChat({
    channel: chat.channel,
    instanceId: chat.instanceId,
    platformChatId: chat.platformChatId.slice(0, hash),
  });
  return parent?.chatType === "dm";
}

export function resolveDecisionAnswerSource(
  decision: Decision,
  messageRef: string,
  quote?: string,
): DecisionAnswerSource {
  const howTo =
    "Pass the id of the owner's message that holds the answer, and --source-quote with a passage it contains unless it names the decision id.";
  // A message that is not the owner's, an agent's, or one that does not exist get one code and one text: the
  // caller cannot tell a missing message from someone else's. The finer codes below are only for the owner's own.
  const refuse = (): never => {
    throw new DecisionError(
      "DECISION_SOURCE_NOT_OWNER",
      "The source must be one message the decision's owner wrote after the question, in its chat or a direct chat, naming the decision id or containing the quoted passage.",
      { exitCode: 2, suggestedAction: howTo },
    );
  };
  const refuseOwn = (
    code: "DECISION_SOURCE_BEFORE_QUESTION" | "DECISION_SOURCE_AMBIGUOUS" | "DECISION_SOURCE_NO_MATCH",
    message: string,
  ): never => {
    throw new DecisionError(code, message, { exitCode: 2, suggestedAction: howTo });
  };
  const ref = messageRef.trim();
  if (!ref || decision.ownerType !== "human" || !decision.ownerId) return refuse();
  const ownerId = decision.ownerId;
  // The current wording: a message sent before the question was last revised did not answer it.
  const sourceSince = Math.max(decision.askedAt, decision.revisedAt);
  const byOwner = (message: ChatMessageRecord): boolean =>
    message.actorType === "contact" && message.contactId === ownerId;
  const inAllowedChat = (message: ChatMessageRecord): boolean =>
    (Boolean(decision.origin.chatId) && message.chatId === decision.origin.chatId) || isDirectChat(message.chatId);
  const direct = dbGetChatMessage(ref);
  // A provider id can repeat across many chats: the eligible ones are narrowed in the query, before its row limit.
  const eligible = (
    direct
      ? [direct]
      : dbListChatMessagesByProviderId(ref, { contactId: ownerId, since: sourceSince, chatId: decision.origin.chatId })
  ).filter((message) => byOwner(message) && chatMessageTime(message) >= sourceSince && inAllowedChat(message));
  // Nothing eligible: say why only when the message is the owner's own (the wider read is just for that).
  const owned = eligible.length ? eligible : (direct ? [direct] : dbListChatMessagesByProviderId(ref)).filter(byOwner);
  if (!owned.length) return refuse();
  // A message of the owner in another chat gets the generic refusal too: a finer code would tell the caller that
  // the owner wrote there, in a chat the caller may not read. Finer codes are only for the chats that may answer.
  const reachable = owned.filter(inAllowedChat);
  if (!reachable.length) return refuse();
  const candidates = reachable.filter((message) => chatMessageTime(message) >= sourceSince);
  if (!candidates.length)
    return refuseOwn(
      "DECISION_SOURCE_BEFORE_QUESTION",
      "That message of the owner was written before the question (or before its last revision), so it does not answer it.",
    );
  if (candidates.length > 1)
    return refuseOwn(
      "DECISION_SOURCE_AMBIGUOUS",
      "That provider id matches more than one message of the owner; pass the Ravi message id instead.",
    );
  const message = candidates[0]!;
  const text = chatMessageText(message);
  const cited = quote?.replace(/\s+/g, " ").trim() ?? "";
  let excerpt: string;
  if (cited) {
    if (cited.length < SOURCE_QUOTE_MIN || !normalizeForQuote(text).includes(normalizeForQuote(cited)))
      return refuseOwn("DECISION_SOURCE_NO_MATCH", "The owner's message does not contain the quoted passage.");
    excerpt = cited;
  } else {
    if (!text.includes(decision.id))
      return refuseOwn(
        "DECISION_SOURCE_NO_MATCH",
        "The owner's message does not name the decision id; pass --source-quote with a passage it contains.",
      );
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where the owner approves the audience: the message starts with `<id> <scope>:` (spaces or `,;-` allowed between id
 * and scope) and the answer is what follows the colon. Anything else never widens: text before the pair, or words
 * glued to the scope without `:` ("dec_x org jamais", "dec_x org não, só desta thread"), whatever they mean. Matched on
 * the original text, case-insensitively. Returns the span of the approving pair, or null; in doubt, null.
 */
export function findOwnerScopeApproval(
  text: string,
  decisionId: string,
  scope: DecisionScope,
): { start: number; end: number } | null {
  const pattern = new RegExp(
    `^(\\s*)${escapeRegExp(decisionId)}[\\s,;-]*${escapeRegExp(decisionScopeLiteral(scope))}\\s*:`,
    "iu",
  );
  const match = pattern.exec(text);
  if (!match) return null;
  return { start: match[1]!.length, end: match[0].length };
}

export function ownerApprovesScope(text: string, decisionId: string, scope: DecisionScope): boolean {
  return findOwnerScopeApproval(text, decisionId, scope) !== null;
}

function normalizeAnswerText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * What the owner decided, in their words: the message without the approving `<id> <scope>` pair and the separators
 * around it. A wide answer must be exactly this, so the recorder cannot pick a fragment that means the opposite.
 */
export function ownerAnswerText(text: string, span: { start: number; end: number }): string {
  const before = text.slice(0, span.start).replace(/[\s:,;.-]+$/u, "");
  const after = text.slice(span.end).replace(/^[\s:,;.-]+/u, "");
  return [before, after].filter(Boolean).join(" ");
}

/**
 * A decision beyond its thread or task reaches other agents' turns, so it needs the owner's verified word (a bound
 * source) or the local operator. An agent never widens a decision on its own authority, however broad its grants.
 */
export function assertDecisionScopeAuthority(
  scope: DecisionScope,
  source: DecisionAnswerSource | null,
  decisionId: string,
  answerText?: string,
): void {
  if (scope.type === "origin" || isLocalOperatorCaller()) return;
  // Only the installation's owner widens: a decision's `--owner` is chosen by whoever asks, so it never authorizes.
  // The owner approves the audience (`<id> <scope>`) and the words: the recorded answer is in the same message.
  const approval = source ? findOwnerScopeApproval(source.text, decisionId, scope) : null;
  if (
    source &&
    approval &&
    isInstallationOwner(source.contactId) &&
    (answerText === undefined ||
      normalizeAnswerText(ownerAnswerText(source.text, approval)) === normalizeAnswerText(answerText))
  )
    return;
  const literal = decisionScopeLiteral(scope);
  throw new DecisionError(
    "DECISION_SCOPE_NOT_AUTHORIZED",
    `A decision for ${literal} needs the installation owner's message with "${decisionId} ${literal}" and the answer text, as --source-message, or the local operator.`,
    {
      exitCode: 2,
      suggestedAction: `Ask the owner to reply "${decisionId} ${literal}: <answer>", or keep the default thread scope.`,
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
  replacement: { scope: DecisionScope; ownerSourced: boolean; answeredAt: number | null },
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
  if (replacement.ownerSourced && (replacement.scope.type === "org" || sameDecisionScope(replacement.scope, old.scope)))
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
  /**
   * The answer came from the owner's own verified click on the decision's card (a channel interaction, never text):
   * the contact the platform resolved, the card's revision, and the interaction id kept as provenance. It replaces
   * the source message and never falls back to the local operator's authority.
   */
  verifiedOwner?: VerifiedOwnerAnswer;
}

export interface VerifiedOwnerAnswer {
  contactId: string;
  revision: number;
  ref: string;
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
  if (options.verifiedOwner) return checkVerifiedOwnerAnswer(decision, sourceMessage, options, text);
  // A supplied source must resolve, even when blank: absence is valid, an unusable source is not.
  const source =
    sourceMessage !== undefined ? resolveDecisionAnswerSource(decision, sourceMessage, options.sourceQuote) : null;
  const scope = options.scope ?? decision.scope;
  assertDecisionScopeAuthority(scope, source, decision.id, text);
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
    assertSupersedeAuthority(replaced, {
      scope,
      ownerSourced: Boolean(source && isInstallationOwner(source.contactId)),
      answeredAt: Date.now(),
    });
  }
  return { source, scope, replaced };
}

/**
 * The owner answering on the decision's card. The click is the binding: the decision, its revision and the scope come
 * from the card and the interaction, and the person from the platform's verified sender, so no text is matched. It
 * answers only the revision shown, only as the decision's own human owner, and widens only to the org and only when
 * that owner is the installation owner. The local operator's authority never applies here.
 */
function checkVerifiedOwnerAnswer(
  decision: Decision,
  sourceMessage: string | undefined,
  options: DecisionAnswerOptions,
  text?: string,
): { source: null; scope: DecisionScope; replaced: null } {
  const owner = options.verifiedOwner!;
  if (sourceMessage !== undefined || options.sourceQuote !== undefined || options.supersedes !== undefined)
    throw new DecisionError("DECISION_INVALID_ANSWER", "A card answer carries no source message nor replacement.", {
      exitCode: 2,
    });
  if (decision.status !== "open" || decision.revision !== owner.revision)
    throw new DecisionError("DECISION_STALE_CARD", "This card shows an older question or one already answered.", {
      exitCode: 2,
    });
  if (decision.ownerType !== "human" || !owner.contactId || decision.ownerId !== owner.contactId)
    throw new DecisionError("DECISION_SOURCE_NOT_OWNER", "Only the decision's owner answers on its card.", {
      exitCode: 2,
    });
  const scope = options.scope ?? { type: "origin" as const, id: null };
  if (scope.type !== "origin" && !(scope.type === "org" && isInstallationOwner(owner.contactId)))
    throw new DecisionError(
      "DECISION_SCOPE_NOT_AUTHORIZED",
      "Only the installation owner widens a decision from its card, and only to the org.",
      { exitCode: 2 },
    );
  if (text !== undefined && !text.trim())
    throw new DecisionError("DECISION_INVALID_ANSWER", "The answer is empty.", { exitCode: 2 });
  if (scope.type !== "origin" && text !== undefined && text.trim().length > WIDE_DECISION_ANSWER_MAX)
    throw new DecisionError(
      "DECISION_INVALID_ANSWER",
      `An answer beyond its thread or task must fit ${WIDE_DECISION_ANSWER_MAX} characters: every turn in scope carries it whole.`,
      { exitCode: 2 },
    );
  return { source: null, scope, replaced: null };
}

export async function answerDecision(
  id: string,
  text: string,
  by?: string,
  sourceMessage?: string,
  options: DecisionAnswerOptions = {},
) {
  const decision = requireVisibleDecision(id);
  // A card answer is the owner's own: named by the verified contact, never as whoever runs the consumer.
  const who = options.verifiedOwner
    ? { actor: `card:${options.verifiedOwner.contactId}`, agentId: undefined, sessionName: undefined }
    : actor();
  checkDecisionAnswer(decision, sourceMessage, options, text);
  const label = answerLabel(by);
  let closedWaits: Handoff[] = [];
  const now = Date.now();
  const result = decisionWrite((db) => {
    const current = requireVisibleDecision(id);
    validateDecisionMutation(current.origin, "answer", current);
    // Rechecked against the decision this transaction commits: its owner or scope may have changed since.
    const { source, scope, replaced } = checkDecisionAnswer(current, sourceMessage, options, text);
    const owner = options.verifiedOwner;
    const subject = [
      label ? `for ${label}` : null,
      source ? `[source contact:${source.contactId} message:${source.messageId}]` : null,
      owner ? `[card contact:${owner.contactId} interaction:${owner.ref}]` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const provenance = subject ? `${who.actor} (${subject})` : who.actor;
    const finish = () => {
      if (source)
        recordDecisionAnswerSource(
          getDecision(id)!,
          { contactId: source.contactId, messageId: source.messageId, excerpt: source.excerpt },
          who.actor,
        );
      // The owner's click is the source: the interaction id, and the answer as they submitted it.
      else if (owner)
        recordDecisionAnswerSource(
          getDecision(id)!,
          { contactId: owner.contactId, messageId: owner.ref, excerpt: text.trim().slice(0, SOURCE_EXCERPT_MAX) },
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
      if (scope.type !== "origin") settleAnsweredDecisionScope(id, scope);
      finish();
      return answeredTask;
    }
    const answered = answerDecisionRecord(id, text, provenance, scope);
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
    // The recorded source's author is the decision's human owner; it counts only if that is the installation owner.
    ownerSourced:
      Boolean(replacement.sourceMessageId) &&
      replacement.ownerType === "human" &&
      isInstallationOwner(replacement.ownerId),
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
  const rows = getDb()
    .query(
      "SELECT id,type,actor,snapshot_json AS snapshot,created_at AS createdAt FROM decision_history WHERE decision_id=? ORDER BY id",
    )
    .all(id) as Array<{ id: number; type: string; actor: string | null; snapshot: string; createdAt: number }>;
  // A card form's binding (its platform id and who it was opened for) answers a submission; it is never shown.
  return rows.map((row) =>
    row.type === "card-form-opened"
      ? { ...row, actor: null, snapshot: JSON.stringify(cardFormSummary(row.snapshot)) }
      : row,
  );
}

function cardFormSummary(snapshot: string): { revision: number | null; channel: string | null } {
  try {
    const form = JSON.parse(snapshot) as { revision?: unknown; channel?: unknown };
    return {
      revision: typeof form.revision === "number" ? form.revision : null,
      channel: typeof form.channel === "string" ? form.channel : null,
    };
  } catch {
    // no-cause: An unreadable card form row shows nothing of it.
    return { revision: null, channel: null };
  }
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
