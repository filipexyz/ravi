/**
 * Elicitation in the MCP gateway (spec mcp, Elicitation).
 *
 * A registered server may ask a question in the middle of a call: an embedded
 * `elicitation/create` in an `input_required` result (2026-07-28), or a
 * server request on a legacy connection. `requestMcpElicitation` answers it
 * for the gateway, and only ever this way:
 *
 * - The question goes to the person of the turn, and only when that person
 *   holds the server's credential (one credential per server, the
 *   operator's): a credentialed row (`mcpServerHoldsCredential`) asks only on
 *   the operator's own turn; a row with no credential may ask any resolved
 *   person its audience lets in. A turn with no person (cron, trigger,
 *   heartbeat, an agent relay, an unknown speaker, the terminal, a delivery
 *   turn) answers `decline` and sends nothing.
 * - The question goes only to a private surface: on Slack, an ephemeral card
 *   for that Slack user whose button opens a private modal; on the other
 *   channels, that person's own direct chat on the turn's instance, where
 *   quote-replies reach the daemon. No such surface declines, with nothing
 *   sent.
 * - A form holds at most 8 primitive fields. In a chat they are asked one by
 *   one, then a final review the person accepts or declines; in the Slack
 *   modal the form itself is the review. A form whose only field is one
 *   required boolean (a write confirmation) is one question in a chat: its
 *   answer is the consent (Sim accepts with true, Não declines), with no
 *   separate review. Every answer is checked against the
 *   `requestedSchema`; in a chat an invalid answer is asked again once, then
 *   the request is cancelled. Fields that look like secrets decline the
 *   request before anything is sent.
 * - URL mode shows the full https URL with its host on its own line and waits
 *   for explicit consent; Ravi never fetches or opens it. A non-https URL or
 *   one with userinfo declines.
 * - The person's time is the round's shared window (`request.answerBy`, at
 *   most 4 minutes for every question of one `input_required` round) and
 *   never past the call's budget less the reserve for the retry.
 * - A timeout, a send failure, a cancelled call or a call out of time answers
 *   `cancel`, never content. How a request was answered (the action and the
 *   fixed reason code) is reported to the gateway (`request.report`), which
 *   tells the model when nobody decided.
 * - An `elicitation` approval row records server, tool, mode, field names and
 *   the action; the trace event `mcp.elicitation` records counts, the action
 *   and a fixed reason. Neither holds the message, an answer or the URL, and
 *   nothing here logs them.
 * - While the person is being asked, the call's approval wait lease (Claude:
 *   the session's tool watchdog) is held.
 */

import { randomUUID } from "node:crypto";

import type { ElicitResult } from "@modelcontextprotocol/client";

import { type PersonDirectChatInput, resolvePersonDirectChatTarget } from "../approval/direct-chat-target.js";
import {
  type ApprovalTarget,
  MAX_PERSON_ANSWER_QUESTION_LENGTH,
  PERSON_ANSWER_REPLY_CHANNELS,
  type PersonAnswerRequest,
  type PersonAnswerResult,
  requestPersonAnswer,
} from "../approval/service.js";
import {
  type CreateApprovalRequestInput,
  createApprovalRequest,
  type ElicitationApprovalAction,
  settleElicitationApprovalRequest,
} from "../approval/store.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "../approval/timeouts.js";
import {
  askSlackMcpElicitation,
  resolveSlackMcpElicitationSurface,
  type SlackMcpElicitationAsk,
  type SlackMcpElicitationAnswer,
  type SlackMcpElicitationSurface,
} from "../channels/slack/mcp-elicitation.js";
import type { ConnectorTurnResult } from "../link/connector-turn.js";
import { resolveOperatorTurnClassification } from "../library/turn.js";
import type { ContextRecord } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import { type AuthorizeMcpUseDeps, authorizeMcpUse, mcpServerHoldsCredential } from "./authorize.js";
import {
  cleanElicitationText,
  MCP_ELICITATION_LABEL,
  matchElicitationLabel,
  type McpElicitationField,
  type McpElicitationPlan,
  mcpFieldOptions,
  planMcpElicitation,
  quoteMcpServerText,
  readMcpFieldAnswer,
  validateMcpElicitationContent,
} from "./elicitation-form.js";
import type { McpElicitationHandler, McpElicitationRequest } from "./gateway.js";
import { MCP_INPUT_ROUND_ANSWER_MS } from "./input-loop.js";
import { recordMcpElicitationTrace } from "./trace.js";

