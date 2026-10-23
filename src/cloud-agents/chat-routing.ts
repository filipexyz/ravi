/**
 * What a cloud run's person says in chat, routed to the run (contract F1
 * "Approvals from chat", F3 "Thread = run"):
 *
 * - `aprovar <código>` / `negar <código> [motivo]` from the run's person (the
 *   contact linked to the run's Console user) decides the approval, as that
 *   contact (`x-ravi-actor-contact`), never as the operator. From anyone
 *   else, or with an unknown code, the message goes to the agent as usual.
 * - A Slack click on the private Approve/Deny card decides the same way,
 *   only when the Slack user who clicked is the run's person.
 * - In a bound Slack thread every message of the run's person goes to the run;
 *   in a bound WhatsApp group only `@run ...` and replies to the run card do.
 *   While the run waits on a question, that message is the answer.
 *
 * The Console still decides whether the decision or message is allowed.
 */

import { respondToSlackInteraction } from "../channels/slack/interactions.js";
import { isCloudAuthError } from "../cloud-auth/errors.js";
import { nats as runtimeNats } from "../nats.js";
import { logger } from "../utils/logger.js";
import {
  CLOUD_APPROVAL_ACTION_APPROVE,
  cloudApprovalOutcomeText,
  isCloudApprovalActionId,
  parseCloudApprovalReply,
  parseRunMention,
} from "./chat-copy.js";
import {
  type CloudChatApproval,
  type CloudThreadRun,
  dbClaimCloudChatApproval,
  dbEndCloudThreadRuns,
  dbFindActiveCloudThread,
  dbFindPendingCloudChatApprovals,
  dbGetCloudChatApproval,
  dbMarkCloudChatQuestionAnswered,
  dbPendingCloudChatQuestion,
  dbSettleCloudChatApproval,
} from "./chat-db.js";
import { slackUserContactId as defaultSlackUserContactId } from "./chat-people.js";
import { normalizeChatChannel } from "./chat-target.js";
import { type CloudAgentsSession, type CloudAgentsSessionOptions, openCloudAgentsSession } from "./client.js";

const log = logger.child("cloud-agents:chat-routing");

const MESSAGE_MAX_CHARS = 100_000;

export interface CloudChatInbound {
  /** `slack`, `whatsapp` (`whatsapp-baileys` is the same), `telegram`... */
  channel: string;
  accountId: string;
  instanceId: string;
  /** Slack channel id or WhatsApp chat JID. */
  chatId: string;
  /** Slack: the root ts of the thread the message is in. */
  threadTs?: string | null;
  isGroup: boolean;
  /** The sender's contact; only a contact's message can count as the run's person. */
  contactId: string | null;
  text: string;
  /** WhatsApp: the message this one replies to. */
  replyToId?: string | null;
}

export type CloudChatRouteResult =
  | { handled: false }
  | { handled: true; kind: "approval" | "thread_message" | "question_answer"; reply: string | null };

export interface CloudChatRoutingDeps {
  openSession?: (options: CloudAgentsSessionOptions) => Promise<CloudAgentsSession | null>;
  now?: () => number;
}

export type CloudApprovalOutcome = "approved" | "denied" | "not_person" | "already_decided" | "failed";

const NOT_HANDLED: CloudChatRouteResult = { handled: false };

/** Routes one inbound chat message to a cloud run, or leaves it for the agent (`handled: false`). */
export async function routeCloudChatMessage(
  input: CloudChatInbound,
  deps: CloudChatRoutingDeps = {},
): Promise<CloudChatRouteResult> {
  const contactId = input.contactId?.trim();
  const text = input.text.trim();
  if (!contactId || !text) return NOT_HANDLED;

  const reply = parseCloudApprovalReply(text);
  if (reply) {
    const matches = dbFindPendingCloudChatApprovals(reply.code).filter((row) => row.actorContactId === contactId);
    if (matches.length === 1) {
      const row = matches[0]!;
      const result = await decideCloudChatApproval(row, reply.decision, contactId, reply.reason, deps);
      return {
        handled: true,
        kind: "approval",
        reply: cloudApprovalOutcomeText(result.outcome, {
          tool: row.tool,
          runId: row.runId,
          personName: row.actorName,
          ...(result.error ? { error: result.error } : {}),
        }),
      };
    }
    if (matches.length > 1) {
      return {
        handled: true,
        kind: "approval",
        reply: "Mais de um pedido tem esse código. Decida no Console: ravi cloud runs show <run>.",
      };
    }
  }

  const thread = boundThreadOf(input);
  if (!thread || thread.actorContactId !== contactId) return NOT_HANDLED;
  let body = text;
  if (thread.channel === "whatsapp") {
    const mention = parseRunMention(text);
    const repliesToCard = Boolean(input.replyToId && thread.cardMessageId && input.replyToId === thread.cardMessageId);
    if (!mention && !repliesToCard) return NOT_HANDLED;
    body = mention ?? text;
  }
  return sendToBoundRun(thread, contactId, body.slice(0, MESSAGE_MAX_CHARS), deps);
}

