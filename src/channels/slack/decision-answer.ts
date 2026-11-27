/**
 * Responder on a Ravi thread card waiting for a decision: the owner answers without typing the decision's id or scope.
 *
 * Two halves, split by what each process holds:
 *
 * - The Socket Mode runner opens the form. A click on Responder carries a `trigger_id` that Slack honours for three
 *   seconds, so the runner opens the modal itself (`views.open`), copying into the form's `private_metadata` only
 *   what the card's button carried (decision id and revision) and where the card is (channel and thread). It reads
 *   nothing from the database and decides nothing.
 * - The daemon records the answer. The form's submission is a `view_submission` the runner publishes on
 *   `ravi.inbound.interaction`, like every other click. Here it becomes one call to the core
 *   (`answerDecisionFromOwnerCard`), with the Slack user id of the payload as the verified sender. The core decides
 *   who that person is, whether they own the decision, whether the card is still current and whether they may widen it.
 *
 * The answer reaches the person privately (ephemeral in the thread). Spec: decisions (owner answers on the card).
 */

import {
  answerDecisionFromOwnerCard,
  type OwnerCardAnswerOutcome,
  type OwnerCardRefusal,
} from "../../decisions/owner-card.js";
import { nats as runtimeNats } from "../../nats.js";
import { logger } from "../../utils/logger.js";
import { requestReply as runtimeRequestReply } from "../../utils/request-reply.js";
import type { SlackWebApiClient } from "./client.js";
import { createEnvelopeDedupe } from "./envelope-dedupe.js";
import { parseSlackDecisionAnswerValue, SLACK_DECISION_ANSWER_ACTION_ID } from "./thread-card.js";
import type { SlackSocketEnvelope } from "./types.js";

const log = logger.child("slack:decision-answer");

export const SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID = "ravi_decision_answer_submit";
export const SLACK_DECISION_ANSWER_TEXT_BLOCK = "ravi_decision_answer_text";
export const SLACK_DECISION_ANSWER_TEXT_ACTION = "answer";
export const SLACK_DECISION_ANSWER_SCOPE_BLOCK = "ravi_decision_answer_scope";
export const SLACK_DECISION_ANSWER_SCOPE_ACTION = "scope";
const SLACK_ID = /^[A-Z0-9]{2,32}$/;
const SLACK_TS = /^[0-9]{6,12}\.[0-9]{1,9}$/;
/** Slack's plain_text_input caps at 3000; the core caps a wide answer lower and says so. */
const ANSWER_MAX_LENGTH = 3000;

export interface SlackDecisionAnswerFormRef {
  readonly decisionId: string;
  readonly revision: number;
  readonly channelId: string;
  readonly threadTs: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function encodeSlackDecisionAnswerForm(ref: SlackDecisionAnswerFormRef): string {
  return JSON.stringify({ d: ref.decisionId, r: ref.revision, c: ref.channelId, t: ref.threadTs });
}

/** The form's `private_metadata`: a pointer the core rechecks, never authority. */
export function parseSlackDecisionAnswerForm(value: unknown): SlackDecisionAnswerFormRef | null {
  if (typeof value !== "string" || value.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // no-cause: Metadata that is not ours is not a decision form; the caller ignores it.
    return null;
  }
  const form = record(parsed);
  if (!form) return null;
  const decision = parseSlackDecisionAnswerValue(`${text(form.d)}:${String(form.r ?? "")}`);
  const channelId = text(form.c);
  const threadTs = text(form.t);
  if (!decision || !SLACK_ID.test(channelId) || !SLACK_TS.test(threadTs)) return null;
  return { decisionId: decision.id, revision: decision.revision, channelId, threadTs };
}

/** The form: the answer, and who it applies to (this thread by default; the org is a deliberate choice). */
export function buildSlackDecisionAnswerModal(ref: SlackDecisionAnswerFormRef): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID,
    private_metadata: encodeSlackDecisionAnswerForm(ref),
    title: { type: "plain_text", text: "Responder decisão" },
    submit: { type: "plain_text", text: "Responder" },
    close: { type: "plain_text", text: "Cancelar" },
    blocks: [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "A pergunta está no cartão da thread." }],
      },
      {
        type: "input",
        block_id: SLACK_DECISION_ANSWER_TEXT_BLOCK,
        label: { type: "plain_text", text: "Resposta" },
        element: {
          type: "plain_text_input",
          action_id: SLACK_DECISION_ANSWER_TEXT_ACTION,
          multiline: true,
          max_length: ANSWER_MAX_LENGTH,
        },
      },
      {
        type: "input",
        block_id: SLACK_DECISION_ANSWER_SCOPE_BLOCK,
        label: { type: "plain_text", text: "Vale para" },
        element: {
          type: "radio_buttons",
          action_id: SLACK_DECISION_ANSWER_SCOPE_ACTION,
          initial_option: scopeOption("origin"),
          options: [scopeOption("origin"), scopeOption("org")],
        },
      },
    ],
  };
}

