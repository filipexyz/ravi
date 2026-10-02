/**
 * router-db §7.1: `channel_group_metadata` is created on every DB, and the legacy
 * `omni_group_metadata` rows are copied into it exactly once. The old table is kept.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { closeRouterDb, copyLegacyGroupMetadataOnce, getDb } from "./router-db.js";

const COPY_KEY = "channel_group_metadata_copy_v1";
const GROUP = "120363424772797713@g.us";

let stateDir: string | null = null;

const LEGACY_DDL = `
  CREATE TABLE omni_group_metadata (
    account_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    chat_uuid TEXT,
    external_id TEXT,
    channel TEXT,
    name TEXT,
    description TEXT,
    avatar_url TEXT,
    participant_count INTEGER,
    participants_json TEXT,
    settings_json TEXT,
    platform_metadata_json TEXT,
    fetched_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, instance_id, chat_id)
  );
`;

function insertLegacyRow(db: Database, chatId: string, name: string): void {
  db.prepare(
    `INSERT INTO omni_group_metadata (
       account_id, instance_id, chat_id, chat_uuid, external_id, channel, name, description, avatar_url,
       participant_count, participants_json, settings_json, platform_metadata_json, fetched_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "main",
    "instance-1",
    chatId,
    "chat-uuid",
    chatId,
    "whatsapp-baileys",
    name,
    "desc",
    null,
    1,
    JSON.stringify([{ id: "p-1", platformUserId: "5511947879044", displayName: "Luis", role: "admin" }]),
    JSON.stringify({ disappearing: "off" }),
    JSON.stringify({ source: "legacy" }),
    1_700_000_000_000,
    1_700_000_000_001,
    1_700_000_000_002,
  );
}

/** A pre-existing DB file holding only the legacy cache table. */
function seedLegacyDb(rows: Array<[string, string]>): void {
  const db = new Database(join(stateDir as string, "ravi.db"));
  db.exec(LEGACY_DDL);
  for (const [chatId, name] of rows) insertLegacyRow(db, chatId, name);
  db.close();
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function copyMarker(db: Database): string | undefined {
  return (db.prepare("SELECT value FROM router_meta WHERE key = ?").get(COPY_KEY) as { value: string } | undefined)
    ?.value;
}

describe("router-db channel_group_metadata migration", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-group-metadata-");
    closeRouterDb();
  });

  afterEach(async () => {
    closeRouterDb();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("copies the legacy rows once and keeps the old table readable", () => {
    seedLegacyDb([
      [GROUP, "ravi - dev"],
      ["120363400000000009@g.us", "outro"],
    ]);

    const db = getDb();
    expect(copyMarker(db)).toBe("done");
    const copied = db.prepare("SELECT * FROM channel_group_metadata ORDER BY chat_id").all() as Array<
      Record<string, unknown>
    >;
    expect(copied).toHaveLength(2);
    expect(copied.find((row) => row.chat_id === GROUP)).toEqual({
      account_id: "main",
      instance_id: "instance-1",
      chat_id: GROUP,
      chat_uuid: "chat-uuid",
      external_id: GROUP,
      channel: "whatsapp-baileys",
      name: "ravi - dev",
      description: "desc",
      avatar_url: null,
      participant_count: 1,
      participants_json: JSON.stringify([
        { id: "p-1", platformUserId: "5511947879044", displayName: "Luis", role: "admin" },
      ]),
      settings_json: JSON.stringify({ disappearing: "off" }),
      platform_metadata_json: JSON.stringify({ source: "legacy" }),
      fetched_at: 1_700_000_000_000,
      created_at: 1_700_000_000_001,
      updated_at: 1_700_000_000_002,
    });

    // The old table is untouched and still readable.
    expect(tableExists(db, "omni_group_metadata")).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM omni_group_metadata").get() as { n: number }).n).toBe(2);

    // The one-time chat-model backfill reads the new table.
    const chat = db.prepare("SELECT id, raw_provenance_json FROM chats WHERE platform_chat_id = ?").get(GROUP) as
      | { id: string; raw_provenance_json: string }
      | undefined;
    expect(JSON.parse(chat?.raw_provenance_json ?? "{}")).toMatchObject({ sourceTable: "channel_group_metadata" });
    const participant = db
      .prepare("SELECT source, metadata_json FROM chat_participants WHERE chat_id = ?")
      .get(chat?.id ?? "") as { source: string; metadata_json: string } | undefined;
    expect(participant?.source).toBe("group_metadata");
    expect(JSON.parse(participant?.metadata_json ?? "{}")).toEqual({
      providerParticipantId: "p-1",
      displayName: "Luis",
    });
  });

  it("does not copy again once marked done", () => {
    seedLegacyDb([[GROUP, "ravi - dev"]]);
    getDb();
    closeRouterDb();

    // A pre-r3 daemon keeps writing the old table after the copy.
    const legacy = new Database(join(stateDir as string, "ravi.db"));
    insertLegacyRow(legacy, "120363400000000010@g.us", "escrito depois");
    legacy.close();

    const db = getDb();
    const count = db.prepare("SELECT COUNT(*) AS n FROM channel_group_metadata").get() as { n: number };
    expect(count.n).toBe(1);

    copyLegacyGroupMetadataOnce(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM channel_group_metadata").get() as { n: number }).n).toBe(1);
  });

  it("marks a DB without the legacy table done and never creates it", () => {
    const db = getDb();
    expect(copyMarker(db)).toBe("done");
    expect(tableExists(db, "channel_group_metadata")).toBe(true);
    expect(tableExists(db, "omni_group_metadata")).toBe(false);
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_channel_group_metadata_fetched'")
        .get(),
    ).toBeTruthy();
  });
});
