/**
 * The Slack surface of an MCP elicitation (spec mcp, Elicitation).
 *
 * Slack quote-replies never reach the daemon, so a server's question is not
 * asked as chat there. Instead the daemon sends the bound Slack user one
 * ephemeral card with a button; the button opens a private modal built from
 * the planned form, and the submission comes back to the daemon over NATS.
 * The two halves run in different processes:
 *
 * - The daemon (`askSlackMcpElicitation`) finds the person's Slack user id,
 *   writes the request row, sends the card through the gateway and waits for
 *   the answer inside the call's budget. It trusts the row it wrote, never
 *   the payload: a submission counts only for the bound user, on the bound
 *   view, while the row is still open, and every value is checked against the
 *   planned schema again before it is used.
 * - `ravi-channels` (`handleMcpElicitationEnvelope`) opens and reads the
 *   modal, exactly as `credential-intake.ts` does for a credential: only the
 *   bound user may open or submit it, one view per request, and the answer is
 *   published once.
 *
 * The row holds what the person is asked (the server's message and the field
 * definitions), never an answer: the values live only in the submission on
 * their way to the server, and never in a row, a log or a trace. Fields that
 * look like a secret were already refused when the request was planned.
 */

import { randomUUID } from "node:crypto";

import { nats as runtimeNats } from "../../nats.js";
import {
  checkMcpFieldText,
  checkMcpFieldValue,
  MCP_ELICITATION_LABEL,
  MCP_ELICITATION_MAX_FIELDS,
  type McpElicitationField,
  type McpElicitationFieldKind,
  quoteMcpServerText,
} from "../../mcp/elicitation-form.js";
import { pruneMcpElicitationRequests } from "../../mcp/registry-db.js";
import { getDb, type ContextSource } from "../../router/router-db.js";
import { logger } from "../../utils/logger.js";
import { findSlackUserIdForContact } from "./grantors.js";
import { deliverSlackPrivateCard, type DeliverSlackPrivateCard } from "./private-card.js";
import type { SlackWebApiClient } from "./client.js";
import type { SlackSocketEnvelope } from "./types.js";

const log = logger.child("slack:mcp-elicitation");

export const MCP_ELICITATION_PREFIX = "ravi_mcp_elicit";
export const MCP_ELICITATION_OPEN = `${MCP_ELICITATION_PREFIX}:open`;
export const MCP_ELICITATION_SUBMIT = `${MCP_ELICITATION_PREFIX}:submit`;
export const MCP_ELICITATION_VALUE_ACTION = `${MCP_ELICITATION_PREFIX}:value`;
/** Where `ravi-channels` publishes one submission for the waiting daemon. */
export const MCP_ELICITATION_ANSWER_SUBJECT = "ravi.mcp.elicitation.answer";

/** The input block of field `index`; the order is the planned order. */
export function mcpElicitationFieldBlockId(index: number): string {
  return `${MCP_ELICITATION_PREFIX}:f${index}`;
}

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;
const SLACK_CHAT_ID = /^[CDG][A-Z0-9]+$/;
const SLACK_TEAM_ID = /^T[A-Z0-9]+$/;
const SLACK_VIEW_ID = /^V[A-Z0-9]+$/;
const SLACK_TS = /^\d+\.\d+$/;

/** Slack Block Kit limits (docs.slack.dev/reference/block-kit). */
const MAX_TITLE_CHARS = 24;
const MAX_SECTION_CHARS = 2_900;
const MAX_LABEL_CHARS = 1_900;
const MAX_OPTION_CHARS = 75;
const MAX_INPUT_CHARS = 3_000;

const TRUE_VALUE = "true";
const FALSE_VALUE = "false";

// ============================================================================
// The stored request
// ============================================================================

export type SlackMcpElicitationStatus = "open" | "opened" | "answered" | "declined" | "expired" | "cancelled";

export interface SlackMcpElicitationSurface {
  /** The Slack account (the instance name) the gateway sends through. */
  readonly accountId: string;
  readonly instanceId?: string;
  /** The conversation the card is posted in, ephemeral to `userId`. */
  readonly chatId: string;
  readonly threadTs?: string;
  /** The Slack user bound to the person of the turn. */
  readonly userId: string;
}

