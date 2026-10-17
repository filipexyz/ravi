import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { getKnowledgeDb } from "./db.js";
import { insertLocalRun } from "./local-runs.js";
import { purgeKnowledgeLocal } from "./purge.js";
import { recordTurnRead, upsertWriteApproval } from "./turn-reads.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-purge-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 17);

function item(input: {
  id: string;
  subject: string;
  status: "draft" | "active" | "archived" | "redacted";
  recordedAt: number;
  updatedAt?: number;
  expiresAt?: number | null;
}) {
  getKnowledgeDb()
    .prepare(
      `INSERT INTO knowledge_items (id, scope, subject_id, agent_id, kind, key, body, status, trust, speaker, recorded_at, expires_at, superseded_by, created_by, created_at, updated_at)
       VALUES (?, 'contact', ?, 'dev', 'fact', ?, 'b', ?, 'said', 'contact', ?, ?, NULL, 'curator', ?, ?)`,
    )
    .run(
      input.id,
      input.subject,
      input.id,
      input.status,
      input.recordedAt,
      input.expiresAt ?? null,
      input.recordedAt,
      input.updatedAt ?? input.recordedAt,
    );
  getKnowledgeDb()
    .prepare(
      "INSERT INTO knowledge_item_sources (item_id, source_kind, source_ref, text_hash) VALUES (?, 'message', ?, 'h')",
    )
    .run(input.id, `km:${input.id}`);
}

function chatDoc(ref: string, contactId: string, recordedAt: number) {
  getKnowledgeDb()
    .prepare(
      "INSERT INTO knowledge_local_docs (ref, kind, contact_id, chat_id, recorded_at, text_hash) VALUES (?, 'chat', ?, 'c', ?, 'h')",
    )
    .run(ref, contactId, recordedAt);
}

function status(id: string): string | null {
  const row = getKnowledgeDb().prepare("SELECT status FROM knowledge_items WHERE id = ?").get(id) as {
    status: string;
  } | null;
  return row?.status ?? null;
}

