// The nightly curator (contract §13.3). Leader only, daily at 03:00 local.
//
// It runs only when `knowledge.curator.agent` is set, that agent has no exec
// capability (`agentHasNoExec`) and, on codex, the codex parity fixture holds.
// Each run covers every opted-in agent × non-owner contact with a direct
// message newer than `knowledge_curator_state.last_message_id`, at most 50 a
// night, never a forgotten subject. Each subject gets one fresh,
// capability-less session (see ./turn.ts); quoted spans are verified before
// anything is stored.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { findContactsByTag } from "../../contacts.js";
import { getChatDbPath } from "../../db.js";
import { executeWrite } from "../../db/write-retry.js";
import { LIBRARY_REQUEST_CHANNEL } from "../../library/request-channel.js";
import { codexKnowledgeParityHolds } from "../../permissions/codex-knowledge-parity.js";
import { dbGetAgent } from "../../router/router-db.js";
import { resolveRuntimeDefaults } from "../../runtime/runtime-defaults.js";
import { logger } from "../../utils/logger.js";
import { chatIdsForContact, dmContactForChat } from "../contacts.js";
import { parseInboundContent } from "../envelope.js";
import { insertKnowledgeItem, KNOWLEDGE_DRAFT_TTL_MS, listActiveItemsForSubject } from "../items/store.js";
import { OWNER_CONTACT_TAG } from "../owner.js";
import { agentHasNoExec } from "../safety/exposure.js";
import { knowledgeSettings, type KnowledgeSettings } from "../settings.js";
import { getKnowledgeDb, readKnowledgeMeta, writeKnowledgeMeta } from "../store/db.js";
import { isSubjectForgotten } from "../store/forgotten.js";
import { KNOWLEDGE_CURATOR_CHANNEL } from "../types.js";
import { buildCuratorPrompt, parseCuratorReply, validateCuratorItems, type CuratorMessage } from "./prompt.js";
import { retireCuratorSession, runCuratorTurn, type CuratorTurnOutcome } from "./turn.js";

const log = logger.child("knowledge:curator");

export const CURATOR_MAX_SUBJECTS = 50;
export const CURATOR_MESSAGES_PER_SUBJECT = 200;
export const CURATOR_RUN_HOUR = 3;
const CHECK_EVERY_MS = 10 * 60_000;
const LAST_DATE_META = "curator_last_date";
const SYNTHETIC_CHANNELS = [KNOWLEDGE_CURATOR_CHANNEL, LIBRARY_REQUEST_CHANNEL];

export type CuratorGate = { ok: true; curatorAgentId: string } | { ok: false; reason: string };

export interface CuratorSubject {
  agentId: string;
  contactId: string;
  chatIds: string[];
  sinceMessageId: number;
  newestMessageId: number;
}

export interface CuratorRunDeps {
  settings?: () => KnowledgeSettings;
  agentHasNoExec?: (agentId: string) => boolean;
  codexParityHolds?: () => boolean;
  /** The agent's runtime provider id, or null when the agent is unknown. */
  agentProvider?: (agentId: string) => string | null;
  readSubjectMessages?: (input: {
    agentId: string;
    chatIds: string[];
    sinceMessageId: number;
    limit: number;
  }) => CuratorMessage[];
  runTurn?: (input: { curatorAgentId: string; runId: string; prompt: string }) => Promise<CuratorTurnOutcome>;
  retireSession?: (input: { sessionKey: string; sessionName: string | null }) => void;
  isForgotten?: (subjectId: string) => boolean;
  newRunId?: () => string;
  now?: () => number;
}

export type CuratorSubjectResult = {
  proposed: number;
  activated: number;
  drafts: number;
  rejectedSpans: number;
  /** Why nothing ran, when nothing did. */
  skipped?: string | null;
};

/** Whether the curator may run now, and on which agent. */
export function curatorGate(deps: CuratorRunDeps = {}): CuratorGate {
  const settings = (deps.settings ?? knowledgeSettings)();
  const curatorAgentId = settings.curatorAgent;
  if (!curatorAgentId) return { ok: false, reason: "knowledge.curator.agent is not set" };
  const provider = (deps.agentProvider ?? defaultAgentProvider)(curatorAgentId);
  if (provider === null) return { ok: false, reason: `curator agent ${curatorAgentId} not found` };
  if (!safely(() => (deps.agentHasNoExec ?? agentHasNoExec)(curatorAgentId))) {
    return { ok: false, reason: `curator agent ${curatorAgentId} has exec capabilities` };
  }
  if (provider === "codex" && !safely(() => (deps.codexParityHolds ?? codexKnowledgeParityHolds)())) {
    return { ok: false, reason: "the codex parity fixture does not hold" };
  }
  return { ok: true, curatorAgentId };
}