export {
  checkMcpFieldText,
  checkMcpFieldValue,
  cleanElicitationText,
  isSecretLookingField,
  MCP_ELICITATION_LABEL,
  MCP_ELICITATION_MAX_FIELDS,
  matchElicitationLabel,
  mcpFieldOptions,
  planMcpElicitation,
  readMcpFieldAnswer,
  validateMcpElicitationContent,
} from "./elicitation-form.js";
export type {
  McpElicitationField,
  McpElicitationFieldKind,
  McpElicitationPlan,
  McpElicitationRefusal,
  McpFieldAnswer,
} from "./elicitation-form.js";

const log = logger.child("mcp:elicitation");

/** Time kept back from the call's budget for the retry that carries the answer. */
export const MCP_ELICITATION_RESERVE_MS = 10_000;
/** A question is not sent with less time than this left to answer it. */
export const MCP_ELICITATION_MIN_QUESTION_MS = 5_000;
/** How many times one answer may be invalid before the request is cancelled. */
export const MCP_ELICITATION_MAX_ATTEMPTS = 2;

const SLACK_CHANNEL = "slack";

const YES = MCP_ELICITATION_LABEL.yes;
const NO = MCP_ELICITATION_LABEL.no;
const SEND = MCP_ELICITATION_LABEL.send;
const ACCEPT = MCP_ELICITATION_LABEL.accept;
const REFUSE = MCP_ELICITATION_LABEL.refuse;

// ============================================================================
// Who is asked
// ============================================================================

export type McpElicitationIneligible =
  | "not_authorized"
  | "no_person"
  | "not_credential_principal"
  | "no_private_surface";

export interface McpElicitationPerson {
  contactId: string;
  /** The operator's own turn. */
  operator: boolean;
}

/**
 * The person of a classified turn, or null when the turn has none Ravi can
 * name: a routine, the terminal or an operator relay (no contact), an agent
 * relay or forwarded request, an ended or unknown turn.
 */
export function mcpElicitationPersonOfTurn(result: ConnectorTurnResult): McpElicitationPerson | null {
  if (result.ok) {
    const turn = result.turn;
    if (turn.routine || (turn.conversation !== "dm" && turn.conversation !== "group")) return null;
    if (turn.speaker.kind !== "owner" || !turn.speaker.contactId) return null;
    return { contactId: turn.speaker.contactId, operator: true };
  }
  if (result.ended || result.delegatedRequester || result.routineOwner || result.triggerOwner) return null;
  const candidate = result.candidate;
  if (!candidate || candidate.routine) return null;
  if (candidate.conversation !== "dm" && candidate.conversation !== "group") return null;
  if ((candidate.speaker.kind !== "owner" && candidate.speaker.kind !== "contact") || !candidate.speaker.contactId) {
    return null;
  }
  return { contactId: candidate.speaker.contactId, operator: false };
}

/** Classifies a turn (the connector turn classifier with the operator's login as owner). */
export type McpOriginTurnResolver = (context: ContextRecord) => ConnectorTurnResult;

/**
 * The person a call is made for, recorded when the call leaves its turn: the
 * person of the turn (or null when it has none) and whether it is the
 * operator's own turn. A late question of that call is asked only while the
 * origin turn still names the same person (`McpGateway.lateContext`).
 */
export function mcpCallOriginOfContext(
  context: ContextRecord | null | undefined,
  resolveTurn: McpOriginTurnResolver = defaultResolveTurn,
): { contactId: string | null; operatorOwn: boolean } {
  if (!context) return { contactId: null, operatorOwn: false };
  try {
    const turn = resolveTurn(context);
    return { contactId: mcpElicitationPersonOfTurn(turn)?.contactId ?? null, operatorOwn: turn.ok };
  } catch {
    // no-cause: a turn that cannot be classified names nobody; a late question is declined.
    return { contactId: null, operatorOwn: false };
  }
}

// ============================================================================
// Handler
// ============================================================================

