// Gaps store (contract §13.6): questions a packet conversation could not
// answer, marked by the agent with ⟦gap⟧. They go up to the Console as gap
// proposals and come back answered on the org's `/faq` page.
// `instanceId` is the OSS instance name (`source.accountId`), never the Omni
// UUID.

import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { executeWrite } from "../../db/write-retry.js";
import { getKnowledgeDb } from "../store/db.js";
import { foldKnowledgeText } from "../text.js";

export type KnowledgeGap = {
  id: string;
  agentId: string;
  instanceId: string;
  channel: string;
  accountId: string;
  chatId: string;
  contactId: string;
  sessionName: string;
  question: string;
  questionHash: string;
  status: "pending" | "uploaded" | "answered" | "notified" | "dropped";
  proposalId: string | null;
  createdAt: number;
  uploadedAt: number | null;
  notifiedAt: number | null;
};

/** At most this many gaps per contact per local day. */
export const KNOWLEDGE_GAPS_PER_CONTACT_PER_DAY = 5;
const MAX_QUESTION_CHARS = 1000;

type GapRow = {
  id: string;
  agent_id: string;
  instance_id: string;
  channel: string;
  account_id: string;
  chat_id: string;
  contact_id: string;
  session_name: string;
  question: string;
  question_hash: string;
  status: KnowledgeGap["status"];
  proposal_id: string | null;
  created_at: number;
  uploaded_at: number | null;
  notified_at: number | null;
};

function rowToGap(row: GapRow): KnowledgeGap {
  return {
    id: row.id,
    agentId: row.agent_id,
    instanceId: row.instance_id,
    channel: row.channel,
    accountId: row.account_id,
    chatId: row.chat_id,
    contactId: row.contact_id,
    sessionName: row.session_name,
    question: row.question,
    questionHash: row.question_hash,
    status: row.status,
    proposalId: row.proposal_id,
    createdAt: row.created_at,
    uploadedAt: row.uploaded_at,
    notifiedAt: row.notified_at,
  };
}

/** sha256(instanceId + foldKnowledgeText(question)): the dedupe key, also sent as the upload's `dedupeKey`. */
export function knowledgeGapQuestionHash(instanceId: string, question: string): string {
  return createHash("sha256")
    .update(instanceId + foldKnowledgeText(question))
    .digest("hex");
}