function boundThreadOf(input: CloudChatInbound): CloudThreadRun | null {
  const channel = normalizeChatChannel(input.channel);
  if (channel === "slack") {
    const threadTs = input.threadTs?.trim();
    return threadTs ? dbFindActiveCloudThread({ channel: "slack", chatId: input.chatId, threadTs }) : null;
  }
  if (channel === "whatsapp" && input.isGroup)
    return dbFindActiveCloudThread({ channel: "whatsapp", chatId: input.chatId });
  return null;
}

async function sendToBoundRun(
  thread: CloudThreadRun,
  contactId: string,
  text: string,
  deps: CloudChatRoutingDeps,
): Promise<CloudChatRouteResult> {
  let session: CloudAgentsSession | null;
  try {
    session = await (deps.openSession ?? openCloudAgentsSession)({ resolveProject: false, actorContactId: contactId });
  } catch {
    session = null;
  }
  if (!session) {
    return {
      handled: true,
      kind: "thread_message",
      reply: "Não consegui falar com a run: o Ravi está sem login no Console.",
    };
  }
  const question = dbPendingCloudChatQuestion(thread.runId);
  if (question && (!question.actorContactId || question.actorContactId === contactId)) {
    try {
      await session.client.answerQuestion(thread.runId, question.questionId, text.slice(0, 4_000));
      dbMarkCloudChatQuestionAnswered(question.questionId);
      return { handled: true, kind: "question_answer", reply: "Resposta enviada para a run." };
    } catch (error) {
      // Answered or expired meanwhile: the message goes to the run as a message.
      if (!isGone(error)) return failed("question_answer", error);
      dbMarkCloudChatQuestionAnswered(question.questionId);
    }
  }
  try {
    await session.client.sendThreadMessage(thread.threadKey, text);
  } catch (error) {
    if (isCloudAuthError(error) && (error.code === "NOT_FOUND" || error.status === 404)) {
      // No run follows this conversation any more: the binding ends and the agent gets the message.
      dbEndCloudThreadRuns(thread.runId);
      return NOT_HANDLED;
    }
    return failed("thread_message", error);
  }
  // A Slack thread shows the run on its card; a WhatsApp group gets a short confirmation.
  return { handled: true, kind: "thread_message", reply: thread.channel === "whatsapp" ? "Enviado para a run." : null };
}

function failed(kind: "thread_message" | "question_answer", error: unknown): CloudChatRouteResult {
  log.warn("Could not send a chat message to its cloud run", { kind, error: errorText(error) });
  return { handled: true, kind, reply: `Não consegui mandar para a run: ${errorText(error).slice(0, 200)}` };
}

