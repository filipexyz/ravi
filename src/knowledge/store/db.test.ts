import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { saveMessage } from "../../db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  closeKnowledgeDb,
  getKnowledgeDb,
  getKnowledgeDbPath,
  knowledgeFts5Available,
  openKnowledgeDbReadonly,
  readKnowledgeMeta,
  setKnowledgeFts5ForcedOff,
} from "./db.js";
import { indexLocalSources, searchLocal } from "./local-index.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-db-");
});

afterEach(async () => {
  setKnowledgeFts5ForcedOff(false);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("knowledge.db", () => {
  it("creates the file with the schema and opening twice is a no-op", () => {
    const db = getKnowledgeDb();
    expect(existsSync(getKnowledgeDbPath())).toBe(true);
    expect(getKnowledgeDb()).toBe(db);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const table of [
      "knowledge_meta",
      "knowledge_local_docs",
      "knowledge_local_text",
      "knowledge_forgotten_subjects",
      "knowledge_local_runs",
      "knowledge_turn_reads",
      "knowledge_write_approvals",
      "knowledge_items",
      "knowledge_item_sources",
      "knowledge_marked_pages",
      "knowledge_marked_sections",
      "knowledge_briefs",
      "knowledge_gaps",
      "knowledge_guarded_sessions",
      "knowledge_curator_state",
    ]) {
      expect(tables).toContain(table);
    }
    closeKnowledgeDb();
    // Reopening an existing file applies the schema again without error.
    const again = getKnowledgeDb();
    expect(again).not.toBe(db);
    expect(readKnowledgeMeta("fts5")).toBe(knowledgeFts5Available() ? "on" : "off");
  });

  it("with FTS5 forced off, search still finds rows through LIKE and folds diacritics", () => {
    setKnowledgeFts5ForcedOff(true);
    expect(knowledgeFts5Available()).toBe(false);
    expect(readKnowledgeMeta("fts5")).toBe("off");
    const accented = `Reuni${String.fromCodePoint(0xe3)}o de or${String.fromCodePoint(0xe7)}amento amanh${String.fromCodePoint(0xe3)}`;
    saveMessage("dev-main", "user", accented, null, { agentId: "dev", channel: "whatsapp", chatId: "c1" });
    saveMessage("dev-main", "user", "unrelated text", null, { agentId: "dev", channel: "whatsapp", chatId: "c1" });
    indexLocalSources();
    const hits = searchLocal({ query: "orcamento reuniao", limit: 5 });
    expect(hits.map((hit) => hit.text)).toEqual([accented]);
    expect(hits[0]?.bm25).toBe(-2);
  });

  it("rebuilds the FTS tables when FTS5 comes back", () => {
    setKnowledgeFts5ForcedOff(true);
    saveMessage("dev-main", "user", "contrato assinado ontem", null, { channel: "whatsapp", chatId: "c1" });
    indexLocalSources();
    setKnowledgeFts5ForcedOff(false);
    if (!knowledgeFts5Available()) return; // this SQLite has no FTS5
    expect(searchLocal({ query: "contrato", limit: 5 }).map((hit) => hit.ref)).toHaveLength(1);
  });

  it("read-only open is null before the file exists and refuses writes after", () => {
    expect(openKnowledgeDbReadonly()).toBeNull();
    getKnowledgeDb();
    const readonly = openKnowledgeDbReadonly();
    expect(readonly).not.toBeNull();
    try {
      expect(() =>
        readonly?.prepare("INSERT INTO knowledge_meta (key, value, updated_at) VALUES ('x', 'y', 1)").run(),
      ).toThrow();
      expect(readonly?.prepare("SELECT value FROM knowledge_meta WHERE key = 'fts5'").get()).toBeTruthy();
    } finally {
      readonly?.close();
    }
  });
});