export interface McpElicitationDeps {
  /** Overrides for `authorizeMcpUse` (tests). */
  authorize?: AuthorizeMcpUseDeps;
  /** Classify the turn (default: the connector turn classifier with the operator's login as owner). */
  resolveTurn?: (context: ContextRecord) => ConnectorTurnResult;
  resolveTarget?: (input: PersonDirectChatInput) => ApprovalTarget | null;
  /** The Slack surface of the turn (default: the bound Slack user's own card). */
  resolveSlackSurface?: (input: {
    source: NonNullable<ContextRecord["source"]>;
    contactId: string;
  }) => SlackMcpElicitationSurface | null;
  ask?: (request: PersonAnswerRequest) => Promise<PersonAnswerResult>;
  /** Ask through the Slack modal (default: `askSlackMcpElicitation`). */
  askSlack?: (ask: SlackMcpElicitationAsk) => Promise<SlackMcpElicitationAnswer>;
  createRow?: (input: CreateApprovalRequestInput) => unknown;
  settleRow?: (input: { id: string; action: ElicitationApprovalAction; decidedBy?: string; now: number }) => unknown;
  now?: () => number;
  newId?: () => string;
  /** Longest wait for one answer (default: the approval timeout, 5 minutes). */
  questionTimeoutMs?: number;
  reserveMs?: number;
  minQuestionMs?: number;
}

type Outcome = { result: ElicitResult; reason: string };

/** Where this turn's person can be asked privately. */
type AskSurface =
  | { kind: "chat"; target: ApprovalTarget }
  | { kind: "slack"; target: ApprovalTarget; slack: SlackMcpElicitationSurface };

function defaultResolveTurn(context: ContextRecord): ConnectorTurnResult {
  return resolveOperatorTurnClassification({ turn: { runtimeContext: { present: true, record: context } } });
}

/**
 * Ravi's opening line, then the server's own text as a quotation. Every line a
 * server wrote starts with `>`; Ravi's own lines never do, and the line that
 * says what each answer does always comes after the server's text.
 */
function header(request: McpElicitationRequest, message: string, more: string[] = []): string {
  const intro = `Pedido do servidor MCP ${request.server} (ferramenta ${request.tool}).`;
  // The message is capped on its own, so what a confirmation is about (its label) is always shown.
  const quoted = [quoteMcpServerText(message), ...more.map((text) => quoteMcpServerText(text, 4))]
    .filter(Boolean)
    .join("\n>\n");
  return quoted ? `${intro} O texto do servidor vem nas linhas com >:\n${quoted}` : intro;
}

/** A field's label inside one of Ravi's lines: one line, in quotation marks. */
function quotedLabel(field: McpElicitationField): string {
  return `“${field.label}”`;
}

function shownValue(field: McpElicitationField, value: unknown): string {
  if (value === undefined) return "(sem resposta)";
  if (field.kind === "boolean") return value === true ? YES : NO;
  if (field.kind === "enum")
    return (field.choices ?? []).find((choice) => choice.value === value)?.label ?? String(value);
  return cleanElicitationText(String(value), 200);
}

function fieldQuestion(field: McpElicitationField, index: number, total: number, hint?: string): string {
  const lines = [`(${index + 1}/${total}) ${quotedLabel(field)}${field.required ? "" : " (opcional)"}`];
  if (field.description) lines.push(quoteMcpServerText(field.description, 4));
  if (field.kind === "string" || field.kind === "number" || field.kind === "integer") {
    const kind =
      field.kind === "string"
        ? field.format === "date"
          ? "Responda com uma data (AAAA-MM-DD)."
          : field.format === "date-time"
            ? "Responda com data e hora (AAAA-MM-DDTHH:MM e fuso, ex.: Z)."
            : field.format === "email"
              ? "Responda com um e-mail."
              : field.format === "uri"
                ? "Responda com um endereço completo."
                : "Responda com o texto."
        : field.kind === "integer"
          ? "Responda com um número inteiro."
          : "Responda com um número.";
    lines.push(field.required ? kind : `${kind} Responda - para pular.`);
  }
  if (hint) lines.push(`A resposta anterior não serviu: envie ${hint}.`);
  return lines.join("\n");
}