export async function runCuratorForSubject(
  input: { agentId: string; contactId: string; chatIds: string[]; sinceMessageId: number },
  deps: CuratorRunDeps = {},
): Promise<CuratorSubjectResult> {
  const empty = (skipped: string | null): CuratorSubjectResult => ({
    proposed: 0,
    activated: 0,
    drafts: 0,
    rejectedSpans: 0,
    skipped,
  });
  const gate = curatorGate(deps);
  if (!gate.ok) {
    log.warn("knowledge curator skipped", { reason: gate.reason });
    return empty(gate.reason);
  }
  const isForgotten = deps.isForgotten ?? isSubjectForgotten;
  const chatIds = [...new Set(input.chatIds.map((id) => id.trim()).filter(Boolean))];
  if (isForgotten(input.contactId) || chatIds.some((chatId) => isForgotten(chatId))) return empty("forgotten subject");
  if (chatIds.length === 0) return empty("no chats");

  const messages = (deps.readSubjectMessages ?? readSubjectMessages)({
    agentId: input.agentId,
    chatIds,
    sinceMessageId: input.sinceMessageId,
    limit: CURATOR_MESSAGES_PER_SUBJECT,
  }).filter((message) => message.authoredText.trim());
  if (messages.length === 0) return empty("no new messages");

  const existing = listActiveItemsForSubject({
    scope: "contact",
    subjectId: input.contactId,
    agentId: input.agentId,
    limit: 40,
  });
  const { prompt } = buildCuratorPrompt({ agentId: input.agentId, messages, existing });
  const runId = (deps.newRunId ?? randomUUID)();
  let outcome: CuratorTurnOutcome | null = null;
  try {
    outcome = await (deps.runTurn ?? runCuratorTurn)({ curatorAgentId: gate.curatorAgentId, runId, prompt });
  } catch (error) {
    log.warn("knowledge curator turn failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    const sessionKey = outcome?.sessionKey ?? `agent:${gate.curatorAgentId}:${KNOWLEDGE_CURATOR_CHANNEL}:${runId}`;
    (deps.retireSession ?? retireCuratorSession)({ sessionKey, sessionName: outcome?.sessionName ?? null });
  }
  if (!outcome?.ok) {
    log.warn("knowledge curator turn had no answer", { failure: outcome?.ok === false ? outcome.failure : "error" });
    return empty(null);
  }

  const parsed = parseCuratorReply(outcome.reply);
  const validated = validateCuratorItems(parsed?.items ?? [], messages);
  const now = (deps.now ?? Date.now)();
  let activated = 0;
  let drafts = 0;
  for (const item of validated.items) {
    try {
      const stored = insertKnowledgeItem({
        scope: "contact",
        subjectId: input.contactId,
        agentId: input.agentId,
        kind: item.kind,
        key: item.key,
        body: item.body,
        status: item.inferred ? "draft" : "active",
        trust: item.inferred ? "inferred" : "said",
        speaker: item.speaker,
        recordedAt: item.recordedAt ?? now,
        expiresAt: item.inferred ? now + KNOWLEDGE_DRAFT_TTL_MS : null,
        supersededBy: null,
        createdBy: "curator",
        sources: item.evidence.map((evidence) => ({
          kind: "message" as const,
          ref: `km:${evidence.messageId}`,
          textHash: evidence.textHash,
          span: evidence.span,
        })),
      });
      if (stored.status === "active") activated++;
      else if (stored.status === "draft") drafts++;
    } catch (error) {
      log.warn("knowledge curator item not stored", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  const newest = messages.reduce((max, message) => Math.max(max, message.id), input.sinceMessageId);
  writeCuratorState(input.agentId, input.contactId, newest, now);
  log.info("knowledge curator subject done", {
    proposed: validated.proposed,
    activated,
    drafts,
    rejectedSpans: validated.rejectedSpans,
  });
  return { proposed: validated.proposed, activated, drafts, rejectedSpans: validated.rejectedSpans, skipped: null };
}

export interface CuratorPassDeps extends CuratorRunDeps {
  listSubjects?: (input: { agentIds: string[]; limit: number }) => CuratorSubject[];
}

/** One nightly pass over the selected subjects. Never throws. */
export async function runKnowledgeCuratorPass(deps: CuratorPassDeps = {}): Promise<{
  subjects: number;
  activated: number;
  drafts: number;
  rejectedSpans: number;
  skipped: string | null;
}> {
  const totals = { subjects: 0, activated: 0, drafts: 0, rejectedSpans: 0, skipped: null as string | null };
  try {
    const gate = curatorGate(deps);
    if (!gate.ok) {
      log.warn("knowledge curator skipped", { reason: gate.reason });
      return { ...totals, skipped: gate.reason };
    }
    const agentIds = (deps.settings ?? knowledgeSettings)().contactMemoryAgents;
    if (agentIds.length === 0) return { ...totals, skipped: "knowledge.contactMemory.agents is not set" };
    const subjects = (deps.listSubjects ?? listCuratorSubjects)({ agentIds, limit: CURATOR_MAX_SUBJECTS });
    for (const subject of subjects) {
      const result = await runCuratorForSubject(subject, deps);
      if (result.skipped && result.skipped !== "no new messages" && result.skipped !== "forgotten subject") {
        return { ...totals, skipped: result.skipped };
      }
      totals.subjects++;
      totals.activated += result.activated;
      totals.drafts += result.drafts;
      totals.rejectedSpans += result.rejectedSpans;
    }
  } catch (error) {
    log.warn("knowledge curator pass failed", { error: error instanceof Error ? error.message : String(error) });
  }
  return totals;
}

/**
 * Opted-in agent × contact pairs with a direct user message newer than the
 * curator watermark, newest first. Group chats, synthetic sessions, the owner
 * and forgotten subjects are left out.
 */
export function listCuratorSubjects(
  input: { agentIds: string[]; limit: number },
  deps: {
    readChatRows?: (
      agentIds: string[],
    ) => Array<{ agentId: string; channel: string | null; chatId: string; maxId: number }>;
    contactForChat?: (chatId: string, channel: string | null) => string | null;
    chatIdsForContact?: (contactId: string) => string[];
    isOwner?: (contactId: string) => boolean;
    isForgotten?: (subjectId: string) => boolean;
  } = {},
): CuratorSubject[] {
  const agentIds = [...new Set(input.agentIds.map((id) => id.trim()).filter(Boolean))];
  if (agentIds.length === 0) return [];
  const rows = (deps.readChatRows ?? readCuratorChatRows)(agentIds);
  const owners = deps.isOwner ? null : new Set(safeOwnerIds());
  const isOwner = deps.isOwner ?? ((contactId: string) => owners?.has(contactId) ?? false);
  const isForgotten = deps.isForgotten ?? isSubjectForgotten;
  const subjects = new Map<string, CuratorSubject>();
  for (const row of rows) {
    if (isForgotten(row.chatId)) continue;
    const contactId = (deps.contactForChat ?? ((chatId, channel) => dmContactForChat({ chatId, channel })))(
      row.chatId,
      row.channel,
    );
    if (!contactId || isOwner(contactId) || isForgotten(contactId)) continue;
    const id = `${row.agentId}\u0000${contactId}`;
    const subject = subjects.get(id) ?? {
      agentId: row.agentId,
      contactId,
      chatIds: (deps.chatIdsForContact ?? chatIdsForContact)(contactId),
      sinceMessageId: readCuratorState(row.agentId, contactId),
      newestMessageId: 0,
    };
    if (!subject.chatIds.includes(row.chatId)) subject.chatIds.push(row.chatId);
    subject.newestMessageId = Math.max(subject.newestMessageId, row.maxId);
    subjects.set(id, subject);
  }
  return [...subjects.values()]
    .filter((subject) => subject.newestMessageId > subject.sinceMessageId)
    .sort((a, b) => b.newestMessageId - a.newestMessageId)
    .slice(0, Math.max(0, input.limit));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let curatorTimer: ReturnType<typeof setInterval> | null = null;
let firstCuratorTimer: ReturnType<typeof setTimeout> | null = null;
let curatorRunning = false;

/** Runs the pass once per local day, at or after 03:00. */
export async function runKnowledgeCuratorTick(now: Date = new Date(), deps: CuratorPassDeps = {}): Promise<boolean> {
  if (curatorRunning || now.getHours() < CURATOR_RUN_HOUR) return false;
  const today = localDate(now);
  try {
    if (readKnowledgeMeta(LAST_DATE_META) === today) return false;
    // Marked first: a pass that fails is not retried every 10 minutes.
    writeKnowledgeMeta(LAST_DATE_META, today);
  } catch (error) {
    log.warn("knowledge curator tick failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  curatorRunning = true;
  try {
    await runKnowledgeCuratorPass(deps);
  } finally {
    curatorRunning = false;
  }
  return true;
}

/** Leader only; daily at 03:00 local. Idempotent. */
export function startKnowledgeCuratorRunner(): void {
  if (curatorTimer) return;
  curatorTimer = setInterval(() => void runKnowledgeCuratorTick(), CHECK_EVERY_MS);
  curatorTimer.unref?.();
  firstCuratorTimer = setTimeout(() => {
    firstCuratorTimer = null;
    void runKnowledgeCuratorTick();
  }, 60_000);
  firstCuratorTimer.unref?.();
}

export function stopKnowledgeCuratorRunner(): void {
  if (curatorTimer) clearInterval(curatorTimer);
  curatorTimer = null;
  if (firstCuratorTimer) clearTimeout(firstCuratorTimer);
  firstCuratorTimer = null;
}

/** Tests only: whether the first-run timer is still armed. */
export function hasPendingKnowledgeCuratorFirstRun(): boolean {
  return firstCuratorTimer !== null;
}

export function isKnowledgeCuratorRunnerRunning(): boolean {
  return curatorTimer !== null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCuratorState(agentId: string, subjectId: string): number {
  const row = getKnowledgeDb()
    .prepare("SELECT last_message_id FROM knowledge_curator_state WHERE agent_id = ? AND subject_id = ?")
    .get(agentId, subjectId) as { last_message_id: number } | null;
  return row?.last_message_id ?? 0;
}

function writeCuratorState(agentId: string, subjectId: string, lastMessageId: number, now: number): void {
  executeWrite(
    getKnowledgeDb(),
    (db) => {
      db.prepare(
        `INSERT INTO knowledge_curator_state (agent_id, subject_id, last_message_id, last_run_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, subject_id) DO UPDATE SET
           last_message_id = MAX(knowledge_curator_state.last_message_id, excluded.last_message_id),
           last_run_at = excluded.last_run_at`,
      ).run(agentId, subjectId, lastMessageId, now);
    },
    { label: "knowledge_curator_state" },
  );
}

function openChatDbReadonly(): Database | null {
  const path = getChatDbPath();
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  } catch {
    return null;
  }
}

const SYNTHETIC_FILTER = `(channel IS NULL OR channel NOT IN (${SYNTHETIC_CHANNELS.map(() => "?").join(", ")}))
  AND session_id NOT LIKE ? AND session_id NOT LIKE ?`;
const SYNTHETIC_PARAMS = [...SYNTHETIC_CHANNELS, `%:${KNOWLEDGE_CURATOR_CHANNEL}:%`, `%:${LIBRARY_REQUEST_CHANNEL}:%`];

function readCuratorChatRows(
  agentIds: string[],
): Array<{ agentId: string; channel: string | null; chatId: string; maxId: number }> {
  const db = openChatDbReadonly();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT agent_id, channel, chat_id, MAX(id) AS max_id FROM messages
         WHERE role = 'user' AND chat_id IS NOT NULL AND agent_id IN (${agentIds.map(() => "?").join(", ")})
           AND ${SYNTHETIC_FILTER}
         GROUP BY agent_id, channel, chat_id`,
      )
      .all(...agentIds, ...SYNTHETIC_PARAMS) as Array<{
      agent_id: string;
      channel: string | null;
      chat_id: string;
      max_id: number;
    }>;
    return rows.map((row) => ({ agentId: row.agent_id, channel: row.channel, chatId: row.chat_id, maxId: row.max_id }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** The subject's newest messages after the watermark, oldest first. */
export function readSubjectMessages(input: {
  agentId: string;
  chatIds: string[];
  sinceMessageId: number;
  limit: number;
}): CuratorMessage[] {
  if (input.chatIds.length === 0) return [];
  const db = openChatDbReadonly();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT id, role, content, created_at FROM messages
         WHERE chat_id IN (${input.chatIds.map(() => "?").join(", ")}) AND agent_id = ? AND id > ?
           AND role IN ('user','assistant') AND ${SYNTHETIC_FILTER}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...input.chatIds, input.agentId, input.sinceMessageId, ...SYNTHETIC_PARAMS, input.limit) as Array<{
      id: number;
      role: "user" | "assistant";
      content: string;
      created_at: string | null;
    }>;
    return rows.reverse().map((row) => ({
      id: row.id,
      role: row.role,
      authoredText: row.role === "user" ? parseInboundContent(row.content).authoredText : (row.content ?? "").trim(),
      createdAt: parseSqliteTime(row.created_at),
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function defaultAgentProvider(agentId: string): string | null {
  try {
    const agent = dbGetAgent(agentId);
    if (!agent) return null;
    return agent.provider ?? resolveRuntimeDefaults().provider.value;
  } catch {
    return null;
  }
}

function safeOwnerIds(): string[] {
  try {
    return findContactsByTag(OWNER_CONTACT_TAG).map((contact) => contact.id);
  } catch {
    return [];
  }
}

function safely(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** chat.db `created_at` is SQLite `datetime('now')`: UTC without a zone. */
function parseSqliteTime(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const parsed = Date.parse(hasZone ? trimmed : `${trimmed.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}
