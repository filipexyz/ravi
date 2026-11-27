/**
 * Responder on a Ravi thread card waiting for a decision: the owner answers without typing the decision's id or scope.
 *
 * Two halves, split by what each process holds:
 *
 * - The Socket Mode runner opens the form. A click on Responder carries a `trigger_id` that Slack honours for three
 *   seconds, so the runner opens the modal itself (`views.open`), and only for the real card: the clicked message must
 *   be the root of the decision's own thread, the decision open at the card's revision, and the person who clicked its
 *   owner. The form shows the stored question (never the clicked message's text), and its Slack view id is recorded on
 *   the decision (`card-form-opened`). A form the runner did not open this way never answers: another app's or an
 *   agent's modal (`ravi slack modals-open`) can copy the callback id, not that record.
 * - The runner also refuses, inside the form, a submission the core would refuse for its shape (empty, or an org
 *   answer over the wide limit), so the person keeps the draft.
 * - The daemon records the answer. The form's submission is a `view_submission` the runner publishes on
 *   `ravi.inbound.interaction`, like every other click. Here it must match a recorded form (same view, person, card
 *   and revision) and then becomes one call to the core (`answerDecisionFromOwnerCard`), with the Slack user id of the
 *   payload as the verified sender. The core decides again who that person is, whether they own the decision,
 *   whether the card is still current and whether they may widen it.
 *
 * The answer reaches the person privately (ephemeral in the thread). Spec: decisions (owner answers on the card).
 */

import { resolveVerifiedSenderOwner } from "../../approval/grantor.js";
import {
  answerDecisionFromOwnerCard,
  type OwnerCardAnswerOutcome,
  type OwnerCardRefusal,
} from "../../decisions/owner-card.js";
import { WIDE_DECISION_ANSWER_MAX } from "../../decisions/service.js";
import { findDecisionCardForm, getDecision, recordDecisionCardForm } from "../../decisions/store.js";
import type { Decision } from "../../decisions/types.js";
import { nats as runtimeNats } from "../../nats.js";
import { logger } from "../../utils/logger.js";
import { requestReply as runtimeRequestReply } from "../../utils/request-reply.js";
import type { SlackWebApiClient } from "./client.js";
import { createEnvelopeDedupe } from "./envelope-dedupe.js";
import "./grantors.js";
import { getSlackThreadLifecycle } from "./thread-lifecycle-store.js";
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
/** Slack's plain_text_input caps at 3000; an org answer is held to the core's lower wide limit before submission. */
const ANSWER_MAX_LENGTH = 3000;
/** Slack's plain_text section caps at 3000. */
const QUESTION_MAX_LENGTH = 2900;

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

/**
 * The form: the stored question, the answer, and who it applies to (this thread by default; the org is a deliberate
 * choice). The question is shown as plain text, so nothing in it renders as a mention or a link.
 */
