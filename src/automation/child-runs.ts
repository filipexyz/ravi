/**
 * Automation runs in a child session ("thread mode").
 *
 * A cron job (and, later, a trigger) in thread mode opens a fresh child
 * session for every run. Only that run enters it, and its parent is the job's
 * report-to session. The child answers to its parent through the return
 * primitives every thread already has: `ravi sessions report` (progress) and
 * `ravi sessions close-thread [--return <result>]` (final, delivered once).
 *
 * The contract knows no channel. A surface adapter may show the run somewhere
 * (a Slack thread under the parent's chat); without one the run is headless:
 * its replies go to no chat and the parent sees only the returns. That keeps
 * the run working the same for a WhatsApp group, a terminal or Slack.
 *
 * When the run's turn ends and the child is still open, the owner of the run
 * (the cron runner) closes it: a reply that is not silent goes to the parent
 * once, `@@SILENT@@` or no reply closes without a word, and a failed turn
 * sends one error. A run never stays open.
 *
 * Authority: the run's prompt carries the job's own envelope, published by the
 * runner. The return is a `session.return` prompt with text only, so nothing
 * here can widen the job's owner, `runsAsOperator` or inherited requester.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { publishChannelSessionPrompt, type ChannelPromptTransport } from "../channels/session-prompt.js";
import { CliExpectedError } from "../cli/expected-error.js";
import { getDb as getChatDb } from "../db.js";
import { getDb } from "../router/router-db.js";
import { deleteSession, getSession } from "../router/index.js";

export type ChildRunOriginKind = "cron" | "trigger";
export type ChildRunStatus = "open" | "closed";
/**
 * - `none`: still open, nothing returned yet.
 * - `pending`: closed with a return that has not reached the parent yet.
 * - `returned`: the parent got the result.
 * - `silent`: closed with nothing for the parent.
 * - `error`: the run failed and the parent got the error.
 */
export type ChildRunReturnState = "none" | "pending" | "returned" | "silent" | "error";
export type ChildRunSurface = "headless";

/** Closed runs kept per job (session and history); older ones are deleted when a new run opens. */
export const CHILD_RUNS_KEPT_PER_ORIGIN = 20;
/** Longest result or error text a return carries; the run's session keeps the rest. */
export const CHILD_RUN_RETURN_MAX_CHARS = 4000;