export interface SlackMcpElicitationRequest {
  readonly id: string;
  readonly accountId: string;
  readonly instanceId?: string;
  readonly chatId: string;
  readonly threadTs?: string;
  readonly userId: string;
  readonly contactId: string;
  readonly agentId?: string;
  readonly sessionName?: string;
  /** The `elicitation` approval row this request belongs to. */
  readonly approvalId?: string;
  readonly server: string;
  readonly tool: string;
  readonly mode: "form" | "url";
  readonly message: string;
  readonly fields: readonly McpElicitationField[];
  readonly url?: string;
  readonly status: SlackMcpElicitationStatus;
  readonly teamId?: string;
  readonly viewId?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type SlackMcpElicitationErrorCode =
  | "NOT_AVAILABLE"
  | "BINDING_MISMATCH"
  | "EXPIRED"
  | "ALREADY_USED"
  | "INVALID_REQUEST"
  | "STORE_FAILED";

/** Never retain a cause: the payload and the row may carry the person's answer. */
export class SlackMcpElicitationError extends Error {
  constructor(readonly code: SlackMcpElicitationErrorCode) {
    super(code);
    this.name = "SlackMcpElicitationError";
  }
}

interface SlackMcpElicitationRow {
  id: string;
  account_id: string;
  instance_id: string | null;
  chat_id: string;
  thread_ts: string | null;
  user_id: string;
  contact_id: string;
  agent_id: string | null;
  session_name: string | null;
  approval_id: string | null;
  server: string;
  tool: string;
  mode: string;
  request_json: string;
  status: string;
  team_id: string | null;
  view_id: string | null;
  created_at: number;
  expires_at: number;
}

const STATUSES: ReadonlySet<string> = new Set<SlackMcpElicitationStatus>([
  "open",
  "opened",
  "answered",
  "declined",
  "expired",
  "cancelled",
]);

const FIELD_KINDS: ReadonlySet<string> = new Set<McpElicitationFieldKind>([
  "string",
  "number",
  "integer",
  "boolean",
  "enum",
]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One stored field definition, or null when the row is not one Ravi wrote. */
function readField(value: unknown): McpElicitationField | null {
  const field = record(value);
  const name = text(field?.name);
  const kind = typeof field?.kind === "string" ? field.kind : "";
  if (!field || !name || !FIELD_KINDS.has(kind) || typeof field.required !== "boolean") return null;
  const choices: { label: string; value: string }[] = [];
  if (kind === "enum") {
    if (!Array.isArray(field.choices) || field.choices.length === 0) return null;
    for (const entry of field.choices) {
      const choice = record(entry);
      const label = text(choice?.label);
      if (!choice || !label || typeof choice.value !== "string") return null;
      choices.push({ label, value: choice.value });
    }
  }
  const format = field.format;
  if (format !== undefined && format !== "email" && format !== "uri" && format !== "date" && format !== "date-time") {
    return null;
  }
  return {
    name,
    label: text(field.label) ?? name,
    ...(text(field.description) ? { description: text(field.description) as string } : {}),
    required: field.required,
    kind: kind as McpElicitationFieldKind,
    ...(numberOrUndefined(field.minLength) !== undefined ? { minLength: field.minLength as number } : {}),
    ...(numberOrUndefined(field.maxLength) !== undefined ? { maxLength: field.maxLength as number } : {}),
    ...(format ? { format } : {}),
    ...(numberOrUndefined(field.minimum) !== undefined ? { minimum: field.minimum as number } : {}),
    ...(numberOrUndefined(field.maximum) !== undefined ? { maximum: field.maximum as number } : {}),
    ...(kind === "enum" ? { choices } : {}),
  };
}

function hydrate(row: SlackMcpElicitationRow): SlackMcpElicitationRequest | null {
  if (!STATUSES.has(row.status) || (row.mode !== "form" && row.mode !== "url")) return null;
  let payload: Record<string, unknown> | undefined;
  try {
    payload = record(JSON.parse(row.request_json));
  } catch {
    // no-cause: a row Ravi cannot read is not served; the caller refuses the request.
    payload = undefined;
  }
  if (!payload) return null;
  const message = typeof payload.message === "string" ? payload.message : "";
  const fields: McpElicitationField[] = [];
  if (row.mode === "form") {
    if (!Array.isArray(payload.fields) || payload.fields.length > MCP_ELICITATION_MAX_FIELDS) return null;
    for (const entry of payload.fields) {
      const field = readField(entry);
      if (!field) return null;
      fields.push(field);
    }
  } else if (!text(payload.url)) {
    return null;
  }
  return {
    id: row.id,
    accountId: row.account_id,
    ...(row.instance_id ? { instanceId: row.instance_id } : {}),
    chatId: row.chat_id,
    ...(row.thread_ts ? { threadTs: row.thread_ts } : {}),
    userId: row.user_id,
    contactId: row.contact_id,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.session_name ? { sessionName: row.session_name } : {}),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    server: row.server,
    tool: row.tool,
    mode: row.mode,
    message,
    fields,
    ...(row.mode === "url" ? { url: payload.url as string } : {}),
    status: row.status as SlackMcpElicitationStatus,
    ...(row.team_id ? { teamId: row.team_id } : {}),
    ...(row.view_id ? { viewId: row.view_id } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export interface CreateSlackMcpElicitationInput {
  readonly id?: string;
  readonly surface: SlackMcpElicitationSurface;
  readonly contactId: string;
  readonly agentId?: string;
  readonly sessionName?: string;
  readonly approvalId?: string;
  readonly server: string;
  readonly tool: string;
  readonly mode: "form" | "url";
  readonly message: string;
  readonly fields?: readonly McpElicitationField[];
  readonly url?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Write one open request. The values of an answer never enter this row. */
export function createSlackMcpElicitationRequest(input: CreateSlackMcpElicitationInput): SlackMcpElicitationRequest {
  const surface = normalizeSurface(input.surface);
  const contactId = text(input.contactId);
  const server = text(input.server);
  const tool = text(input.tool);
  const fields = input.mode === "form" ? (input.fields ?? []) : [];
  const url = input.mode === "url" ? text(input.url) : undefined;
  if (
    !surface ||
    !contactId ||
    !server ||
    !tool ||
    !Number.isFinite(input.createdAt) ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= input.createdAt ||
    fields.length > MCP_ELICITATION_MAX_FIELDS ||
    (input.mode === "url" && !url) ||
    (input.mode === "form" && input.url !== undefined)
  ) {
    throw new SlackMcpElicitationError("INVALID_REQUEST");
  }
  const id = text(input.id) ?? `sme_${randomUUID()}`;
  const payload = JSON.stringify({
    message: typeof input.message === "string" ? input.message : "",
    ...(input.mode === "form" ? { fields } : { url }),
  });
  try {
    getDb()
      .prepare(
        `INSERT INTO mcp_elicitation_requests (
          id, account_id, instance_id, chat_id, thread_ts, user_id, contact_id, agent_id, session_name,
          approval_id, server, tool, mode, request_json, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        id,
        surface.accountId,
        surface.instanceId ?? null,
        surface.chatId,
        surface.threadTs ?? null,
        surface.userId,
        contactId,
        text(input.agentId) ?? null,
        text(input.sessionName) ?? null,
        text(input.approvalId) ?? null,
        server,
        tool,
        input.mode,
        payload,
        input.createdAt,
        input.expiresAt,
      );
    // The same retention as the daemon's status refresh: rows settled or expired more than a day ago.
    pruneMcpElicitationRequests(input.createdAt);
  } catch (error) {
    // no-cause: a storage failure must not echo row contents; the caller declines.
    if (error instanceof SlackMcpElicitationError) throw error;
    throw new SlackMcpElicitationError("STORE_FAILED");
  }
  const stored = getSlackMcpElicitationRequest(id);
  if (!stored) throw new SlackMcpElicitationError("STORE_FAILED");
  return stored;
}

export function getSlackMcpElicitationRequest(id: string): SlackMcpElicitationRequest | null {
  const wanted = text(id);
  if (!wanted) return null;
  let row: SlackMcpElicitationRow | undefined;
  try {
    row = getDb().prepare("SELECT * FROM mcp_elicitation_requests WHERE id = ?").get(wanted) as
      | SlackMcpElicitationRow
      | undefined;
  } catch {
    // no-cause: an unreadable table proves no open request; every caller fails closed.
    return null;
  }
  return row ? hydrate(row) : null;
}

export interface SlackMcpElicitationBinding {
  readonly id: string;
  readonly accountId: string;
  readonly userId: string;
  readonly teamId?: string;
  readonly viewId: string;
  readonly now: number;
}

function assertBinding(request: SlackMcpElicitationRequest, binding: SlackMcpElicitationBinding): void {
  const userId = text(binding.userId)?.toUpperCase();
  if (
    !userId ||
    request.userId !== userId ||
    request.accountId !== text(binding.accountId) ||
    (request.teamId && binding.teamId && request.teamId !== text(binding.teamId)?.toUpperCase())
  ) {
    throw new SlackMcpElicitationError("BINDING_MISMATCH");
  }
}

/** Bind the one modal of this request; a second open is refused. */
export function bindSlackMcpElicitationView(binding: SlackMcpElicitationBinding): SlackMcpElicitationRequest {
  const viewId = text(binding.viewId);
  if (!viewId || !SLACK_VIEW_ID.test(viewId)) throw new SlackMcpElicitationError("BINDING_MISMATCH");
  const teamId = text(binding.teamId)?.toUpperCase();
  if (teamId && !SLACK_TEAM_ID.test(teamId)) throw new SlackMcpElicitationError("BINDING_MISMATCH");
  return getDb().transaction(() => {
    const request = getSlackMcpElicitationRequest(binding.id);
    if (!request) throw new SlackMcpElicitationError("NOT_AVAILABLE");
    assertBinding(request, binding);
    if (request.expiresAt <= binding.now) throw new SlackMcpElicitationError("EXPIRED");
    if (request.status !== "open" || request.viewId) throw new SlackMcpElicitationError("ALREADY_USED");
    const updated = getDb()
      .prepare(
        `UPDATE mcp_elicitation_requests SET status = 'opened', view_id = ?, team_id = COALESCE(team_id, ?)
          WHERE id = ? AND status = 'open' AND view_id IS NULL`,
      )
      .run(viewId, teamId ?? null, request.id);
    if (updated.changes !== 1) throw new SlackMcpElicitationError("ALREADY_USED");
    return { ...request, status: "opened" as const, viewId, ...(teamId ? { teamId } : {}) };
  })();
}

/**
 * Take the one answer of this request: `answered` for a submission,
 * `declined` when the person closed the modal. A replay changes nothing.
 */
export function claimSlackMcpElicitationAnswer(
  binding: SlackMcpElicitationBinding & { readonly action: "answered" | "declined" },
): SlackMcpElicitationRequest {
  return getDb().transaction(() => {
    const request = getSlackMcpElicitationRequest(binding.id);
    if (!request) throw new SlackMcpElicitationError("NOT_AVAILABLE");
    assertBinding(request, binding);
    if (request.status !== "opened") throw new SlackMcpElicitationError("ALREADY_USED");
    if (!request.viewId || request.viewId !== text(binding.viewId)) {
      throw new SlackMcpElicitationError("BINDING_MISMATCH");
    }
    if (request.expiresAt <= binding.now) throw new SlackMcpElicitationError("EXPIRED");
    const updated = getDb()
      .prepare("UPDATE mcp_elicitation_requests SET status = ?, settled_at = ? WHERE id = ? AND status = 'opened'")
      .run(binding.action, binding.now, request.id);
    if (updated.changes !== 1) throw new SlackMcpElicitationError("ALREADY_USED");
    return { ...request, status: binding.action };
  })();
}

/** Close a request nobody answered (the daemon stopped waiting). */
export function settleSlackMcpElicitationRequest(input: {
  readonly id: string;
  readonly status: "expired" | "cancelled";
  readonly now: number;
}): void {
  try {
    getDb()
      .prepare(
        `UPDATE mcp_elicitation_requests SET status = ?, settled_at = ?
          WHERE id = ? AND status IN ('open', 'opened')`,
      )
      .run(input.status, input.now, input.id);
  } catch {
    // no-cause: the row only expires later; the answer was already decided.
    log.warn("MCP elicitation request could not be settled");
  }
}

// ============================================================================
// Cards and modals
// ============================================================================

function plain(value: string): Record<string, unknown> {
  return { type: "plain_text", text: value || " " };
}

function cut(value: string, max: number): string {
  const clean = typeof value === "string" ? value : "";
  return [...clean].length > max ? `${[...clean].slice(0, max - 1).join("")}…` : clean;
}

function section(value: string): Record<string, unknown> {
  return { type: "section", text: plain(cut(value, MAX_SECTION_CHARS)) };
}

function requestHeadline(request: SlackMcpElicitationRequest): string {
  return `Servidor MCP: ${request.server}\nFerramenta: ${request.tool}`;
}

/**
 * The server's message as its own block, every line a quotation under Ravi's
 * heading, so it can never pass for Ravi's own text; Ravi's lines are in
 * other blocks and never start with `>`.
 */
function serverMessageBlocks(request: SlackMcpElicitationRequest): Record<string, unknown>[] {
  const quoted = request.message ? quoteMcpServerText(request.message) : "";
  return quoted ? [section(`Texto do servidor MCP (linhas com >):\n${quoted}`)] : [];
}

/** The ephemeral card only the bound user sees. */
export function buildMcpElicitationInvitation(request: SlackMcpElicitationRequest): {
  text: string;
  blocks: Record<string, unknown>[];
} {
  const title =
    request.mode === "url" ? "Um servidor MCP pede uma confirmação" : "Um servidor MCP pede dados para continuar";
  return {
    text: title,
    blocks: [
      section(title),
      section(requestHeadline(request)),
      ...serverMessageBlocks(request),
      {
        type: "actions",
        block_id: `${MCP_ELICITATION_PREFIX}:invitation`,
        elements: [
          {
            type: "button",
            action_id: MCP_ELICITATION_OPEN,
            value: request.id,
            text: plain(request.mode === "url" ? "Ver o pedido" : "Responder"),
            style: "primary",
          },
        ],
      },
    ],
  };
}

function fieldElement(field: McpElicitationField): Record<string, unknown> {
  const actionId = MCP_ELICITATION_VALUE_ACTION;
  if (field.kind === "boolean") {
    return {
      type: "radio_buttons",
      action_id: actionId,
      options: [
        { text: plain(MCP_ELICITATION_LABEL.yes), value: TRUE_VALUE },
        { text: plain(MCP_ELICITATION_LABEL.no), value: FALSE_VALUE },
      ],
    };
  }
  if (field.kind === "enum") {
    return {
      type: "static_select",
      action_id: actionId,
      placeholder: plain("Escolha uma opção"),
      // The option value is the choice's position: a schema value may be longer
      // than Slack allows in a value, and the real value never leaves the row.
      options: (field.choices ?? []).map((choice, position) => ({
        text: plain(cut(choice.label.replace(/\s+/g, " ").trim(), MAX_OPTION_CHARS)),
        value: String(position),
      })),
    };
  }
  if (field.kind === "number" || field.kind === "integer") {
    return {
      type: "number_input",
      action_id: actionId,
      is_decimal_allowed: field.kind === "number",
      ...(field.minimum !== undefined ? { min_value: String(field.minimum) } : {}),
      ...(field.maximum !== undefined ? { max_value: String(field.maximum) } : {}),
    };
  }
  return {
    type: "plain_text_input",
    action_id: actionId,
    max_length: Math.min(field.maxLength ?? MAX_INPUT_CHARS, MAX_INPUT_CHARS),
  };
}

function fieldHint(field: McpElicitationField): string | undefined {
  const parts: string[] = [];
  // The server's description, on one line and in quotation marks, before Ravi's own hint.
  if (field.description) parts.push(`“${field.description.replace(/\s+/g, " ").trim()}”`);
  switch (field.format) {
    case "email":
      parts.push("Um e-mail.");
      break;
    case "uri":
      parts.push("Um endereço completo (com https://).");
      break;
    case "date":
      parts.push("Uma data (AAAA-MM-DD).");
      break;
    case "date-time":
      parts.push("Data e hora (AAAA-MM-DDTHH:MM com fuso, ex.: Z).");
      break;
  }
  if (field.kind === "string" && field.minLength !== undefined) parts.push(`Pelo menos ${field.minLength} caracteres.`);
  return parts.length > 0 ? cut(parts.join(" "), MAX_LABEL_CHARS) : undefined;
}

/** The private modal: the form itself, or the URL to confirm. */
export function buildMcpElicitationModal(request: SlackMcpElicitationRequest): Record<string, unknown> {
  const head = [section(requestHeadline(request)), ...serverMessageBlocks(request)];
  if (request.mode === "url") {
    return {
      type: "modal",
      callback_id: MCP_ELICITATION_SUBMIT,
      private_metadata: request.id,
      notify_on_close: true,
      title: plain(cut("Confirmar pedido", MAX_TITLE_CHARS)),
      submit: plain(MCP_ELICITATION_LABEL.accept),
      close: plain(MCP_ELICITATION_LABEL.refuse),
      blocks: [
        ...head,
        section(`Endereço:\n${request.url ?? ""}`),
        section(`Domínio:\n${hostOf(request.url)}`),
        section(
          `O Ravi não abre este endereço. Escolha ${MCP_ELICITATION_LABEL.accept} só se você mesmo vai abri-lo e seguir os passos; ${MCP_ELICITATION_LABEL.refuse} não manda nada.`,
        ),
      ],
    };
  }
  return {
    type: "modal",
    callback_id: MCP_ELICITATION_SUBMIT,
    private_metadata: request.id,
    notify_on_close: true,
    title: plain(cut("Responder pedido", MAX_TITLE_CHARS)),
    submit: plain(MCP_ELICITATION_LABEL.send),
    close: plain(MCP_ELICITATION_LABEL.refuse),
    blocks: [
      ...head,
      section(
        `${MCP_ELICITATION_LABEL.send} manda estas respostas ao servidor; ${MCP_ELICITATION_LABEL.refuse} não manda nada.`,
      ),
      ...request.fields.map((field, index) => {
        const hint = fieldHint(field);
        return {
          type: "input",
          block_id: mcpElicitationFieldBlockId(index),
          label: plain(cut(field.label.replace(/\s+/g, " ").trim(), MAX_LABEL_CHARS)),
          ...(hint ? { hint: plain(hint) } : {}),
          ...(field.required ? {} : { optional: true }),
          element: fieldElement(field),
        };
      }),
    ],
  };
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    // no-cause: the URL was already validated when the request was planned.
    return "";
  }
}

export type SlackMcpElicitationViewState = "sent" | "declined" | "unavailable" | "undelivered";

/** What the person sees once the modal closes. */
export function buildMcpElicitationStatusView(state: SlackMcpElicitationViewState): Record<string, unknown> {
  const body =
    state === "sent"
      ? "Resposta enviada ao servidor MCP."
      : state === "declined"
        ? "Pedido recusado. Nada foi enviado ao servidor."
        : state === "undelivered"
          ? "Não foi possível entregar esta resposta. Nada foi enviado ao servidor; peça ao agente para tentar de novo."
          : "Este pedido não está mais disponível. Nada foi enviado ao servidor.";
  return {
    type: "modal",
    callback_id: `${MCP_ELICITATION_PREFIX}:status`,
    title: plain(cut(state === "sent" ? "Resposta enviada" : "Pedido encerrado", MAX_TITLE_CHARS)),
    close: plain("Fechar"),
    blocks: [section(body)],
  };
}

// ============================================================================
// Reading one submission
// ============================================================================

export type SlackMcpElicitationSubmission =
  | { readonly ok: true; readonly content: Record<string, unknown> }
  | { readonly ok: false; readonly errors: Record<string, string> };

/**
 * The typed content of a submitted modal, or the per-field errors Slack shows
 * the person. Only the planned fields are read; anything else is ignored.
 */
export function readMcpElicitationSubmission(
  request: SlackMcpElicitationRequest,
  values: unknown,
): SlackMcpElicitationSubmission {
  const state = record(values) ?? {};
  const content: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [index, field] of request.fields.entries()) {
    const blockId = mcpElicitationFieldBlockId(index);
    const entry = record(record(state[blockId])?.[MCP_ELICITATION_VALUE_ACTION]);
    const picked = record(entry?.selected_option);
    const raw = typeof entry?.value === "string" ? entry.value : undefined;
    const chosen = typeof picked?.value === "string" ? picked.value : undefined;

    if (field.kind === "boolean" || field.kind === "enum") {
      if (chosen === undefined) {
        if (field.required) errors[blockId] = "Escolha uma opção.";
        continue;
      }
      if (field.kind === "boolean") {
        if (chosen !== TRUE_VALUE && chosen !== FALSE_VALUE) {
          errors[blockId] = "Escolha uma opção.";
          continue;
        }
        content[field.name] = chosen === TRUE_VALUE;
        continue;
      }
      const position = /^\d{1,2}$/.test(chosen) ? Number.parseInt(chosen, 10) : -1;
      const choice = (field.choices ?? [])[position];
      if (!choice) {
        errors[blockId] = "Escolha uma opção.";
        continue;
      }
      content[field.name] = choice.value;
      continue;
    }

    const typed = raw?.trim() ?? "";
    if (!typed) {
      if (field.required) errors[blockId] = "Responda este campo.";
      continue;
    }
    const checked = checkMcpFieldText(field, typed);
    if (!checked.ok) {
      errors[blockId] = `Envie ${checked.hint}.`;
      continue;
    }
    if (!("value" in checked)) continue;
    content[field.name] = checked.value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  // The row is the only schema: a value the plan does not accept never leaves here.
  for (const [index, field] of request.fields.entries()) {
    const value = content[field.name];
    const blockId = mcpElicitationFieldBlockId(index);
    if (value === undefined) {
      if (field.required) return { ok: false, errors: { [blockId]: "Responda este campo." } };
      continue;
    }
    if (!checkMcpFieldValue(field, value)) return { ok: false, errors: { [blockId]: "Esta resposta não serve." } };
  }
  return { ok: true, content };
}

// ============================================================================
// ravi-channels: the modal
// ============================================================================

type Ack = (envelopeId: string, payload?: Record<string, unknown>) => Promise<void> | void;
type ModalClient = Pick<SlackWebApiClient, "viewsOpen"> & Partial<Pick<SlackWebApiClient, "postEphemeral">>;

export interface SlackMcpElicitationHandlerDependencies {
  getRequest: typeof getSlackMcpElicitationRequest;
  bindView: typeof bindSlackMcpElicitationView;
  claim: typeof claimSlackMcpElicitationAnswer;
  publish: (subject: string, data: Record<string, unknown>) => Promise<void>;
  now: () => number;
}

const defaultHandlerDependencies: SlackMcpElicitationHandlerDependencies = {
  getRequest: getSlackMcpElicitationRequest,
  bindView: bindSlackMcpElicitationView,
  claim: claimSlackMcpElicitationAnswer,
  publish: async (subject, data) => {
    await runtimeNats.emit(subject, data);
  },
  now: Date.now,
};

function reserved(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(MCP_ELICITATION_PREFIX);
}

/** Recognize this flow's own identifiers, even in a malformed payload. */
export function isMcpElicitationEnvelope(envelope: SlackSocketEnvelope): boolean {
  const payload = record(envelope.payload);
  if (!payload) return false;
  const view = record(payload.view);
  if (reserved(view?.callback_id) || reserved(payload.callback_id)) return true;
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  if (actions.some((action) => reserved(record(action)?.action_id) || reserved(record(action)?.block_id))) return true;
  // A payload that lost its callback is still this flow's: its own blocks and
  // state keys name it, and it must not reach the generic interaction bus.
  const values = record(record(view?.state)?.values) ?? record(record(payload.state)?.values);
  if (values && Object.keys(values).some(reserved)) return true;
  const blocks = Array.isArray(view?.blocks) ? view.blocks : [];
  return blocks.some((block) => reserved(record(block)?.block_id));
}

/**
 * Open and read one MCP elicitation modal in `ravi-channels`.
 *
 * Only the bound Slack user of the request may open it, and only the bound
 * view may be submitted. A submission is published once, after the row is
 * claimed, so a replay changes nothing. Values never reach a log.
 */
export async function handleMcpElicitationEnvelope(input: {
  envelope: SlackSocketEnvelope;
  accountId: string;
  instanceId: string;
  client: ModalClient;
  ack: Ack;
  dependencies?: Partial<SlackMcpElicitationHandlerDependencies>;
}): Promise<boolean> {
  if (!isMcpElicitationEnvelope(input.envelope)) return false;
  const deps = { ...defaultHandlerDependencies, ...input.dependencies };
  const payload = record(input.envelope.payload) ?? {};
  const view = record(payload.view);
  const firstAction = record(Array.isArray(payload.actions) ? payload.actions[0] : undefined);
  const kind = text(payload.type);
  const actionId = text(firstAction?.action_id);
  const callbackId = text(view?.callback_id);
  const requestId = text(view?.private_metadata) ?? text(firstAction?.value);
  const teamId = text(record(payload.team)?.id) ?? text(payload.team_id);
  const userId = text(record(payload.user)?.id)?.toUpperCase();
  const viewId = text(view?.id);
  const triggerId = text(payload.trigger_id);
  const envelopeId = text(input.envelope.envelope_id) ?? "";
  const values = record(record(view?.state)?.values);

  let acknowledged = false;
  const ack = async (response?: Record<string, unknown>) => {
    if (acknowledged) return;
    acknowledged = true;
    if (envelopeId) await input.ack(envelopeId, response);
  };
  const deny = async (notice: SlackMcpElicitationViewState) => {
    if (kind === "view_submission") {
      await ack({ response_action: "update", view: buildMcpElicitationStatusView(notice) });
      return;
    }
    await ack();
    if (kind === "block_actions" && input.client.postEphemeral) {
      const channelId = text(record(payload.channel)?.id) ?? text(record(payload.container)?.channel_id);
      if (channelId && userId) {
        await input.client
          .postEphemeral({
            channel: channelId,
            user: userId,
            text: "Este pedido não está mais disponível. Nada foi enviado ao servidor.",
          })
          .catch(() => {
            // no-cause: the private notice is best effort; Slack diagnostics stay out of this flow.
          });
      }
    }
  };

  try {
    if (!requestId || !userId) {
      await deny("unavailable");
      return true;
    }
    const request = deps.getRequest(requestId);
    if (!request || request.accountId !== input.accountId || request.userId !== userId) {
      await deny("unavailable");
      return true;
    }

    if (kind === "block_actions") {
      if (actionId !== MCP_ELICITATION_OPEN || !triggerId || viewId) {
        await deny("unavailable");
        return true;
      }
      if (request.status !== "open" || request.expiresAt <= deps.now()) {
        await deny("unavailable");
        return true;
      }
      await ack();
      const opened = await input.client.viewsOpen({ triggerId, view: buildMcpElicitationModal(request) });
      const openedViewId = text(record(opened.view)?.id);
      if (!opened.ok || !openedViewId) throw new SlackMcpElicitationError("NOT_AVAILABLE");
      deps.bindView({
        id: request.id,
        accountId: input.accountId,
        userId,
        ...(teamId ? { teamId } : {}),
        viewId: openedViewId,
        now: deps.now(),
      });
      return true;
    }

    if (kind === "view_closed") {
      if (callbackId !== MCP_ELICITATION_SUBMIT || !viewId) {
        await ack();
        return true;
      }
      await publishAnswer(deps, request, { id: request.id, viewId, userId, teamId, action: "declined" });
      await ack();
      return true;
    }

    if (kind !== "view_submission" || callbackId !== MCP_ELICITATION_SUBMIT || !viewId) {
      await deny("unavailable");
      return true;
    }
    if (request.mode === "form") {
      const submission = readMcpElicitationSubmission(request, values);
      if (!submission.ok) {
        await ack({ response_action: "errors", errors: submission.errors });
        return true;
      }
      const delivered = await publishAnswer(deps, request, {
        id: request.id,
        viewId,
        userId,
        teamId,
        action: "answered",
        content: submission.content,
      });
      await ack({ response_action: "update", view: buildMcpElicitationStatusView(delivered ? "sent" : "undelivered") });
      return true;
    }
    const delivered = await publishAnswer(deps, request, {
      id: request.id,
      viewId,
      userId,
      teamId,
      action: "answered",
    });
    await ack({ response_action: "update", view: buildMcpElicitationStatusView(delivered ? "sent" : "undelivered") });
    return true;
  } catch (error) {
    const expected = error instanceof SlackMcpElicitationError;
    if (!expected) {
      log.warn("MCP elicitation modal failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
    await deny("unavailable").catch(() => {
      // no-cause: a failed acknowledgement must not forward the Slack payload.
    });
    return true;
  }
}

/**
 * Claim the row, then publish the one answer. The claim comes first, so a
 * replayed submission never publishes twice.
 */
async function publishAnswer(
  deps: SlackMcpElicitationHandlerDependencies,
  request: SlackMcpElicitationRequest,
  input: {
    id: string;
    viewId: string;
    userId: string;
    teamId?: string;
    action: "answered" | "declined";
    content?: Record<string, unknown>;
  },
): Promise<boolean> {
  deps.claim({
    id: input.id,
    accountId: request.accountId,
    userId: input.userId,
    ...(input.teamId ? { teamId: input.teamId } : {}),
    viewId: input.viewId,
    action: input.action,
    now: deps.now(),
  });
  try {
    await deps.publish(MCP_ELICITATION_ANSWER_SUBJECT, {
      requestId: input.id,
      accountId: request.accountId,
      ...(request.instanceId ? { instanceId: request.instanceId } : {}),
      userId: input.userId,
      action: input.action === "answered" ? "accept" : "decline",
      ...(input.content ? { content: input.content } : {}),
    });
    return true;
  } catch {
    // no-cause: the publish may carry the person's answer; only the failure is reported.
    log.warn("MCP elicitation answer could not be published", { server: request.server });
    return false;
  }
}

// ============================================================================
// The daemon: ask and wait
// ============================================================================

function normalizeSurface(surface: SlackMcpElicitationSurface | undefined): SlackMcpElicitationSurface | null {
  const accountId = text(surface?.accountId);
  const chatId = text(surface?.chatId)?.toUpperCase();
  const userId = text(surface?.userId)?.toUpperCase();
  const threadTs = text(surface?.threadTs);
  const instanceId = text(surface?.instanceId);
  if (!accountId || !chatId || !userId) return null;
  if (!SLACK_CHAT_ID.test(chatId) || !SLACK_USER_ID.test(userId)) return null;
  if (threadTs && !SLACK_TS.test(threadTs)) return null;
  return {
    accountId,
    ...(instanceId ? { instanceId } : {}),
    chatId,
    ...(threadTs ? { threadTs } : {}),
    userId,
  };
}

/**
 * The Slack surface of this turn for one person: the Slack user that person
 * owns in this workspace, and the turn's own conversation, where the card is
 * posted privately to them. Null when there is no such user or chat.
 */
export function resolveSlackMcpElicitationSurface(input: {
  source: Pick<ContextSource, "channel" | "accountId" | "chatId" | "threadId" | "instanceId">;
  contactId: string;
}): SlackMcpElicitationSurface | null {
  const source = input.source;
  if (source?.channel?.trim().toLowerCase() !== "slack") return null;
  const contactId = text(input.contactId);
  const accountId = text(source.accountId);
  if (!contactId || !accountId) return null;
  const userId = findSlackUserIdForContact({ contactId, instanceId: text(source.instanceId) ?? accountId });
  if (!userId) return null;
  return normalizeSurface({
    accountId,
    ...(text(source.instanceId) ? { instanceId: text(source.instanceId) as string } : {}),
    chatId: text(source.chatId) ?? "",
    ...(text(source.threadId) ? { threadTs: text(source.threadId) as string } : {}),
    userId,
  });
}

export interface SlackMcpElicitationAskBase {
  readonly surface: SlackMcpElicitationSurface;
  readonly server: string;
  readonly tool: string;
  readonly contactId: string;
  readonly agentId?: string;
  readonly sessionName?: string;
  /** The `elicitation` approval row of this request. */
  readonly approvalId?: string;
  readonly message: string;
  /** When the answer must be in hand (epoch ms). */
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

export type SlackMcpElicitationAsk = SlackMcpElicitationAskBase &
  (
    | { readonly mode: "form"; readonly fields: readonly McpElicitationField[] }
    | { readonly mode: "url"; readonly url: string }
  );

export type SlackMcpElicitationAnswer =
  | { readonly action: "accept"; readonly content?: Record<string, unknown>; readonly reason: string }
  | { readonly action: "decline"; readonly reason: string }
  | { readonly action: "cancel"; readonly reason: string };

export interface SlackMcpElicitationAskDependencies {
  deliver: DeliverSlackPrivateCard;
  nats: Pick<typeof runtimeNats, "subscribe">;
  create: typeof createSlackMcpElicitationRequest;
  getRequest: typeof getSlackMcpElicitationRequest;
  settle: typeof settleSlackMcpElicitationRequest;
  now: () => number;
}

const defaultAskDependencies: SlackMcpElicitationAskDependencies = {
  deliver: deliverSlackPrivateCard,
  nats: runtimeNats,
  create: createSlackMcpElicitationRequest,
  getRequest: getSlackMcpElicitationRequest,
  settle: settleSlackMcpElicitationRequest,
  now: Date.now,
};

/**
 * Ask one person through a private Slack modal and wait for their answer
 * inside the call's budget.
 *
 * `decline` is the person's own refusal (they closed the modal). `cancel`
 * covers everything else: no surface, a card that was not delivered, a
 * timeout, a cancelled call, or an answer that does not fit the plan. Nothing
 * but a submitted, validated form ever becomes content.
 */
export async function askSlackMcpElicitation(
  ask: SlackMcpElicitationAsk,
  dependencies: Partial<SlackMcpElicitationAskDependencies> = {},
): Promise<SlackMcpElicitationAnswer> {
  const deps = { ...defaultAskDependencies, ...dependencies };
  const surface = normalizeSurface(ask.surface);
  if (!surface) return { action: "cancel", reason: "no_private_surface" };
  if (ask.signal?.aborted) return { action: "cancel", reason: "cancelled" };
  const started = deps.now();
  if (!Number.isFinite(ask.deadline) || ask.deadline <= started) return { action: "cancel", reason: "no_time" };

  let request: SlackMcpElicitationRequest;
  try {
    request = deps.create({
      surface,
      contactId: ask.contactId,
      ...(ask.agentId ? { agentId: ask.agentId } : {}),
      ...(ask.sessionName ? { sessionName: ask.sessionName } : {}),
      ...(ask.approvalId ? { approvalId: ask.approvalId } : {}),
      server: ask.server,
      tool: ask.tool,
      message: ask.message,
      ...(ask.mode === "form" ? { mode: "form" as const, fields: ask.fields } : { mode: "url" as const, url: ask.url }),
      createdAt: started,
      expiresAt: ask.deadline,
    });
  } catch {
    // no-cause: without the row nobody is asked; the fixed reason is the outcome.
    log.warn("MCP elicitation request could not be stored", { server: ask.server });
    return { action: "cancel", reason: "store_failed" };
  }

  // The listener starts before the card, so an answer cannot arrive unheard.
  const waiting = waitForSlackMcpElicitationAnswer(request, {
    nats: deps.nats,
    getRequest: deps.getRequest,
    now: deps.now,
    deadline: ask.deadline,
    ...(ask.signal ? { signal: ask.signal } : {}),
  });

  const card = buildMcpElicitationInvitation(request);
  try {
    await deps.deliver(
      {
        accountId: surface.accountId,
        chatId: surface.chatId,
        userId: surface.userId,
        ...(surface.threadTs ? { threadTs: surface.threadTs } : {}),
      },
      card,
    );
  } catch {
    // no-cause: a delivery error may name the chat; the fixed reason is the outcome.
    log.warn("MCP elicitation card was not delivered", { server: ask.server });
    waiting.stop();
    deps.settle({ id: request.id, status: "cancelled", now: deps.now() });
    return { action: "cancel", reason: "send_failed" };
  }

  const answer = await waiting.answer;
  if (answer.kind === "declined") return { action: "decline", reason: "declined" };
  if (answer.kind !== "answered") {
    deps.settle({ id: request.id, status: answer.kind === "cancelled" ? "cancelled" : "expired", now: deps.now() });
    return { action: "cancel", reason: answer.kind === "cancelled" ? "cancelled" : "timeout" };
  }
  if (request.mode === "url") return { action: "accept", reason: "accepted" };
  const content = answer.content ?? {};
  for (const key of Object.keys(content)) {
    if (!request.fields.some((field) => field.name === key)) return { action: "cancel", reason: "invalid_answer" };
  }
  for (const field of request.fields) {
    const value = content[field.name];
    if (value === undefined) {
      if (field.required) return { action: "cancel", reason: "invalid_answer" };
      continue;
    }
    if (!checkMcpFieldValue(field, value)) return { action: "cancel", reason: "invalid_answer" };
  }
  return { action: "accept", content, reason: "accepted" };
}

type SlackMcpElicitationWaitResult =
  | { kind: "answered"; content?: Record<string, unknown> }
  | { kind: "declined" }
  | { kind: "timeout" }
  | { kind: "cancelled" };

/**
 * Wait for the one answer of this request. An event is trusted only after the
 * row proves it: the bound user, the account, and a status only `ravi-channels`
 * could have claimed.
 */
function waitForSlackMcpElicitationAnswer(
  request: SlackMcpElicitationRequest,
  input: {
    nats: Pick<typeof runtimeNats, "subscribe">;
    getRequest: typeof getSlackMcpElicitationRequest;
    now: () => number;
    deadline: number;
    signal?: AbortSignal;
  },
): { answer: Promise<SlackMcpElicitationWaitResult>; stop: () => void } {
  const stream = input.nats.subscribe(MCP_ELICITATION_ANSWER_SUBJECT);
  let settled = false;
  let finish: (result: SlackMcpElicitationWaitResult) => void = () => {};
  const answer = new Promise<SlackMcpElicitationWaitResult>((resolve) => {
    const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, input.deadline - input.now()));
    const onAbort = () => finish({ kind: "cancelled" });
    finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      void stream.return?.(undefined);
      resolve(result);
    };
    if (input.signal?.aborted) finish({ kind: "cancelled" });
    else input.signal?.addEventListener("abort", onAbort, { once: true });

    void (async () => {
      try {
        for await (const event of stream) {
          if (settled) return;
          const data = record(event.data) ?? {};
          if (text(data.requestId) !== request.id) continue;
          const userId = text(data.userId)?.toUpperCase();
          const action = text(data.action);
          const current = input.getRequest(request.id);
          // Only the row decides: the bound user, this account, and a status
          // the channels runner claimed for exactly this answer.
          if (!current || current.userId !== userId || current.accountId !== request.accountId) continue;
          if (action === "decline" && current.status === "declined") {
            finish({ kind: "declined" });
            return;
          }
          if (action !== "accept" || current.status !== "answered") continue;
          const content = record(data.content);
          finish({ kind: "answered", ...(content ? { content } : {}) });
          return;
        }
      } catch {
        // no-cause: a broken listener cannot be read as an answer; the call times out instead.
        log.warn("MCP elicitation answer listener failed", { server: request.server });
        finish({ kind: "timeout" });
      }
    })();
  });
  return { answer, stop: () => finish({ kind: "cancelled" }) };
}