/** Build the handler the gateway calls for each elicitation request. */
export function createMcpElicitationHandler(deps: McpElicitationDeps = {}): McpElicitationHandler {
  const now = deps.now ?? Date.now;
  const reserveMs = deps.reserveMs ?? MCP_ELICITATION_RESERVE_MS;
  const minQuestionMs = deps.minQuestionMs ?? MCP_ELICITATION_MIN_QUESTION_MS;
  const questionTimeoutMs = deps.questionTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  return async (request) => {
    const started = now();
    const context = request.scope.context;
    let questions = 0;
    let mode: "form" | "url" | "unknown" = "unknown";
    let fieldCount = 0;

    const finish = (outcome: Outcome): ElicitResult => {
      try {
        request.report?.({ action: outcome.result.action, reason: outcome.reason });
      } catch {
        // no-cause: the report only feeds the call's trace and note; the answer below stands.
      }
      try {
        recordMcpElicitationTrace({
          context,
          agentId: request.scope.agentId,
          server: request.server,
          tool: request.tool,
          era: request.era,
          mode,
          fieldCount,
          questions,
          action: outcome.result.action,
          reason: outcome.reason,
          durationMs: now() - started,
        });
      } catch {
        // no-cause: the trace is a record; the answer below is the outcome either way.
        log.warn("mcp.elicitation trace could not be recorded", { server: request.server });
      }
      return outcome.result;
    };
    const decline = (reason: string): Outcome => ({ result: { action: "decline" }, reason });
    const cancel = (reason: string): Outcome => ({ result: { action: "cancel" }, reason });

    try {
      // What is asked: refused shapes decline before anyone is looked up or asked.
      const plan = planMcpElicitation(request.params);
      mode = plan.mode;
      fieldCount = plan.ok ? (plan.mode === "form" ? plan.fields.length : 0) : plan.fieldCount;
      if (!plan.ok) return finish(decline(plan.code));

      // Who may be asked: the call's own authorization on the elicitation surface, then the person.
      const decision = authorizeMcpUse(
        { context, agentId: request.scope.agentId, server: request.server, tool: request.tool, surface: "elicitation" },
        deps.authorize,
      );
      if (!decision.allowed || !context) return finish(decline("not_authorized"));
      let turn: ConnectorTurnResult;
      try {
        turn = (deps.resolveTurn ?? defaultResolveTurn)(context);
      } catch {
        // no-cause: a turn that cannot be classified has no person; nothing is sent.
        return finish(decline("no_person"));
      }
      const person = mcpElicitationPersonOfTurn(turn);
      if (!person) return finish(decline("no_person"));
      if (mcpServerHoldsCredential(decision.server) && !person.operator) {
        return finish(decline("not_credential_principal"));
      }

      // Where: the Slack modal of that user, or the person's own direct chat.
      const surface = resolveSurface(context, person.contactId, deps);
      if (!surface) return finish(decline("no_private_surface"));
      const target = surface.target;

      // The round's shared window, never past the call's budget less the reserve for the retry.
      const answerDeadline = Math.min(
        request.deadline - reserveMs,
        request.answerBy ?? started + MCP_INPUT_ROUND_ANSWER_MS,
      );
      if (answerDeadline - now() < minQuestionMs) return finish(decline("no_time"));
      if (request.signal?.aborted) return finish(cancel("cancelled"));

      // The audit row: names only. Without it nobody is asked.
      const rowId = (deps.newId ?? randomUUID)();
      const fieldNames = plan.mode === "form" ? plan.fields.map((field) => field.name) : [];
      try {
        (deps.createRow ?? createApprovalRequest)({
          id: rowId,
          type: "elicitation",
          channel: target.channel,
          accountId: target.accountId,
          chatId: target.chatId,
          instanceId: target.instanceId ?? target.accountId,
          ...(context.sessionName ? { sessionName: context.sessionName } : {}),
          agentId: request.scope.agentId,
          elicitation: { server: request.server, tool: request.tool, mode: plan.mode, fields: fieldNames },
          createdAt: now(),
          expiresAt: answerDeadline,
        });
      } catch {
        // no-cause: the row's text may name the server; the decline below is the outcome.
        log.warn("MCP elicitation row could not be written; declining", { server: request.server });
        return finish(decline("audit_failed"));
      }

      let outcome: Outcome;
      let waiting = false;
      try {
        try {
          request.scope.approvalWait?.begin();
          waiting = true;
        } catch {
          // no-cause: the lease is the watchdog's; the question still has its own timeout.
          waiting = false;
        }
        if (surface.kind === "slack") {
          questions++;
          outcome = await askSlackModal(request, plan, surface.slack, {
            approvalId: rowId,
            contactId: person.contactId,
            deadline: answerDeadline,
            ...(context.sessionName ? { sessionName: context.sessionName } : {}),
            askSlack: deps.askSlack ?? askSlackMcpElicitation,
          });
        } else {
          const askOnce = async (
            text: string,
            options: readonly string[],
          ): Promise<{ answer: string } | { failed: string }> => {
            const remaining = answerDeadline - now();
            if (remaining < minQuestionMs) return { failed: questions === 0 ? "no_time" : "timeout" };
            if (request.signal?.aborted) return { failed: "cancelled" };
            questions++;
            const asked = (deps.ask ?? requestPersonAnswer)({
              target,
              expectedActor: { contactId: person.contactId },
              kind: options.length > 0 ? "poll" : "reply",
              text,
              ...(options.length > 0 ? { options } : {}),
              timeoutMs: Math.min(questionTimeoutMs, remaining),
            });
            const signal = request.signal;
            let onAbort: (() => void) | null = null;
            const aborted = signal
              ? new Promise<"aborted">((resolve) => {
                  onAbort = () => resolve("aborted");
                  signal.addEventListener("abort", onAbort, { once: true });
                })
              : null;
            const answer = await (aborted ? Promise.race([asked, aborted]) : asked);
            if (signal && onAbort) signal.removeEventListener("abort", onAbort);
            if (answer === "aborted") return { failed: "cancelled" };
            if (answer.status !== "answered") return { failed: answer.status };
            return { answer: answer.answer.kind === "choice" ? answer.answer.label : answer.answer.text };
          };

          outcome =
            plan.mode === "url"
              ? await askUrl(request, plan, askOnce)
              : await askForm(request, plan, askOnce, (content) => validateMcpElicitationContent(plan.fields, content));
        }
      } finally {
        if (waiting) {
          try {
            request.scope.approvalWait?.end();
          } catch {
            // no-cause: ending the lease cannot change the answer.
          }
        }
      }

      try {
        (deps.settleRow ?? settleElicitationApprovalRequest)({
          id: rowId,
          action: outcome.result.action,
          ...(outcome.result.action !== "cancel" ? { decidedBy: person.contactId } : {}),
          now: now(),
        });
      } catch {
        // no-cause: the answer was already decided; a failed row update leaves the row to expire.
        log.warn("MCP elicitation row could not be settled", { server: request.server });
      }
      return finish(outcome);
    } catch (error) {
      log.error("MCP elicitation failed; cancelling", {
        server: request.server,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return finish(cancel("error"));
    }
  };
}

/**
 * The private surface of this turn's person: on Slack the bound Slack user's
 * own ephemeral card, elsewhere their direct chat on the turn's instance.
 * Null when Ravi can prove neither, so nothing is sent.
 */
function resolveSurface(context: ContextRecord, contactId: string, deps: McpElicitationDeps): AskSurface | null {
  const source = context.source;
  const channel = source?.channel?.trim().toLowerCase() ?? "";
  if (!source || !source.accountId) return null;

  if (channel === SLACK_CHANNEL) {
    let slack: SlackMcpElicitationSurface | null = null;
    try {
      slack = (deps.resolveSlackSurface ?? resolveSlackMcpElicitationSurface)({ source, contactId });
    } catch {
      // no-cause: without a proven Slack user and chat there is no private surface; nothing is sent.
      slack = null;
    }
    if (!slack) return null;
    return {
      kind: "slack",
      slack,
      target: {
        channel: SLACK_CHANNEL,
        accountId: slack.accountId,
        chatId: slack.chatId,
        ...(slack.instanceId ? { instanceId: slack.instanceId } : {}),
      },
    };
  }

  if (!PERSON_ANSWER_REPLY_CHANNELS.has(channel)) return null;
  let target: ApprovalTarget | null = null;
  try {
    target = (deps.resolveTarget ?? resolvePersonDirectChatTarget)({
      channel,
      accountId: source.accountId,
      instanceId: source.instanceId ?? null,
      contactId,
    });
  } catch {
    // no-cause: no proven direct chat means no private surface; nothing is sent.
    target = null;
  }
  return target ? { kind: "chat", target } : null;
}

/** One private Slack modal: the form itself is the review. */
async function askSlackModal(
  request: McpElicitationRequest,
  plan: Extract<McpElicitationPlan, { ok: true }>,
  surface: SlackMcpElicitationSurface,
  input: {
    approvalId: string;
    contactId: string;
    deadline: number;
    sessionName?: string;
    askSlack: (ask: SlackMcpElicitationAsk) => Promise<SlackMcpElicitationAnswer>;
  },
): Promise<Outcome> {
  const answer = await input.askSlack({
    surface,
    server: request.server,
    tool: request.tool,
    approvalId: input.approvalId,
    contactId: input.contactId,
    ...(request.scope.agentId ? { agentId: request.scope.agentId } : {}),
    ...(input.sessionName ? { sessionName: input.sessionName } : {}),
    ...(plan.mode === "url"
      ? { mode: "url" as const, message: plan.message, url: plan.url.href }
      : { mode: "form" as const, message: plan.message, fields: plan.fields }),
    deadline: input.deadline,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (answer.action === "accept") {
    if (plan.mode === "url") return { result: { action: "accept" }, reason: answer.reason };
    const submitted = answer.content ?? {};
    // The handler validates the modal's answer itself: the surface is trusted
    // for who answered, never for what the server may be told.
    if (!validateMcpElicitationContent(plan.fields, submitted)) {
      return { result: { action: "cancel" }, reason: "invalid_answer" };
    }
    const content: Record<string, string | number | boolean> = {};
    for (const field of plan.fields) {
      const value = submitted[field.name];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        content[field.name] = value;
      }
    }
    return { result: { action: "accept", content }, reason: answer.reason };
  }
  return { result: { action: answer.action }, reason: answer.reason };
}

type AskOnce = (text: string, options: readonly string[]) => Promise<{ answer: string } | { failed: string }>;

/** Ask until a valid answer, at most `MCP_ELICITATION_MAX_ATTEMPTS` times. */
async function askValid<T>(
  build: (hint?: string) => { text: string; options: readonly string[] },
  read: (answer: string) => { ok: true; value: T } | { ok: false; hint: string },
  askOnce: AskOnce,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  let hint: string | undefined;
  for (let attempt = 0; attempt < MCP_ELICITATION_MAX_ATTEMPTS; attempt++) {
    const question = build(hint);
    const answered = await askOnce(question.text, question.options);
    if ("failed" in answered) return { ok: false, reason: answered.failed };
    const parsed = read(answered.answer);
    if (parsed.ok) return parsed;
    hint = parsed.hint;
  }
  return { ok: false, reason: "invalid_answer" };
}

function readReview(answer: string, accept: string): { ok: true; value: boolean } | { ok: false; hint: string } {
  const label = matchElicitationLabel(answer, [accept, REFUSE]);
  if (!label) return { ok: false, hint: `${accept} ou ${REFUSE}` };
  return { ok: true, value: label === accept };
}

/** A form whose only field is one required boolean: a confirmation, asked as one question. */
export function isMcpConsentForm(plan: Extract<McpElicitationPlan, { ok: true; mode: "form" }>): boolean {
  return plan.fields.length === 1 && plan.fields[0]!.kind === "boolean" && plan.fields[0]!.required;
}

/**
 * One question for a one-boolean form: the answer is the consent. Sim sends
 * `accept` with the field true; Não sends `decline`, so nothing is sent as
 * content. No separate review: the question already says what each answer does.
 */
async function askConsent(
  request: McpElicitationRequest,
  plan: Extract<McpElicitationPlan, { ok: true; mode: "form" }>,
  askOnce: AskOnce,
  validate: (content: Record<string, unknown>) => boolean,
): Promise<Outcome> {
  const field = plan.fields[0]!;
  const text = [
    header(request, plan.message, [field.label, field.description ?? ""]),
    "",
    `${YES} manda esta confirmação ao servidor MCP ${request.server}; ${NO} não manda nada.`,
  ].join("\n");
  const consent = await askValid(
    () => ({ text, options: [YES, NO] }),
    (answer) => {
      const label = matchElicitationLabel(answer, [YES, NO]);
      return label ? { ok: true, value: label === YES } : { ok: false, hint: `${YES} ou ${NO}` };
    },
    askOnce,
  );
  if (!consent.ok) return { result: { action: "cancel" }, reason: consent.reason };
  if (!consent.value) return { result: { action: "decline" }, reason: "declined" };
  const content = { [field.name]: true };
  if (!validate(content)) return { result: { action: "cancel" }, reason: "invalid_answer" };
  return { result: { action: "accept", content }, reason: "accepted" };
}

async function askForm(
  request: McpElicitationRequest,
  plan: Extract<McpElicitationPlan, { ok: true; mode: "form" }>,
  askOnce: AskOnce,
  validate: (content: Record<string, unknown>) => boolean,
): Promise<Outcome> {
  if (isMcpConsentForm(plan)) return askConsent(request, plan, askOnce, validate);
  const intro = header(request, plan.message);
  const content: Record<string, string | number | boolean> = {};
  for (const [index, field] of plan.fields.entries()) {
    const answered = await askValid<{ value?: string | number | boolean }>(
      (hint) => {
        const question = fieldQuestion(field, index, plan.fields.length, hint);
        return { text: index === 0 ? `${intro}\n\n${question}` : question, options: mcpFieldOptions(field) };
      },
      (answer) => {
        const read = readMcpFieldAnswer(field, answer);
        if (!read.ok) return read;
        return { ok: true, value: "skip" in read ? {} : { value: read.value } };
      },
      askOnce,
    );
    if (!answered.ok) return { result: { action: "cancel" }, reason: answered.reason };
    if (answered.value.value !== undefined) content[field.name] = answered.value.value;
  }

  const summary = plan.fields.map((field) => `- ${quotedLabel(field)}: ${shownValue(field, content[field.name])}`);
  const reviewText = [
    plan.fields.length === 0 ? intro : `Revise antes de enviar ao servidor MCP ${request.server}:`,
    ...(summary.length ? ["", ...summary] : []),
    "",
    `${SEND} manda estas respostas; ${REFUSE} não manda nada.`,
  ].join("\n");
  const review = await askValid(
    () => ({ text: reviewText, options: [SEND, REFUSE] }),
    (answer) => readReview(answer, SEND),
    askOnce,
  );
  if (!review.ok) return { result: { action: "cancel" }, reason: review.reason };
  if (!review.value) return { result: { action: "decline" }, reason: "declined" };
  if (!validate(content)) return { result: { action: "cancel" }, reason: "invalid_answer" };
  return { result: { action: "accept", content }, reason: "accepted" };
}

async function askUrl(
  request: McpElicitationRequest,
  plan: Extract<McpElicitationPlan, { ok: true; mode: "url" }>,
  askOnce: AskOnce,
): Promise<Outcome> {
  const build = (message: string) =>
    [
      header(request, message),
      "",
      "Endereço:",
      plan.url.href,
      "",
      "Domínio:",
      plan.url.host,
      "",
      `O Ravi não abre este endereço. Escolha ${ACCEPT} só se você mesmo vai abri-lo e seguir os passos; ${REFUSE} não manda nada.`,
    ].join("\n");
  // The URL and its host are shown whole; a long message is cut so the question
  // fits what one chat question may carry, instead of failing to send.
  let text = build(plan.message);
  // Quoting adds two characters a line, so the cut shrinks until the question fits.
  for (
    let room = MAX_PERSON_ANSWER_QUESTION_LENGTH - build("").length - 1;
    text.length > MAX_PERSON_ANSWER_QUESTION_LENGTH && room > 1;
    room -= 40
  ) {
    text = build(cleanElicitationText(plan.message, room));
  }
  if (text.length > MAX_PERSON_ANSWER_QUESTION_LENGTH) text = build("");
  const consent = await askValid(
    () => ({ text, options: [ACCEPT, REFUSE] }),
    (answer) => readReview(answer, ACCEPT),
    askOnce,
  );
  if (!consent.ok) return { result: { action: "cancel" }, reason: consent.reason };
  return consent.value
    ? { result: { action: "accept" }, reason: "accepted" }
    : { result: { action: "decline" }, reason: "declined" };
}

/** The daemon gateway's elicitation handler. */
export const requestMcpElicitation: McpElicitationHandler = createMcpElicitationHandler();