function scopeOption(scope: "origin" | "org") {
  return scope === "origin"
    ? { text: { type: "plain_text", text: "Só esta thread" }, value: "origin" }
    : {
        text: { type: "plain_text", text: "Toda a org" },
        description: { type: "plain_text", text: "Os agentes internos passam a seguir. Clientes não recebem." },
        value: "org",
      };
}

// ---------------------------------------------------------------------------
// Socket Mode runner: open the form
// ---------------------------------------------------------------------------

/** A click on Responder: the form to open, or null for any other envelope. */
export function slackDecisionAnswerOpenFromEnvelope(
  envelope: SlackSocketEnvelope,
): { triggerId: string; form: SlackDecisionAnswerFormRef } | null {
  const payload = record(envelope.payload);
  if (!payload || payload.type !== "block_actions") return null;
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const action = actions.map(record).find((entry) => entry?.action_id === SLACK_DECISION_ANSWER_ACTION_ID);
  if (!action) return null;
  const decision = parseSlackDecisionAnswerValue(action.value);
  const triggerId = text(payload.trigger_id);
  const container = record(payload.container);
  const message = record(payload.message);
  const channelId = text(record(payload.channel)?.id) || text(container?.channel_id);
  // The card is the thread's root: its own ts is the thread.
  const threadTs =
    text(message?.thread_ts) || text(container?.thread_ts) || text(message?.ts) || text(container?.message_ts);
  if (!decision || !triggerId || !SLACK_ID.test(channelId) || !SLACK_TS.test(threadTs)) return null;
  return { triggerId, form: { decisionId: decision.id, revision: decision.revision, channelId, threadTs } };
}

/** True when the envelope is a Responder click; the runner then opens the form instead of publishing it. */
export function isSlackDecisionAnswerOpenEnvelope(envelope: SlackSocketEnvelope): boolean {
  const payload = record(envelope.payload);
  if (!payload || payload.type !== "block_actions") return false;
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  return actions.some((entry) => record(entry)?.action_id === SLACK_DECISION_ANSWER_ACTION_ID);
}