export function buildSlackDecisionAnswerModal(
  ref: SlackDecisionAnswerFormRef,
  question: string,
): Record<string, unknown> {
  const shown =
    question.trim().length > QUESTION_MAX_LENGTH
      ? `${question.trim().slice(0, QUESTION_MAX_LENGTH - 1)}…`
      : question.trim();
  return {
    type: "modal",
    callback_id: SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID,
    private_metadata: encodeSlackDecisionAnswerForm(ref),
    title: { type: "plain_text", text: "Responder decisão" },
    submit: { type: "plain_text", text: "Responder" },
    close: { type: "plain_text", text: "Cancelar" },
    blocks: [
      { type: "section", text: { type: "plain_text", text: shown || "(sem texto)", emoji: false } },
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
): { triggerId: string; userId: string; form: SlackDecisionAnswerFormRef } | null {
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
  const userId = text(record(payload.user)?.id);
  if (!decision || !triggerId || !SLACK_ID.test(userId) || !SLACK_ID.test(channelId) || !SLACK_TS.test(threadTs))
    return null;
  return { triggerId, userId, form: { decisionId: decision.id, revision: decision.revision, channelId, threadTs } };
}

/** True when the envelope is a Responder click; the runner then opens the form instead of publishing it. */
export function isSlackDecisionAnswerOpenEnvelope(envelope: SlackSocketEnvelope): boolean {
  const payload = record(envelope.payload);
  if (!payload || payload.type !== "block_actions") return false;
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  return actions.some((entry) => record(entry)?.action_id === SLACK_DECISION_ANSWER_ACTION_ID);
}

export interface SlackDecisionAnswerFormDependencies {
  readonly getDecision: (id: string) => Decision | null;
  readonly getThread: typeof getSlackThreadLifecycle;
  readonly resolveSender: typeof resolveVerifiedSenderOwner;
  readonly recordForm: typeof recordDecisionCardForm;
}

const defaultFormDependencies: SlackDecisionAnswerFormDependencies = {
  getDecision,
  getThread: getSlackThreadLifecycle,
  resolveSender: resolveVerifiedSenderOwner,
  recordForm: recordDecisionCardForm,
};

/**
 * The decision this click may answer, or null: the clicked message is the root of the decision's own thread, in this
 * workspace instance, the decision is open at the card's revision and has a human owner, and the person who clicked
 * resolves to that owner. Anything else (a copied button on another message, an older card, another person) is null.
 */
export function resolveSlackDecisionCard(
  open: { userId: string; form: SlackDecisionAnswerFormRef },
  slack: { accountId: string; instanceId: string },
  deps: Pick<
    SlackDecisionAnswerFormDependencies,
    "getDecision" | "getThread" | "resolveSender"
  > = defaultFormDependencies,
): Decision | null {
  const decision = deps.getDecision(open.form.decisionId);
  if (
    !decision ||
    decision.status !== "open" ||
    decision.revision !== open.form.revision ||
    decision.ownerType !== "human" ||
    !decision.ownerId ||
    decision.origin.type !== "thread"
  )
    return null;
  const thread = deps.getThread(decision.origin.id);
  if (
    !thread ||
    thread.platformChatId !== open.form.channelId ||
    thread.providerThreadId !== open.form.threadTs ||
    thread.instanceId !== slack.instanceId
  )
    return null;
  const owner = deps.resolveSender({
    channel: "slack",
    senderId: open.userId,
    accountId: slack.accountId,
    instanceId: slack.instanceId,
  });
  if (owner?.ownerType !== "contact" || owner.ownerId !== decision.ownerId) return null;
  return decision;
}

function unavailableView(): Record<string, unknown> {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Responder decisão" },
    close: { type: "plain_text", text: "Fechar" },
    blocks: [
      {
        type: "section",
        text: {
          type: "plain_text",
          text: "Este cartão não está disponível para você: só a pessoa responsável responde, e só pela pergunta atual.",
        },
      },
    ],
  };
}

export async function openSlackDecisionAnswerForm(input: {
  envelope: SlackSocketEnvelope;
  client: Pick<SlackWebApiClient, "viewsOpen">;
  ack: (envelopeId: string, payload?: Record<string, unknown>) => Promise<void> | void;
  accountId: string;
  instanceId: string;
  dependencies?: SlackDecisionAnswerFormDependencies;
}): Promise<void> {
  const deps = input.dependencies ?? defaultFormDependencies;
  const envelopeId = text(input.envelope.envelope_id);
  if (envelopeId) await input.ack(envelopeId);
  const open = slackDecisionAnswerOpenFromEnvelope(input.envelope);
  if (!open) return;
  try {
    const decision = resolveSlackDecisionCard(open, { accountId: input.accountId, instanceId: input.instanceId }, deps);
    if (!decision) {
      await input.client.viewsOpen({ triggerId: open.triggerId, view: unavailableView() });
      return;
    }
    const result = await input.client.viewsOpen({
      triggerId: open.triggerId,
      view: buildSlackDecisionAnswerModal(open.form, decision.ask),
    });
    const viewId = text(record(result?.view)?.id);
    if (!result?.ok || !viewId) return;
    // The record is what lets the submission answer: a form opened any other way never does.
    deps.recordForm(decision, {
      formId: viewId,
      revision: decision.revision,
      senderId: open.userId,
      channel: "slack",
      chatId: open.form.channelId,
      threadId: open.form.threadTs,
    });
  } catch (error) {
    log.warn("Could not open the decision answer form", {
      decisionId: open.form.decisionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Inside the form, before Slack closes it: an empty answer, or an org answer over the core's wide limit, is refused
 * on the answer field so the person keeps the draft. The core checks both again; this only spares the draft.
 */
export function slackDecisionAnswerFormErrors(envelope: SlackSocketEnvelope): Record<string, string> | null {
  const payload = record(envelope.payload);
  if (!payload || payload.type !== "view_submission") return null;
  const view = record(payload.view);
  if (text(view?.callback_id) !== SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID) return null;
  const values = record(record(view?.state)?.values);
  const answer = answerValue(values);
  const scope = scopeValue(values);
  if (!answer.trim()) return { [SLACK_DECISION_ANSWER_TEXT_BLOCK]: "Escreva a resposta." };
  if (scope === "org" && answer.trim().length > WIDE_DECISION_ANSWER_MAX)
    return {
      [SLACK_DECISION_ANSWER_TEXT_BLOCK]: `Para valer na org, a resposta cabe em ${WIDE_DECISION_ANSWER_MAX} caracteres (tem ${answer.trim().length}).`,
    };
  if (scope === "invalid") return { [SLACK_DECISION_ANSWER_SCOPE_BLOCK]: "Escolha só esta thread ou toda a org." };
  return null;
}

export function isSlackDecisionAnswerSubmitEnvelope(envelope: SlackSocketEnvelope): boolean {
  const payload = record(envelope.payload);
  return (
    payload?.type === "view_submission" &&
    text(record(payload.view)?.callback_id) === SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID
  );
}

function answerValue(values: Record<string, unknown> | null): string {
  const entry = record(record(values?.[SLACK_DECISION_ANSWER_TEXT_BLOCK])?.[SLACK_DECISION_ANSWER_TEXT_ACTION]);
  return typeof entry?.value === "string" ? entry.value : "";
}

/** `origin` (nothing chosen counts as the default), `org`, or `invalid` for anything the form never offers. */
function scopeValue(values: Record<string, unknown> | null): "origin" | "org" | "invalid" {
  const entry = record(record(values?.[SLACK_DECISION_ANSWER_SCOPE_BLOCK])?.[SLACK_DECISION_ANSWER_SCOPE_ACTION]);
  const option = record(entry?.selected_option);
  if (!option) return "origin";
  const chosen = typeof option.value === "string" ? option.value : "";
  return chosen === "origin" ? "origin" : chosen === "org" ? "org" : "invalid";
}

// ---------------------------------------------------------------------------
// Daemon: record the submitted answer
// ---------------------------------------------------------------------------

export interface SlackDecisionAnswerSubmission {
  readonly form: SlackDecisionAnswerFormRef;
  readonly answer: string;
  /** `invalid` is a value the form never offers: refused, never read as either audience. */
  readonly scope: "origin" | "org" | "invalid";
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
  const answer = answerValue(values);
  const scope = scopeValue(values);
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
  readonly findForm: typeof findDecisionCardForm;
}

const defaultDependencies: SlackDecisionAnswerDependencies = {
  answer: answerDecisionFromOwnerCard,
  requestReply: runtimeRequestReply,
  findForm: findDecisionCardForm,
};

/** Refusals the adapter makes before the core: a form it never opened, or an audience the form never offers. */
type SlackFormRefusal = "not_this_form" | "invalid_scope";

export type SlackDecisionAnswerOutcome = OwnerCardAnswerOutcome | { kind: "refused"; reason: SlackFormRefusal };

/** The submission matches the form the runner opened from the real card for this person, at this revision. */
function matchesOpenedForm(submission: SlackDecisionAnswerSubmission, deps: SlackDecisionAnswerDependencies): boolean {
  const form = deps.findForm(submission.form.decisionId, submission.viewId);
  return Boolean(
    form &&
      form.channel === "slack" &&
      form.senderId === submission.userId &&
      form.revision === submission.form.revision &&
      form.chatId === submission.form.channelId &&
      form.threadId === submission.form.threadTs,
  );
}

const NOTICES: Record<OwnerCardRefusal | SlackFormRefusal, string> = {
  not_this_form: "Este formulário não veio do cartão da decisão. A resposta não foi registrada.",
  invalid_scope: "Escolha só esta thread ou toda a org. A resposta não foi registrada.",
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
): Promise<SlackDecisionAnswerOutcome | null> {
  const submission = parseSlackDecisionAnswerSubmission(data);
  if (!submission) return null;
  const scope = submission.scope;
  const outcome: SlackDecisionAnswerOutcome = !matchesOpenedForm(submission, dependencies)
    ? { kind: "refused", reason: "not_this_form" }
    : scope === "invalid"
      ? { kind: "refused", reason: "invalid_scope" }
      : await dependencies.answer({
          decisionId: submission.form.decisionId,
          revision: submission.form.revision,
          answer: submission.answer,
          scope,
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
