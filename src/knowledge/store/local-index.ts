// Local history index (contract §10.2): chat.db messages and local meeting
// transcripts, searchable with FTS5 (or LIKE when SQLite has no FTS5).
//
// Rows: `km:<messages.id>` for chat messages, `kt:<meetingKey>:<segIndex>`
// for transcript segments. Synthetic sessions (curator, Library requests),
// cloud meetings (already in the Console) and forgotten subjects are never
// indexed.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { getChatDbPath } from "../../db.js";
import { executeWrite } from "../../db/write-retry.js";
import { LIBRARY_REQUEST_CHANNEL } from "../../library/request-channel.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { logger } from "../../utils/logger.js";
import { dmContactForChat } from "../contacts.js";
import { parseInboundContent } from "../envelope.js";
import { buildLocalFtsQuery, foldKnowledgeText, knowledgeQueryTerms, sanitizeSpeakerName } from "../text.js";
import { KNOWLEDGE_CURATOR_CHANNEL } from "../types.js";
import { getKnowledgeDb, knowledgeFts5Available, readKnowledgeMeta, writeKnowledgeMeta } from "./db.js";
import { listForgottenSubjectIds } from "./forgotten.js";
import { purgeKnowledgeLocal } from "./purge.js";

const log = logger.child("knowledge:index");

const MESSAGE_BATCH = 500;
const MESSAGES_WATERMARK = "messages_watermark";
const TRANSCRIPTS_WATERMARK = "transcripts_watermark";
const LAST_INDEXED_AT = "last_indexed_at";
const PURGE_LAST_AT = "purge_last_at";
const SYNTHETIC_CHANNELS: ReadonlySet<string> = new Set([KNOWLEDGE_CURATOR_CHANNEL, LIBRARY_REQUEST_CHANNEL]);
const SYNTHETIC_SESSION_MARKERS = [`:${KNOWLEDGE_CURATOR_CHANNEL}:`, `:${LIBRARY_REQUEST_CHANNEL}:`];
const LIKE_SCAN_LIMIT = 20_000;

export type LocalDocKind = "chat" | "transcript";

export type LocalSearchHit = {
  ref: string;
  kind: LocalDocKind;
  text: string;
  speaker: string | null;
  sessionName: string | null;
  agentId: string | null;
  channel: string | null;
  chatId: string | null;
  recordedAt: number;
  startSec: number | null;
  meetingKey: string | null;
  bm25: number;
};

export type LocalReadRow = LocalSearchHit & { focus: boolean; textHash: string };

export type LocalReadResult = {
  ref: string;
  kind: LocalDocKind;
  /** The requested row. */
  focus: LocalReadRow;
  /** The requested row and its neighbours, in order. */
  rows: LocalReadRow[];
};

interface LocalDocRow {
  id: number;
  ref: string;
  kind: LocalDocKind;
  session_name: string | null;
  agent_id: string | null;
  channel: string | null;
  account_id: string | null;
  chat_id: string | null;
  role: string | null;
  speaker: string | null;
  contact_id: string | null;
  meeting_key: string | null;
  start_sec: number | null;
  recorded_at: number;
  text_hash: string;
  body: string;
  bm25?: number;
}

interface ChatMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  agent_id: string | null;
  channel: string | null;
  account_id: string | null;
  chat_id: string | null;
  created_at: string | null;
}