export async function openSlackDecisionAnswerForm(input: {
  envelope: SlackSocketEnvelope;
  client: Pick<SlackWebApiClient, "viewsOpen">;
  ack: (envelopeId: string, payload?: Record<string, unknown>) => Promise<void> | void;
}): Promise<void> {
  const envelopeId = text(input.envelope.envelope_id);
  if (envelopeId) await input.ack(envelopeId);
  const open = slackDecisionAnswerOpenFromEnvelope(input.envelope);
  if (!open) return;
  try {
    await input.client.viewsOpen({ triggerId: open.triggerId, view: buildSlackDecisionAnswerModal(open.form) });
  } catch (error) {
    log.warn("Could not open the decision answer form", {
      decisionId: open.form.decisionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Daemon: record the submitted answer
// ---------------------------------------------------------------------------

export interface SlackDecisionAnswerSubmission {
  readonly form: SlackDecisionAnswerFormRef;
  readonly answer: string;
  readonly scope: "origin" | "org";
  readonly accountId: string;
  readonly instanceId: string;
  readonly userId: string;
  readonly viewId: string;
  readonly envelopeId?: string;
}

/** The submitted form, or null for any other interaction. Only the payload's own fields are read. */
export function parseSlackDecisionAnswerSubmission(data: unknown): SlackDecisionAnswerSubmission | null {
  const event = record(data);
  if (!event || event.provider !== "slack" || event.source !== "slack.socket_mode") return null;
  if (event.interactionType !== "view_submission") return null;
  if (text(event.viewCallbackId) !== SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID) return null;
  const form = parseSlackDecisionAnswerForm(event.viewPrivateMetadata);
  const accountId = text(event.accountId);
  const instanceId = text(event.instanceId);
  const userId = text(event.userId);
  const viewId = text(event.viewId);
  if (!form || !accountId || !instanceId || !SLACK_ID.test(userId) || !viewId) return null;
  const values = record(event.stateValues);
  const answerEntry = record(record(values?.[SLACK_DECISION_ANSWER_TEXT_BLOCK])?.[SLACK_DECISION_ANSWER_TEXT_ACTION]);
  const scopeEntry = record(record(values?.[SLACK_DECISION_ANSWER_SCOPE_BLOCK])?.[SLACK_DECISION_ANSWER_SCOPE_ACTION]);
  const answer = typeof answerEntry?.value === "string" ? answerEntry.value : "";
  const chosen = text(record(scopeEntry?.selected_option)?.value);
  // Only the org is a widening; anything else, including nothing chosen, stays in the thread.
  const scope = chosen === "org" ? "org" : "origin";
  const envelopeId = text(event.envelopeId);
  return {
    form,
    answer,
    scope,
    accountId,
    instanceId,
    userId,
    viewId,
    ...(envelopeId ? { envelopeId } : {}),
  };
}

export interface SlackDecisionAnswerDependencies {
  readonly answer: typeof answerDecisionFromOwnerCard;
  readonly requestReply: typeof runtimeRequestReply;
}

const defaultDependencies: SlackDecisionAnswerDependencies = {
  answer: answerDecisionFromOwnerCard,
  requestReply: runtimeRequestReply,
};

const NOTICES: Record<OwnerCardRefusal, string> = {
  unknown_actor: "Não reconheci quem respondeu. A resposta não foi registrada.",
  not_owner: "Só a pessoa responsável por esta decisão pode respondê-la. A resposta não foi registrada.",
  stale: "Esta pergunta mudou ou já foi respondida. A resposta não foi registrada.",
  not_found: "Não encontrei esta decisão. A resposta não foi registrada.",
  scope_not_authorized:
    "Só quem administra a instalação pode fazer a resposta valer para a org. A resposta não foi registrada.",
  invalid_answer: "A resposta está vazia ou longa demais para valer na org. Nada foi registrado.",
  failed: "Não consegui registrar a resposta. Tente de novo.",
};

export async function handleSlackDecisionAnswerSubmission(
  data: unknown,
  dependencies: SlackDecisionAnswerDependencies = defaultDependencies,
): Promise<OwnerCardAnswerOutcome | null> {
  const submission = parseSlackDecisionAnswerSubmission(data);
  if (!submission) return null;
  const outcome = await dependencies.answer({
    decisionId: submission.form.decisionId,
    revision: submission.form.revision,
    answer: submission.answer,
    scope: submission.scope,
    actor: {
      channel: "slack",
      senderId: submission.userId,
      accountId: submission.accountId,
      instanceId: submission.instanceId,
    },
    interactionRef: `slack:view:${submission.viewId}`,
  });
  const notice =
    outcome.kind === "answered"
      ? outcome.decision.scope.type === "org"
        ? "Resposta registrada. Vale para toda a org."
        : "Resposta registrada para esta thread."
      : NOTICES[outcome.reason];
  await dependencies
    .requestReply(
      "ravi.outbound.deliver",
      {
        channel: "slack",
        accountId: submission.accountId,
        to: submission.form.channelId,
        threadId: submission.form.threadTs,
        text: notice,
        privateTo: [submission.userId],
      },
      15_000,
    )
    .catch((error: unknown) => {
      log.warn("Could not tell the person how their decision answer went", {
        decisionId: submission.form.decisionId,
        outcome: outcome.kind === "answered" ? "answered" : outcome.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return outcome;
}

let runnerAbort: (() => void) | null = null;

export async function startSlackDecisionAnswers(
  natsClient: Pick<typeof runtimeNats, "subscribe"> = runtimeNats,
): Promise<void> {
  if (runnerAbort) return;
  const stream = natsClient.subscribe("ravi.inbound.interaction", { queue: "ravi-slack-decision-answers" });
  const dedupe = createEnvelopeDedupe();
  let stopped = false;
  runnerAbort = () => {
    stopped = true;
    void stream.return?.(undefined);
  };
  void (async () => {
    try {
      for await (const event of stream) {
        if (stopped) return;
        try {
          const submission = parseSlackDecisionAnswerSubmission(event.data);
          if (!submission) continue;
          if (submission.envelopeId && !dedupe(submission.envelopeId)) continue;
          await handleSlackDecisionAnswerSubmission(event.data);
        } catch (error) {
          log.warn("Failed to handle a decision answer form", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (!stopped) log.error("Slack decision answer runner stopped", { error });
    }
  })();
}

export function stopSlackDecisionAnswers(): void {
  runnerAbort?.();
  runnerAbort = null;
}