/** Start of the local calendar day that holds `now`. */
function localDayStart(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * At most `max` UTF-16 code units (the Console counts `.length`), never
 * cutting a surrogate pair in half.
 */
export function capUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function insertKnowledgeGap(
  input: {
    agentId: string;
    instanceId: string;
    channel: string;
    accountId: string;
    chatId: string;
    contactId: string;
    sessionName: string;
    question: string;
  },
  options: { now?: number } = {},
): { gap: KnowledgeGap; created: boolean; capped: boolean } {
  const now = options.now ?? Date.now();
  const question = capUtf16(input.question.trim(), MAX_QUESTION_CHARS);
  const questionHash = knowledgeGapQuestionHash(input.instanceId, question);
  return executeWrite(
    getKnowledgeDb(),
    (db) => {
      const existing = db
        .prepare(
          `SELECT * FROM knowledge_gaps WHERE question_hash = ? AND instance_id = ?
           AND contact_id = ? AND channel = ? AND account_id = ? AND chat_id = ?
           AND status IN ('pending','uploaded')
           ORDER BY created_at DESC LIMIT 1`,
        )
        // Keep a wait per recipient. The Console still deduplicates the
        // question via question_hash, linking these rows to one proposal.
        .get(
          questionHash,
          input.instanceId,
          input.contactId,
          input.channel,
          input.accountId,
          input.chatId,
        ) as GapRow | null;
      if (existing) return { gap: rowToGap(existing), created: false, capped: false };

      const gap: KnowledgeGap = {
        id: randomUUID(),
        agentId: input.agentId,
        instanceId: input.instanceId,
        channel: input.channel,
        accountId: input.accountId,
        chatId: input.chatId,
        contactId: input.contactId,
        sessionName: input.sessionName,
        question,
        questionHash,
        status: "pending",
        proposalId: null,
        createdAt: now,
        uploadedAt: null,
        notifiedAt: null,
      };

      const today = db
        .prepare("SELECT COUNT(*) AS count FROM knowledge_gaps WHERE contact_id = ? AND created_at >= ?")
        .get(input.contactId, localDayStart(now)) as { count: number } | null;
      if ((today?.count ?? 0) >= KNOWLEDGE_GAPS_PER_CONTACT_PER_DAY) {
        return { gap, created: false, capped: true };
      }

      db.prepare(
        `INSERT INTO knowledge_gaps (id, agent_id, instance_id, channel, account_id, chat_id, contact_id, session_name,
           question, question_hash, status, proposal_id, created_at, uploaded_at, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)`,
      ).run(
        gap.id,
        gap.agentId,
        gap.instanceId,
        gap.channel,
        gap.accountId,
        gap.chatId,
        gap.contactId,
        gap.sessionName,
        gap.question,
        gap.questionHash,
        gap.createdAt,
      );
      return { gap, created: true, capped: false };
    },
    { label: "knowledge_gap_insert" },
  );
}

export function listGapsByStatus(status: KnowledgeGap["status"], limit: number): KnowledgeGap[] {
  const rows = getKnowledgeDb()
    .prepare("SELECT * FROM knowledge_gaps WHERE status = ? ORDER BY created_at ASC, id ASC LIMIT ?")
    .all(status, clampLimit(limit)) as GapRow[];
  return rows.map(rowToGap);
}

export function getKnowledgeGap(id: string): KnowledgeGap | null {
  const row = getKnowledgeDb().prepare("SELECT * FROM knowledge_gaps WHERE id = ?").get(id) as GapRow | null;
  return row ? rowToGap(row) : null;
}

export function updateGap(
  id: string,
  patch: Partial<Pick<KnowledgeGap, "status" | "proposalId" | "uploadedAt" | "notifiedAt">>,
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.proposalId !== undefined) {
    sets.push("proposal_id = ?");
    values.push(patch.proposalId);
  }
  if (patch.uploadedAt !== undefined) {
    sets.push("uploaded_at = ?");
    values.push(patch.uploadedAt);
  }
  if (patch.notifiedAt !== undefined) {
    sets.push("notified_at = ?");
    values.push(patch.notifiedAt);
  }
  if (sets.length === 0) return;
  executeWrite(
    getKnowledgeDb(),
    (db) => {
      db.prepare(`UPDATE knowledge_gaps SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    },
    { label: "knowledge_gap_update" },
  );
}

export function listGapsForProposal(proposalId: string): KnowledgeGap[] {
  const rows = getKnowledgeDb()
    .prepare("SELECT * FROM knowledge_gaps WHERE proposal_id = ? ORDER BY created_at ASC, id ASC")
    .all(proposalId) as GapRow[];
  return rows.map(rowToGap);
}

/**
 * Claims the gaps of an answered proposal for notification, once: each gap
 * moves to `notified` in the same statement that returns it, so a replayed
 * inbox item or a second daemon claims nothing. With `instanceIds`, only
 * gaps of those instances (names) are claimed; an empty list claims none.
 */
export function claimGapsForNotification(
  proposalId: string,
  instanceIds?: readonly string[],
  options: { now?: number } = {},
): KnowledgeGap[] {
  if (instanceIds && instanceIds.length === 0) return [];
  const now = options.now ?? Date.now();
  return executeWrite(
    getKnowledgeDb(),
    (db: Database) => {
      const instanceFilter = instanceIds ? ` AND instance_id IN (${instanceIds.map(() => "?").join(", ")})` : "";
      const rows = db
        .prepare(
          `UPDATE knowledge_gaps SET status = 'notified', notified_at = ?
           WHERE proposal_id = ? AND status IN ('uploaded','answered')${instanceFilter}
           RETURNING *`,
        )
        .all(now, proposalId, ...(instanceIds ?? [])) as GapRow[];
      return rows.map(rowToGap).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    },
    { label: "knowledge_gap_claim" },
  );
}

/**
 * Drops a contact's gaps that were not answered yet (`pending`, `uploaded`),
 * so a forgotten contact's question is never uploaded. Returns the count.
 */
export function dropGapsForContact(contactId: string): number {
  const id = contactId?.trim();
  if (!id) return 0;
  return executeWrite(
    getKnowledgeDb(),
    (db) =>
      db
        .prepare(
          "UPDATE knowledge_gaps SET status = 'dropped' WHERE contact_id = ? AND status IN ('pending','uploaded')",
        )
        .run(id).changes,
    { label: "knowledge_gap_drop_contact" },
  );
}

/** Gaps in `answered`, for mirror sync step 4 (oldest first). */
export function listAnsweredGaps(limit: number): KnowledgeGap[] {
  return listGapsByStatus("answered", limit);
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.min(Math.floor(limit), 10_000);
}