interface NewLocalDoc {
  ref: string;
  kind: LocalDocKind;
  sessionName: string | null;
  agentId: string | null;
  channel: string | null;
  accountId: string | null;
  chatId: string | null;
  role: string | null;
  speaker: string | null;
  contactId: string | null;
  meetingKey: string | null;
  startSec: number | null;
  recordedAt: number;
  body: string;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Indexes chat.db messages and local transcripts newer than the watermarks,
 * within `budgetMs` (checked between rows). `done` is false when the budget
 * ran out first; the next call continues from the watermarks.
 */
export function indexLocalSources(input: { budgetMs?: number; now?: number } = {}): {
  messages: number;
  transcripts: number;
  done: boolean;
} {
  const started = Date.now();
  const budgetMs = input.budgetMs ?? 5_000;
  const overBudget = () => Date.now() - started > budgetMs;
  const db = getKnowledgeDb();
  const fts = knowledgeFts5Available();
  const forgotten = listForgottenSubjectIds();

  const messages = indexMessages(db, fts, forgotten, overBudget);
  const transcripts = messages.done ? indexTranscripts(db, fts, overBudget) : { count: 0, done: false };
  writeKnowledgeMeta(LAST_INDEXED_AT, String(input.now ?? Date.now()), db);
  return { messages: messages.count, transcripts: transcripts.count, done: messages.done && transcripts.done };
}

function indexMessages(
  db: Database,
  fts: boolean,
  forgotten: ReadonlySet<string>,
  overBudget: () => boolean,
): { count: number; done: boolean } {
  const chatPath = getChatDbPath();
  if (!existsSync(chatPath)) return { count: 0, done: true };
  let chat: Database;
  try {
    chat = new Database(chatPath, { readonly: true });
  } catch (error) {
    log.warn("chat.db could not be opened for indexing", { error: errorText(error) });
    return { count: 0, done: true };
  }
  let count = 0;
  const contactCache = new Map<string, string | null>();
  try {
    chat.exec("PRAGMA busy_timeout = 5000");
    while (true) {
      const watermark = Number(readKnowledgeMeta(MESSAGES_WATERMARK, db) ?? "0") || 0;
      const rows = chat
        .prepare(
          `SELECT id, session_id, role, content, agent_id, channel, account_id, chat_id, created_at
           FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
        )
        .all(watermark, MESSAGE_BATCH) as ChatMessageRow[];
      if (rows.length === 0) return { count, done: true };
      let last = watermark;
      let stopped = false;
      executeWrite(
        db,
        (tx) => {
          for (const row of rows) {
            if (overBudget() && last !== watermark) {
              stopped = true;
              break;
            }
            last = row.id;
            const doc = messageDoc(row, forgotten, contactCache);
            if (doc && insertLocalDoc(tx, fts, doc)) count++;
          }
          writeMetaInTx(tx, MESSAGES_WATERMARK, String(last));
        },
        { label: "knowledge_index_messages" },
      );
      if (stopped || overBudget()) return { count, done: rows.length < MESSAGE_BATCH && !stopped };
      if (rows.length < MESSAGE_BATCH) return { count, done: true };
    }
  } catch (error) {
    if (isMissingMessagesTable(error)) return { count, done: true };
    throw error;
  } finally {
    chat.close();
  }
}

function messageDoc(
  row: ChatMessageRow,
  forgotten: ReadonlySet<string>,
  contactCache: Map<string, string | null>,
): NewLocalDoc | null {
  if (row.channel && SYNTHETIC_CHANNELS.has(row.channel)) return null;
  if (SYNTHETIC_SESSION_MARKERS.some((marker) => row.session_id?.includes(marker))) return null;
  if (row.role !== "user" && row.role !== "assistant") return null;
  const parsed = parseInboundContent(row.content ?? "");
  const body = parsed.searchText.trim();
  if (!body) return null;
  const chatId = row.chat_id?.trim() || null;
  let contactId: string | null = null;
  if (chatId) {
    const cacheKey = `${row.channel ?? ""}\u0000${chatId}`;
    if (!contactCache.has(cacheKey)) contactCache.set(cacheKey, dmContactForChat({ chatId, channel: row.channel }));
    contactId = contactCache.get(cacheKey) ?? null;
  }
  if ((contactId && forgotten.has(contactId)) || (chatId && forgotten.has(chatId))) return null;
  const speaker =
    row.role === "assistant"
      ? row.agent_id?.trim() || null
      : parsed.senderName
        ? sanitizeSpeakerName(parsed.senderName)
        : null;
  return {
    ref: `km:${row.id}`,
    kind: "chat",
    sessionName: row.session_id ?? null,
    agentId: row.agent_id ?? null,
    channel: row.channel ?? null,
    accountId: row.account_id ?? null,
    chatId,
    role: row.role,
    speaker,
    contactId,
    meetingKey: null,
    startSec: null,
    recordedAt: parseSqliteTime(row.created_at) ?? Date.now(),
    body,
  };
}

interface TranscriptFile {
  key: string;
  path: string;
  mtimeMs: number;
}

function indexTranscripts(db: Database, fts: boolean, overBudget: () => boolean): { count: number; done: boolean } {
  const root = join(getRaviStateDir(), "meetings");
  if (!existsSync(root)) return { count: 0, done: true };
  const watermark = parseTranscriptWatermark(readKnowledgeMeta(TRANSCRIPTS_WATERMARK, db));
  const files = listTranscriptFiles(root)
    .filter((file) => compareWatermark(file, watermark) > 0)
    .sort((a, b) => compareWatermark(a, { mtimeMs: b.mtimeMs, key: b.key }));
  let count = 0;
  for (const file of files) {
    if (overBudget() && count > 0) return { count, done: false };
    const docs = transcriptDocs(file);
    executeWrite(
      db,
      (tx) => {
        deleteDocsWhere(tx, fts, "meeting_key = ? AND kind = 'transcript'", [file.key]);
        for (const doc of docs) if (insertLocalDoc(tx, fts, doc)) count++;
        writeMetaInTx(tx, TRANSCRIPTS_WATERMARK, JSON.stringify({ mtimeMs: file.mtimeMs, key: file.key }));
      },
      { label: "knowledge_index_transcript" },
    );
  }
  return { count, done: true };
}

function listTranscriptFiles(root: string): TranscriptFile[] {
  const files: TranscriptFile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return files;
  }
  for (const key of entries) {
    // Cloud meetings are already in the Console.
    if (key === "cloud") continue;
    const path = join(root, key, "transcription.json");
    try {
      const stat = statSync(path);
      if (stat.isFile()) files.push({ key, path, mtimeMs: Math.floor(stat.mtimeMs) });
    } catch {
      // No transcript in this folder.
    }
  }
  return files;
}

function transcriptDocs(file: TranscriptFile): NewLocalDoc[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file.path, "utf8")) as unknown;
  } catch (error) {
    log.warn("unreadable transcription.json skipped", { meetingKey: file.key, error: errorText(error) });
    return [];
  }
  const root = objectValue(data);
  const segments = Array.isArray(root?.segments) ? root.segments : [];
  const startedAt = Date.parse(String(objectValue(root?.meeting)?.startedAt ?? ""));
  const docs: NewLocalDoc[] = [];
  segments.forEach((value, index) => {
    const segment = objectValue(value);
    const body = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!body) return;
    const startSec =
      typeof segment?.startSec === "number" && Number.isFinite(segment.startSec) ? segment.startSec : null;
    const speaker =
      typeof segment?.speaker === "string" && segment.speaker.trim() ? sanitizeSpeakerName(segment.speaker) : null;
    const recordedAt =
      Number.isFinite(startedAt) && startedAt > 0 ? startedAt + Math.round((startSec ?? 0) * 1000) : file.mtimeMs;
    docs.push({
      ref: `kt:${file.key}:${index}`,
      kind: "transcript",
      sessionName: null,
      agentId: null,
      channel: null,
      accountId: null,
      chatId: null,
      role: null,
      speaker,
      contactId: null,
      meetingKey: file.key,
      startSec,
      recordedAt,
      body,
    });
  });
  return docs;
}

function insertLocalDoc(db: Database, fts: boolean, doc: NewLocalDoc): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO knowledge_local_docs
         (ref, kind, session_name, agent_id, channel, account_id, chat_id, role, speaker, contact_id, meeting_key, start_sec, recorded_at, text_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      doc.ref,
      doc.kind,
      doc.sessionName,
      doc.agentId,
      doc.channel,
      doc.accountId,
      doc.chatId,
      doc.role,
      doc.speaker,
      doc.contactId,
      doc.meetingKey,
      doc.startSec,
      doc.recordedAt,
      textHash(doc.body),
    );
  if (result.changes === 0) return false;
  const id = Number(result.lastInsertRowid);
  db.prepare("INSERT OR REPLACE INTO knowledge_local_text (id, body, speaker) VALUES (?, ?, ?)").run(
    id,
    doc.body,
    doc.speaker,
  );
  if (fts) {
    db.prepare("INSERT INTO knowledge_local_fts (rowid, body, speaker) VALUES (?, ?, ?)").run(
      id,
      doc.body,
      doc.speaker,
    );
  }
  return true;
}

function deleteDocsWhere(db: Database, fts: boolean, where: string, params: SQLQueryBindings[]): number {
  const ids = (
    db.prepare(`SELECT id FROM knowledge_local_docs WHERE ${where}`).all(...params) as Array<{ id: number }>
  ).map((row) => row.id);
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    if (fts) db.prepare(`DELETE FROM knowledge_local_fts WHERE rowid IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM knowledge_local_text WHERE id IN (${placeholders})`).run(...chunk);
    db.prepare(`DELETE FROM knowledge_local_docs WHERE id IN (${placeholders})`).run(...chunk);
  }
  return ids.length;
}

/** Deletes the indexed rows of these chats (both platform and normalized ids may be given). */
export function deleteLocalRowsForChats(chatIds: readonly string[]): number {
  const ids = [...new Set(chatIds.map((id) => id?.trim()).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return 0;
  const db = getKnowledgeDb();
  const fts = knowledgeFts5Available();
  return executeWrite(
    db,
    (tx) => {
      let deleted = 0;
      for (let offset = 0; offset < ids.length; offset += 200) {
        const chunk = ids.slice(offset, offset + 200);
        deleted += deleteDocsWhere(tx, fts, `chat_id IN (${chunk.map(() => "?").join(", ")})`, chunk);
      }
      return deleted;
    },
    { label: "knowledge_delete_chat_rows" },
  );
}

// ---------------------------------------------------------------------------
// Search and read
// ---------------------------------------------------------------------------

export function searchLocal(input: {
  query: string;
  about?: { chatIds: string[] } | null;
  kinds?: LocalDocKind[];
  who?: string | null;
  since?: number | null;
  limit: number;
}): LocalSearchHit[] {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit || 8)));
  const terms = knowledgeQueryTerms(input.query);
  if (terms.length === 0) return [];
  if (input.kinds && input.kinds.length === 0) return [];
  if (input.about && input.about.chatIds.length === 0) return [];

  const where: string[] = [
    "(d.contact_id IS NULL OR d.contact_id NOT IN (SELECT subject_id FROM knowledge_forgotten_subjects))",
    "(d.chat_id IS NULL OR d.chat_id NOT IN (SELECT subject_id FROM knowledge_forgotten_subjects))",
  ];
  const params: SQLQueryBindings[] = [];
  if (input.kinds) {
    where.push(`d.kind IN (${input.kinds.map(() => "?").join(", ")})`);
    params.push(...input.kinds);
  }
  if (input.about) {
    where.push(`d.chat_id IN (${input.about.chatIds.map(() => "?").join(", ")})`);
    params.push(...input.about.chatIds);
  }
  if (typeof input.since === "number" && Number.isFinite(input.since)) {
    where.push("d.recorded_at >= ?");
    params.push(input.since);
  }
  const who = input.who ? foldKnowledgeText(input.who) : "";
  const keep = (row: LocalDocRow) => !who || foldKnowledgeText(row.speaker ?? "").includes(who);
  const fetch = who ? Math.min(500, limit * 10) : limit;

  const db = getKnowledgeDb();
  const rows = knowledgeFts5Available()
    ? searchFts(db, input.query, where, params, fetch)
    : searchLike(db, terms, where, params, fetch);
  return rows.filter(keep).slice(0, limit).map(toHit);
}

function searchFts(
  db: Database,
  query: string,
  where: string[],
  params: SQLQueryBindings[],
  limit: number,
): LocalDocRow[] {
  const match = buildLocalFtsQuery(query);
  if (!match) return [];
  const run = (expression: string, exclude: number[]) => {
    const extra = exclude.length ? ` AND d.id NOT IN (${exclude.map(() => "?").join(", ")})` : "";
    return db
      .prepare(
        `SELECT d.*, t.body AS body, bm25(knowledge_local_fts) AS bm25
         FROM knowledge_local_fts
         JOIN knowledge_local_docs d ON d.id = knowledge_local_fts.rowid
         JOIN knowledge_local_text t ON t.id = d.id
         WHERE knowledge_local_fts MATCH ? AND ${where.join(" AND ")}${extra}
         ORDER BY bm25 ASC, d.recorded_at DESC
         LIMIT ?`,
      )
      .all(expression, ...params, ...exclude, limit) as LocalDocRow[];
  };
  const hits = run(match.and, []);
  if (hits.length >= limit || match.and === match.or) return hits;
  return [
    ...hits,
    ...run(
      match.or,
      hits.map((row) => row.id),
    ).slice(0, limit - hits.length),
  ];
}

/**
 * The LIKE fallback for a SQLite without FTS5: rows are filtered in SQL, then
 * matched on folded text (SQL LIKE does not fold diacritics). Score is minus
 * the number of matched terms, so lower is better as with bm25.
 */
function searchLike(
  db: Database,
  terms: string[],
  where: string[],
  params: SQLQueryBindings[],
  limit: number,
): LocalDocRow[] {
  const likeAny = terms.map(() => "(t.body LIKE ? OR t.speaker LIKE ? OR d.speaker LIKE ?)");
  const likeParams = terms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`]);
  // Rows whose raw text already contains a term, plus recent rows that may
  // only match after folding diacritics.
  const rows = db
    .prepare(
      `SELECT d.*, t.body AS body FROM knowledge_local_docs d JOIN knowledge_local_text t ON t.id = d.id
       WHERE ${where.join(" AND ")}
       ORDER BY CASE WHEN ${likeAny.join(" OR ")} THEN 0 ELSE 1 END, d.recorded_at DESC
       LIMIT ?`,
    )
    .all(...params, ...likeParams, LIKE_SCAN_LIMIT) as LocalDocRow[];
  const scored = rows.flatMap((row) => {
    const folded = foldKnowledgeText(`${row.body} ${row.speaker ?? ""}`);
    const words = folded.split(" ");
    const matched = terms.filter((term) => words.some((word) => word.startsWith(term))).length;
    return matched > 0 ? [{ row, matched }] : [];
  });
  const all = scored.filter((entry) => entry.matched === terms.length);
  const some = all.length >= limit ? [] : scored.filter((entry) => entry.matched < terms.length);
  return [...all, ...some.sort((a, b) => b.matched - a.matched)]
    .slice(0, limit)
    .map((entry) => ({ ...entry.row, bm25: -entry.matched }));
}

/** A `km:` or `kt:` ref with `around` neighbours (same session or same meeting). Null when missing. */
export function readLocal(ref: string, around: number): LocalReadResult | null {
  const db = getKnowledgeDb();
  const focus = db
    .prepare(
      `SELECT d.*, t.body AS body FROM knowledge_local_docs d JOIN knowledge_local_text t ON t.id = d.id
       WHERE d.ref = ?
         AND (d.contact_id IS NULL OR d.contact_id NOT IN (SELECT subject_id FROM knowledge_forgotten_subjects))
         AND (d.chat_id IS NULL OR d.chat_id NOT IN (SELECT subject_id FROM knowledge_forgotten_subjects))`,
    )
    .get(ref) as LocalDocRow | null;
  if (!focus) return null;
  const n = Math.max(0, Math.min(10, Math.trunc(around || 0)));
  let rows: LocalDocRow[] = [focus];
  if (n > 0) {
    const scope =
      focus.kind === "chat"
        ? { where: "d.kind = 'chat' AND d.session_name IS ?", value: focus.session_name }
        : { where: "d.kind = 'transcript' AND d.meeting_key IS ?", value: focus.meeting_key };
    const select = (comparison: string, order: string) =>
      db
        .prepare(
          `SELECT d.*, t.body AS body FROM knowledge_local_docs d JOIN knowledge_local_text t ON t.id = d.id
           WHERE ${scope.where} AND d.id ${comparison} ? ORDER BY d.id ${order} LIMIT ?`,
        )
        .all(scope.value, focus.id, n) as LocalDocRow[];
    rows = [...select("<", "DESC").reverse(), focus, ...select(">", "ASC")];
    if (focus.kind === "transcript") rows.sort((a, b) => segmentIndex(a.ref) - segmentIndex(b.ref));
  }
  const toRead = (row: LocalDocRow): LocalReadRow => ({
    ...toHit(row),
    focus: row.id === focus.id,
    textHash: row.text_hash,
  });
  return { ref: focus.ref, kind: focus.kind, focus: toRead(focus), rows: rows.map(toRead) };
}

/** Row counts and freshness for `ravi knowledge sources`. */
export function localIndexStats(): {
  chatRows: number;
  transcriptRows: number;
  lastIndexedAt: number | null;
  fts5: boolean;
} {
  const db = getKnowledgeDb();
  const counts = db.prepare("SELECT kind, COUNT(*) AS n FROM knowledge_local_docs GROUP BY kind").all() as Array<{
    kind: LocalDocKind;
    n: number;
  }>;
  const last = Number(readKnowledgeMeta(LAST_INDEXED_AT, db));
  return {
    chatRows: counts.find((row) => row.kind === "chat")?.n ?? 0,
    transcriptRows: counts.find((row) => row.kind === "transcript")?.n ?? 0,
    lastIndexedAt: Number.isFinite(last) && last > 0 ? last : null,
    fts5: knowledgeFts5Available(),
  };
}

/** Header facts of indexed refs, without text (for `why` on a local run). */
export function describeLocalRefs(refs: readonly string[]): Map<string, LocalSearchHit> {
  const found = new Map<string, LocalSearchHit>();
  const unique = [...new Set(refs)];
  if (unique.length === 0) return found;
  const db = getKnowledgeDb();
  for (let offset = 0; offset < unique.length; offset += 200) {
    const chunk = unique.slice(offset, offset + 200);
    const rows = db
      .prepare(
        `SELECT d.*, '' AS body FROM knowledge_local_docs d WHERE d.ref IN (${chunk.map(() => "?").join(", ")})
           AND (d.contact_id IS NULL OR d.contact_id NOT IN (SELECT subject_id FROM knowledge_forgotten_subjects))`,
      )
      .all(...chunk) as LocalDocRow[];
    for (const row of rows) found.set(row.ref, toHit(row));
  }
  return found;
}

// ---------------------------------------------------------------------------
// Runner (leader only; started by the knowledge leader runners)
// ---------------------------------------------------------------------------

export const KNOWLEDGE_INDEX_INTERVAL_MS = 60_000;
/** One synchronous slice: short, so the daemon's event loop is never held long. */
export const RUNNER_BUDGET_MS = 250;
/** Slices per tick; the next tick continues from the watermark. */
const RUNNER_MAX_SLICES = 20;
const PURGE_EVERY_MS = 24 * 60 * 60_000;

let indexTimer: ReturnType<typeof setInterval> | null = null;
let firstIndexTimer: ReturnType<typeof setTimeout> | null = null;
let indexTickRunning = false;

/**
 * Runs one index pass in slices of `RUNNER_BUDGET_MS`, yielding to the event
 * loop (setImmediate) between slices, and, once a day, the local purge.
 * Never throws.
 */
export async function runKnowledgeIndexTick(
  now: number = Date.now(),
  deps: { index?: typeof indexLocalSources; yieldTurn?: () => Promise<void> } = {},
): Promise<void> {
  if (indexTickRunning) return;
  indexTickRunning = true;
  try {
    const index = deps.index ?? indexLocalSources;
    const yieldTurn = deps.yieldTurn ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    for (let slice = 0; slice < RUNNER_MAX_SLICES; slice++) {
      try {
        if (index({ budgetMs: RUNNER_BUDGET_MS, now }).done) break;
      } catch (error) {
        log.warn("knowledge index pass failed", { error: errorText(error) });
        break;
      }
      await yieldTurn();
    }
    try {
      const last = Number(readKnowledgeMeta(PURGE_LAST_AT) ?? "0") || 0;
      if (now - last >= PURGE_EVERY_MS) {
        const purged = purgeKnowledgeLocal(now);
        writeKnowledgeMeta(PURGE_LAST_AT, String(now));
        log.info("knowledge local purge", purged);
      }
    } catch (error) {
      log.warn("knowledge local purge failed", { error: errorText(error) });
    }
  } finally {
    indexTickRunning = false;
  }
}

export function startKnowledgeIndexRunner(): void {
  if (indexTimer) return;
  indexTimer = setInterval(() => void runKnowledgeIndexTick(), KNOWLEDGE_INDEX_INTERVAL_MS);
  indexTimer.unref?.();
  firstIndexTimer = setTimeout(() => {
    firstIndexTimer = null;
    void runKnowledgeIndexTick();
  }, 1_000);
  firstIndexTimer.unref?.();
}

export function stopKnowledgeIndexRunner(): void {
  if (indexTimer) clearInterval(indexTimer);
  indexTimer = null;
  if (firstIndexTimer) clearTimeout(firstIndexTimer);
  firstIndexTimer = null;
}

/** Tests only: whether the first-run timer is still armed. */
export function hasPendingKnowledgeIndexFirstRun(): boolean {
  return firstIndexTimer !== null;
}

export function isKnowledgeIndexRunnerRunning(): boolean {
  return indexTimer !== null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toHit(row: LocalDocRow): LocalSearchHit {
  return {
    ref: row.ref,
    kind: row.kind,
    text: row.body ?? "",
    speaker: row.speaker ?? null,
    sessionName: row.session_name ?? null,
    agentId: row.agent_id ?? null,
    channel: row.channel ?? null,
    chatId: row.chat_id ?? null,
    recordedAt: row.recorded_at,
    startSec: row.start_sec ?? null,
    meetingKey: row.meeting_key ?? null,
    bm25: typeof row.bm25 === "number" ? row.bm25 : 0,
  };
}

function writeMetaInTx(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO knowledge_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, Date.now());
}

function parseTranscriptWatermark(value: string | null): { mtimeMs: number; key: string } {
  if (!value) return { mtimeMs: 0, key: "" };
  try {
    const parsed = JSON.parse(value) as { mtimeMs?: unknown; key?: unknown };
    return {
      mtimeMs: typeof parsed.mtimeMs === "number" ? parsed.mtimeMs : 0,
      key: typeof parsed.key === "string" ? parsed.key : "",
    };
  } catch {
    return { mtimeMs: 0, key: "" };
  }
}

/** Orders transcript files by (mtime, folder name), the watermark's order. */
function compareWatermark(file: { mtimeMs: number; key: string }, mark: { mtimeMs: number; key: string }): number {
  if (file.mtimeMs !== mark.mtimeMs) return file.mtimeMs - mark.mtimeMs;
  return file.key < mark.key ? -1 : file.key > mark.key ? 1 : 0;
}

function segmentIndex(ref: string): number {
  const value = Number(ref.slice(ref.lastIndexOf(":") + 1));
  return Number.isFinite(value) ? value : 0;
}

/** chat.db `created_at` is SQLite `datetime('now')`: UTC without a zone. */
function parseSqliteTime(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const parsed = Date.parse(hasZone ? trimmed : `${trimmed.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isMissingMessagesTable(error: unknown): boolean {
  return error instanceof Error && /no such table: messages/i.test(error.message);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