function isGone(error: unknown): boolean {
  return isCloudAuthError(error) && (error.status === 404 || error.status === 409 || error.code === "NOT_FOUND");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decides one approval asked in chat, as the run's person (their contact).
 * Claims it first, so two answers (a click and a reply) never both decide.
 */
export async function decideCloudChatApproval(
  row: CloudChatApproval,
  decision: "approve" | "deny",
  contactId: string,
  reason: string | undefined,
  deps: CloudChatRoutingDeps = {},
): Promise<{ outcome: CloudApprovalOutcome; error?: string }> {
  if (!row.actorContactId || row.actorContactId !== contactId) return { outcome: "not_person" };
  if (!dbClaimCloudChatApproval(row.approvalId)) return { outcome: "already_decided" };
  const now = deps.now ?? Date.now;
  try {
    const session = await (deps.openSession ?? openCloudAgentsSession)({
      resolveProject: false,
      actorContactId: contactId,
    });
    if (!session) {
      dbSettleCloudChatApproval(row.approvalId, "pending", now());
      return { outcome: "failed", error: "o Ravi está sem login no Console" };
    }
    await session.client.decideApproval(row.runId, row.approvalId, {
      decision,
      ...(reason ? { reason: reason.slice(0, 500) } : {}),
    });
    const outcome = decision === "approve" ? "approved" : "denied";
    dbSettleCloudChatApproval(row.approvalId, outcome, now());
    return { outcome };
  } catch (error) {
    if (isGone(error)) {
      dbSettleCloudChatApproval(row.approvalId, "closed", now());
      return { outcome: "already_decided" };
    }
    dbSettleCloudChatApproval(row.approvalId, "pending", now());
    if (isCloudAuthError(error) && error.status === 403) return { outcome: "not_person" };
    log.warn("Could not decide a cloud approval from chat", { runId: row.runId, error: errorText(error) });
    return { outcome: "failed", error: errorText(error) };
  }
}

/**
 * For the channel hooks (Omni consumer, Slack runner): routes the message and
 * sends the reply, if any, in the same chat. True when the message was the
 * run's and must not reach the agent. Never throws.
 */
export async function interceptCloudChatMessage(
  input: CloudChatInbound,
  sendReply: (text: string) => Promise<unknown>,
  deps: CloudChatRoutingDeps = {},
): Promise<boolean> {
  let result: CloudChatRouteResult;
  try {
    result = await routeCloudChatMessage(input, deps);
  } catch (error) {
    log.warn("Cloud chat routing failed; the message goes to the agent", { error: errorText(error) });
    return false;
  }
  if (!result.handled) return false;
  if (result.reply) {
    try {
      await sendReply(result.reply);
    } catch (error) {
      log.warn("Could not answer a cloud chat message", { kind: result.kind, error: errorText(error) });
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Slack: clicks on the private approval card

export interface CloudApprovalClickDeps extends CloudChatRoutingDeps {
  respond?: (input: { responseUrlId: string; payload: Record<string, unknown> }) => Promise<unknown>;
  slackUserContactId?: (userId: string, instanceId: string | null | undefined) => string | null;
}

/** Answers one click on a cloud approval card; null for any other interaction. */
export async function handleCloudApprovalClick(
  data: Record<string, unknown>,
  deps: CloudApprovalClickDeps = {},
): Promise<CloudApprovalOutcome | null> {
  if (data.provider !== undefined && data.provider !== "slack") return null;
  const actionId = data.actionId;
  if (!isCloudApprovalActionId(actionId)) return null;
  const responseUrlId = typeof data.responseUrlId === "string" ? data.responseUrlId.trim() : "";
  const approvalId = typeof data.value === "string" ? data.value.trim() : "";
  const userId = typeof data.userId === "string" ? data.userId.trim() : "";
  if (!approvalId || !userId) return null;
  const respond = async (outcome: CloudApprovalOutcome, row: CloudChatApproval | null, error?: string) => {
    if (!responseUrlId) return;
    await (deps.respond ?? respondToSlackInteraction)({
      responseUrlId,
      payload: {
        response_type: "ephemeral",
        // The card loses its buttons once nothing can be decided from it; a
        // click from someone else keeps the card and only gets the note.
        replace_original: outcome !== "not_person" && outcome !== "failed",
        text: cloudApprovalOutcomeText(outcome, {
          tool: row?.tool ?? "a ferramenta",
          runId: row?.runId ?? "-",
          personName: row?.actorName ?? null,
          ...(error ? { error } : {}),
        }),
      },
    });
  };
  const row = dbGetCloudChatApproval(approvalId);
  if (!row) {
    await respond("already_decided", null);
    return "already_decided";
  }
  const instanceId = typeof data.instanceId === "string" ? data.instanceId : null;
  const clicker = (deps.slackUserContactId ?? defaultSlackUserContactId)(userId, instanceId);
  if (!clicker || clicker !== row.actorContactId) {
    await respond("not_person", row);
    return "not_person";
  }
  if (row.status !== "pending") {
    await respond("already_decided", row);
    return "already_decided";
  }
  const decision = actionId === CLOUD_APPROVAL_ACTION_APPROVE ? "approve" : "deny";
  const result = await decideCloudChatApproval(row, decision, clicker, undefined, deps);
  await respond(result.outcome, row, result.error);
  return result.outcome;
}

let clicksAbort: (() => void) | null = null;

/** Daemon: answers clicks on cloud approval cards (`ravi.inbound.interaction`, its own queue group). */
export async function startCloudApprovalClicks(
  natsClient: Pick<typeof runtimeNats, "subscribe"> = runtimeNats,
): Promise<void> {
  if (clicksAbort) return;
  const stream = natsClient.subscribe("ravi.inbound.interaction", { queue: "ravi-cloud-approval-clicks" });
  let stopped = false;
  clicksAbort = () => {
    stopped = true;
    void stream.return?.(undefined);
  };
  void (async () => {
    try {
      for await (const event of stream) {
        if (stopped) return;
        try {
          await handleCloudApprovalClick(event.data as Record<string, unknown>);
        } catch (error) {
          log.warn("Failed to answer a cloud approval click", { error: errorText(error) });
        }
      }
    } catch (error) {
      if (!stopped) log.error("Cloud approval clicks stopped", { error });
    }
  })();
}

export function stopCloudApprovalClicks(): void {
  clicksAbort?.();
  clicksAbort = null;
}