function count(table: string): number {
  return (getKnowledgeDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("purgeKnowledgeLocal", () => {
  it("archives items of subjects idle for 180 days and deletes them 30 days later", () => {
    chatDoc("km:1", "contact_idle", NOW - 200 * DAY);
    chatDoc("km:2", "contact_live", NOW - 10 * DAY);
    item({ id: "idle", subject: "contact_idle", status: "active", recordedAt: NOW - 300 * DAY });
    item({ id: "live", subject: "contact_live", status: "active", recordedAt: NOW - 300 * DAY });
    item({ id: "fresh-no-chat", subject: "contact_none", status: "active", recordedAt: NOW - 5 * DAY });
    item({
      id: "old-archived",
      subject: "contact_idle",
      status: "archived",
      recordedAt: NOW - 400 * DAY,
      updatedAt: NOW - 40 * DAY,
    });
    item({
      id: "recent-archived",
      subject: "contact_idle",
      status: "archived",
      recordedAt: NOW - 400 * DAY,
      updatedAt: NOW - 5 * DAY,
    });
    item({ id: "tombstone", subject: "contact_idle", status: "redacted", recordedAt: NOW - 400 * DAY });

    const result = purgeKnowledgeLocal(NOW);
    expect(status("idle")).toBe("archived");
    expect(status("live")).toBe("active");
    expect(status("fresh-no-chat")).toBe("active");
    expect(status("old-archived")).toBeNull();
    expect(status("recent-archived")).toBe("archived");
    expect(status("tombstone")).toBe("redacted");
    expect(result.itemsArchivedIdle).toBe(1);
    expect(result.itemsDeleted).toBe(1);
    const sources = getKnowledgeDb()
      .prepare("SELECT COUNT(*) AS n FROM knowledge_item_sources WHERE item_id = 'old-archived'")
      .get() as { n: number };
    expect(sources.n).toBe(0);
  });

  it("archives expired drafts", () => {
    chatDoc("km:1", "contact_a", NOW - DAY);
    item({ id: "draft-old", subject: "contact_a", status: "draft", recordedAt: NOW - DAY, expiresAt: NOW - 1 });
    item({ id: "draft-new", subject: "contact_a", status: "draft", recordedAt: NOW - DAY, expiresAt: NOW + DAY });
    purgeKnowledgeLocal(NOW);
    expect(status("draft-old")).toBe("archived");
    expect(status("draft-new")).toBe("draft");
  });

  it("drops expired mirror pages, old runs, turn reads, approvals, gaps and guards", () => {
    const db = getKnowledgeDb();
    db.prepare(
      `INSERT INTO knowledge_marked_pages (route_id, url, host, path, document_id, version, instances_json, fetched_at, expires_at)
       VALUES ('r-old', 'u', 'h', '/', 'd', 1, '[]', ?, ?), ('r-new', 'u2', 'h', '/x', 'd2', 1, '[]', ?, ?)`,
    ).run(NOW - DAY, NOW - 1, NOW, NOW + DAY);
    db.prepare(
      "INSERT INTO knowledge_marked_sections (route_id, stable_key, text) VALUES ('r-old', 'a', 't'), ('r-new', 'b', 't')",
    ).run();
    insertLocalRun({
      turnKey: "t",
      sessionName: null,
      consoleRunId: null,
      queryHash: "h",
      refs: [],
      lowestTier: null,
      issues: [],
      now: NOW - 31 * DAY,
    });
    insertLocalRun({
      turnKey: "t",
      sessionName: null,
      consoleRunId: null,
      queryHash: "h",
      refs: [],
      lowestTier: null,
      issues: [],
      now: NOW - DAY / 2,
    });
    recordTurnRead("old-turn", "said", NOW - 2 * DAY);
    recordTurnRead("new-turn", "said", NOW - 1000);
    upsertWriteApproval({
      id: "wa-old",
      turnKey: "old-turn",
      fingerprint: "f",
      summary: "s",
      status: "pending",
      requestedAt: NOW - 2 * DAY,
      decidedAt: null,
    });
    const gap = db.prepare(
      `INSERT INTO knowledge_gaps (id, agent_id, instance_id, channel, account_id, chat_id, contact_id, session_name, question, question_hash, status, created_at)
       VALUES (?, 'dev', 'i', 'whatsapp', 'main', 'c', 'contact_a', 's', 'q', 'h', ?, ?)`,
    );
    gap.run("gap-notified-old", "notified", NOW - 40 * DAY);
    gap.run("gap-pending-old", "pending", NOW - 40 * DAY);
    gap.run("gap-pending-new", "pending", NOW - DAY);
    const guard = db.prepare(
      `INSERT INTO knowledge_guarded_sessions (session_name, agent_id, instance_id, channel, chat_id, normalized_chat_id, contact_id, guarded_until)
       VALUES (?, 'dev', 'i', 'whatsapp', 'c', 'c', 'contact_a', ?)`,
    );
    guard.run("guard-old", NOW - 1);
    guard.run("guard-new", NOW + DAY);

    const result = purgeKnowledgeLocal(NOW);
    expect(result.markedPagesDeleted).toBe(1);
    expect(count("knowledge_marked_pages")).toBe(1);
    expect(count("knowledge_marked_sections")).toBe(1);
    expect(result.localRunsDeleted).toBe(1);
    expect(result.turnReadsDeleted).toBe(1);
    expect(result.writeApprovalsDeleted).toBe(1);
    expect(result.gapsDeleted).toBe(1);
    expect(result.gapsDropped).toBe(1);
    const gapStatus = db.prepare("SELECT id, status FROM knowledge_gaps ORDER BY id").all();
    expect(gapStatus).toEqual([
      { id: "gap-pending-new", status: "pending" },
      { id: "gap-pending-old", status: "dropped" },
    ]);
    expect(result.guardedSessionsDeleted).toBe(1);
    expect(count("knowledge_guarded_sessions")).toBe(1);
  });
});