export interface AutomationChildRun {
  id: string;
  originKind: ChildRunOriginKind;
  originId: string;
  originName: string;
  agentId: string;
  parentSessionKey: string;
  parentSessionName: string;
  childSessionKey: string;
  childSessionName: string;
  surface: ChildRunSurface;
  status: ChildRunStatus;
  returnState: ChildRunReturnState;
  returnKind?: ChildRunReturnKind;
  returnText?: string;
  closedAt?: number;
  parentNotifiedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type ChildRunReturnKind = "result" | "auto" | "error";

interface ChildRunRow {
  id: string;
  origin_kind: ChildRunOriginKind;
  origin_id: string;
  origin_name: string;
  agent_id: string;
  parent_session_key: string;
  parent_session_name: string;
  child_session_key: string;
  child_session_name: string;
  surface: ChildRunSurface;
  status: ChildRunStatus;
  return_state: ChildRunReturnState;
  return_kind: ChildRunReturnKind | null;
  return_text: string | null;
  closed_at: number | null;
  parent_notified_at: number | null;
  created_at: number;
  updated_at: number;
}

/** The table is created by the router schema owner (`automation_child_runs` in router-db). */
function db(): Database {
  return getDb();
}

function fromRow(row: ChildRunRow): AutomationChildRun {
  return {
    id: row.id,
    originKind: row.origin_kind,
    originId: row.origin_id,
    originName: row.origin_name,
    agentId: row.agent_id,
    parentSessionKey: row.parent_session_key,
    parentSessionName: row.parent_session_name,
    childSessionKey: row.child_session_key,
    childSessionName: row.child_session_name,
    surface: row.surface,
    status: row.status,
    returnState: row.return_state,
    ...(row.return_kind ? { returnKind: row.return_kind } : {}),
    ...(row.return_text !== null ? { returnText: row.return_text } : {}),
    ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
    ...(row.parent_notified_at !== null ? { parentNotifiedAt: row.parent_notified_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface OpenChildRunInput {
  id: string;
  originKind: ChildRunOriginKind;
  originId: string;
  originName: string;
  agentId: string;
  parentSessionKey: string;
  parentSessionName: string;
  childSessionKey: string;
  childSessionName: string;
  now?: number;
}

export function openChildRun(input: OpenChildRunInput): AutomationChildRun {
  const now = input.now ?? Date.now();
  db()
    .query(`INSERT INTO automation_child_runs (
      id, origin_kind, origin_id, origin_name, agent_id, parent_session_key, parent_session_name,
      child_session_key, child_session_name, surface, status, return_state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'headless', 'open', 'none', ?, ?)`)
    .run(
      input.id,
      input.originKind,
      input.originId,
      input.originName,
      input.agentId,
      input.parentSessionKey,
      input.parentSessionName,
      input.childSessionKey,
      input.childSessionName,
      now,
      now,
    );
  return getChildRun(input.id)!;
}

export function getChildRun(id: string): AutomationChildRun | null {
  const row = db().query<ChildRunRow, [string]>("SELECT * FROM automation_child_runs WHERE id = ?").get(id);
  return row ? fromRow(row) : null;
}

/** The run a child session belongs to, by the session's key. */
export function findChildRunByChildSession(childSessionKey: string): AutomationChildRun | null {
  const row = db()
    .query<ChildRunRow, [string]>("SELECT * FROM automation_child_runs WHERE child_session_key = ?")
    .get(childSessionKey);
  return row ? fromRow(row) : null;
}

export function listChildRunsForOrigin(
  originKind: ChildRunOriginKind,
  originId: string,
  limit = 20,
): AutomationChildRun[] {
  return db()
    .query<ChildRunRow, [string, string, number]>(
      "SELECT * FROM automation_child_runs WHERE origin_kind = ? AND origin_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .all(originKind, originId, limit)
    .map(fromRow);
}

export function listOpenChildRuns(originKind: ChildRunOriginKind, originId: string): AutomationChildRun[] {
  return db()
    .query<ChildRunRow, [string, string]>(
      "SELECT * FROM automation_child_runs WHERE origin_kind = ? AND origin_id = ? AND status = 'open' ORDER BY created_at, rowid",
    )
    .all(originKind, originId)
    .map(fromRow);
}

export function childRunError(code: string, message: string, exitCode = 1): CliExpectedError {
  return new CliExpectedError(message, code, exitCode);
}

function clip(text: string): string {
  if (text.length <= CHILD_RUN_RETURN_MAX_CHARS) return text;
  return `${text.slice(0, CHILD_RUN_RETURN_MAX_CHARS)}\n...[truncated]`;
}

function runLabel(run: AutomationChildRun): string {
  return `${run.originKind} "${run.originName}" (${run.childSessionName})`;
}

/** The internal turn the parent receives; the same shape a Slack thread return has. */
export function buildChildRunParentNotice(
  run: AutomationChildRun,
  kind: "progress" | ChildRunReturnKind,
  body: string,
): string {
  const headline =
    kind === "progress"
      ? "reporta progresso."
      : kind === "error"
        ? "falhou."
        : kind === "auto"
          ? "terminou sem retorno explícito; esta é a última resposta dela."
          : "terminou.";
  const label = kind === "progress" ? "Progresso" : kind === "error" ? "Erro" : "Resultado";
  return [
    `[System] Inform: execução ${runLabel(run)} ${headline}`,
    `Ler a execução: ravi sessions read ${run.childSessionName}`,
    `${label}: ${clip(body)}`,
  ].join("\n");
}

export interface ChildRunDependencies {
  publishPrompt?: ChannelPromptTransport;
  now?: () => number;
}

async function publishToParent(
  run: AutomationChildRun,
  kind: "progress" | ChildRunReturnKind,
  body: string,
  messageId: string,
  options: { callerContextId?: string; dependencies?: ChildRunDependencies },
): Promise<void> {
  const parent = getSession(run.parentSessionKey);
  if (!parent) {
    throw childRunError(
      "THREAD_PARENT_MISSING",
      `The parent session of run ${run.childSessionName} no longer exists: ${run.parentSessionName}`,
    );
  }
  await publishChannelSessionPrompt(
    {
      sessionName: parent.name ?? parent.sessionKey,
      action: "session.return",
      principal: { type: "agent", id: run.agentId },
      ...(options.callerContextId ? { callerContextId: options.callerContextId } : {}),
      payload: {
        prompt: buildChildRunParentNotice(run, kind, body),
        deliveryBarrier: "after_response",
        deliveryBarrierSource: "default",
        _automationChildRun: {
          eventId: messageId,
          eventType: kind === "progress" ? "run.report" : "run.return",
          runId: run.id,
          originKind: run.originKind,
          originId: run.originId,
          parentSessionKey: run.parentSessionKey,
          childSessionKey: run.childSessionKey,
          childSessionName: run.childSessionName,
        },
      },
      options: { messageId },
    },
    options.dependencies?.publishPrompt,
  );
}

/** Progress from an open run to its parent; the run stays open. */
export async function reportChildRunProgress(
  run: AutomationChildRun,
  message: string,
  options: { callerContextId?: string; dependencies?: ChildRunDependencies } = {},
): Promise<{ messageId: string }> {
  const text = message.trim();
  if (!text) throw childRunError("USAGE_ERROR", "Report message is required", 2);
  if (run.status !== "open") {
    throw childRunError("THREAD_CLOSED", `Run ${run.childSessionName} is already closed; its parent got its return`, 1);
  }
  const messageId = `automation-run-report:${run.id}:${randomUUID()}`;
  await publishToParent(run, "progress", text, messageId, options);
  return { messageId };
}

export interface CloseChildRunResult {
  run: AutomationChildRun;
  changed: boolean;
  parentReturnDelivered: boolean;
}

/**
 * Close a run. With `returnText` the parent gets it once (kind `result`,
 * `auto` or `error`); without it the run closes silently. Closing a closed run
 * changes nothing, except that a return still pending is delivered again.
 */
export async function closeChildRun(
  run: AutomationChildRun,
  close: { kind: ChildRunReturnKind; text: string } | null,
  options: { callerContextId?: string; dependencies?: ChildRunDependencies } = {},
): Promise<CloseChildRunResult> {
  const now = options.dependencies?.now?.() ?? Date.now();
  const text = close?.text.trim() ? clip(close.text.trim()) : undefined;
  const nextState: ChildRunReturnState = text ? "pending" : "silent";
  const changed =
    db()
      .query(`UPDATE automation_child_runs
        SET status = 'closed', return_state = ?, return_kind = ?, return_text = ?, closed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'open'`)
      .run(nextState, text ? close!.kind : null, text ?? null, now, now, run.id).changes > 0;
  let current = getChildRun(run.id)!;
  let parentReturnDelivered = false;
  if (current.returnState === "pending" && current.returnText && current.returnKind) {
    const messageId = `automation-run-return:${current.id}`;
    await publishToParent(current, current.returnKind, current.returnText, messageId, options);
    const delivered = current.returnKind === "error" ? "error" : "returned";
    db()
      .query(
        "UPDATE automation_child_runs SET return_state = ?, parent_notified_at = ?, updated_at = ? WHERE id = ? AND return_state = 'pending'",
      )
      .run(delivered, now, now, current.id);
    parentReturnDelivered = true;
    current = getChildRun(run.id)!;
  }
  return { run: current, changed, parentReturnDelivered };
}

/**
 * The run's final reply, from the run session's own history. The runtime keeps
 * every visible assistant reply there whether or not it reaches a chat, and a
 * headless run reaches none. Null when the run replied nothing or stayed silent.
 */
export function readChildRunLastReply(run: AutomationChildRun): string | null {
  const row = getChatDb()
    .query<{ content: string }, [string]>(`
      SELECT content FROM messages
      WHERE session_id = ? AND role = 'assistant' AND COALESCE(utterance_class, 'final') = 'final'
      ORDER BY id DESC LIMIT 1
    `)
    .get(run.childSessionName);
  const text = row?.content?.trim();
  return text && text !== "@@SILENT@@" ? text : null;
}

/**
 * Delete the sessions (and rows) of closed runs beyond the newest `keep` of
 * one origin, so a job that runs every few minutes does not pile up sessions.
 * Open runs and runs whose return has not reached the parent stay.
 */
export function pruneClosedChildRuns(
  originKind: ChildRunOriginKind,
  originId: string,
  keep = CHILD_RUNS_KEPT_PER_ORIGIN,
): string[] {
  const stale = db()
    .query<ChildRunRow, [string, string, number]>(`
      SELECT * FROM automation_child_runs
      WHERE origin_kind = ? AND origin_id = ? AND status = 'closed' AND return_state != 'pending'
      ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
    `)
    .all(originKind, originId, keep);
  const pruned: string[] = [];
  for (const row of stale) {
    deleteSession(row.child_session_key);
    db().query("DELETE FROM automation_child_runs WHERE id = ?").run(row.id);
    pruned.push(row.child_session_key);
  }
  return pruned;
}
