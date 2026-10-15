import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { enqueueTraceExportBatch } from "../session-trace/cloud-trace-export.js";
import { recordSessionEvent } from "../session-trace/session-trace-db.js";
import { saveMessage } from "../db.js";
import { getSyncCursor } from "../sync/db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  dbCreateAgent,
  dbCreateChatReadingList,
  contextKeyDigest,
  dbCreateContext,
  dbGetContext,
  dbGetContextByKey,
  dbGetContextByKeyReadOnly,
  dbUpdateContextRuntimeState,
  dbDeleteChannel,
  dbDeleteInstance,
  dbGetAgent,
  dbGetChannel,
  dbGetChatReadingList,
  dbListChannels,
  dbListContexts,
  dbPruneContexts,
  dbPruneStaleRows,
  dbUpdateAgent,
  dbUpdateChannel,
  dbUpsertChannel,
  dbUpsertChat,
  dbUpsertChatMessage,
  dbUpsertInstance,
  closeRouterDb,
  getDb,
  migrateContextKeysToDigest,
} from "./router-db.js";
import { getOrCreateSession } from "./sessions.js";
import { createRuntimeModelPreset } from "../runtime/model-preset-store.js";

let stateDir: string | null = null;

const DAY = 24 * 60 * 60 * 1000;

function createContext(input: {
  id: string;
  agentId?: string;
  sessionKey?: string;
  kind?: "agent-runtime" | "turn-runtime" | "child-task" | "tool-call";
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
}) {
  dbCreateContext({
    contextId: input.id,
    contextKey: `key-${input.id}`,
    kind: input.kind ?? "turn-runtime",
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    capabilities: [],
    createdAt: input.createdAt,
    ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
    ...(input.revokedAt != null ? { revokedAt: input.revokedAt } : {}),
  });
}

describe("router context queries", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-context-query-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("lists contexts with SQL-backed filters and excludes inactive contexts by default", () => {
    const now = Date.now();
    dbCreateAgent({ id: "agent-a", cwd: "/tmp/ravi-agent-a" });
    dbCreateAgent({ id: "agent-b", cwd: "/tmp/ravi-agent-b" });
    getOrCreateSession("agent:agent-a:main", "agent-a", "/tmp/ravi-agent-a", { name: "agent-a-main" });
    getOrCreateSession("agent:agent-b:main", "agent-b", "/tmp/ravi-agent-b", { name: "agent-b-main" });

    createContext({
      id: "matching-live",
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      kind: "turn-runtime",
      createdAt: now - 3 * DAY,
      expiresAt: now + DAY,
    });
    createContext({
      id: "matching-expired",
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      kind: "turn-runtime",
      createdAt: now - 2 * DAY,
      expiresAt: now - DAY,
    });
    createContext({
      id: "other-agent",
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
      kind: "turn-runtime",
      createdAt: now - DAY,
      expiresAt: now + DAY,
    });
    createContext({
      id: "other-kind",
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      kind: "child-task",
      createdAt: now,
      expiresAt: now + DAY,
    });

    expect(
      dbListContexts({
        agentId: "agent-a",
        sessionKey: "agent:agent-a:main",
        kind: "turn-runtime",
      }).map((context) => context.contextId),
    ).toEqual(["matching-live"]);

    expect(
      dbListContexts({
        agentId: "agent-a",
        sessionKey: "agent:agent-a:main",
        kind: "turn-runtime",
        includeInactive: true,
      }).map((context) => context.contextId),
    ).toEqual(["matching-expired", "matching-live"]);
  });

  it("prunes inactive contexts in the database while preserving active contexts", () => {
    const now = Date.now();
    createContext({ id: "active", createdAt: now - 30 * DAY, expiresAt: now + DAY });
    createContext({ id: "expired-old", createdAt: now - 30 * DAY, expiresAt: now - 10 * DAY });
    createContext({ id: "revoked-old", createdAt: now - 30 * DAY, revokedAt: now - 10 * DAY });
    createContext({ id: "expired-recent", createdAt: now - DAY, expiresAt: now - 1000 });

    expect(dbPruneContexts({ olderThanMs: 7 * DAY })).toEqual({ matched: 2, pruned: 0 });
    expect(dbPruneContexts({ apply: true, olderThanMs: 7 * DAY })).toEqual({ matched: 2, pruned: 2 });

    expect(
      dbListContexts({ includeInactive: true })
        .map((context) => context.contextId)
        .sort(),
    ).toEqual(["active", "expired-recent"]);
  });

  it("does not let a stale trace export cursor block the local retention TTL", async () => {
    recordSessionEvent({
      sessionKey: "agent:dev",
      eventType: "turn.complete",
      eventGroup: "runtime",
      timestamp: 1,
    });
    recordSessionEvent({
      sessionKey: "agent:dev",
      eventType: "turn.complete",
      eventGroup: "runtime",
      timestamp: 2,
    });
    enqueueTraceExportBatch({ limit: 1, now: 3 });

    expect(getSyncCursor("runtime_trace", "session_events_enqueued")?.cursorValue).toBe("1");
    expect((await dbPruneStaleRows({ dryRun: true, now: 10 * DAY })).sessionEvents).toBe(2);
  });

  it("keeps SQLite temp_store on DEFAULT so multi-GB databases do not scratch in RAM", () => {
    const db = getDb();
    const tempStore = db.query("PRAGMA temp_store").get() as { temp_store: number } | number | null;
    const value = typeof tempStore === "number" ? tempStore : tempStore?.temp_store;
    // 0 = DEFAULT, 1 = FILE, 2 = MEMORY. Product default must not be MEMORY.
    expect(value).toBe(0);
    expect(value).not.toBe(2);
  });

  it("creates trace indexes, shell trigger columns, and the reaction ledger during schema bootstrap", () => {
    const db = getDb();
    const sessionEventIndexes = new Set(
      (db.prepare("PRAGMA index_list(session_events)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const contextIndexes = new Set(
      (db.prepare("PRAGMA index_list(contexts)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const triggerColumns = new Set(
      (db.prepare("PRAGMA table_info(triggers)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const reactionColumns = new Set(
      (db.prepare("PRAGMA table_info(reaction_actions)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const reactionIndexes = new Set(
      (db.prepare("PRAGMA index_list(reaction_actions)").all() as Array<{ name: string }>).map((row) => row.name),
    );

    expect(sessionEventIndexes).toContain("idx_session_events_key_time_seq_id");
    expect(sessionEventIndexes).toContain("idx_session_events_visible_key_time_seq_id");
    expect(sessionEventIndexes).toContain("idx_session_events_key_type_id");
    expect(sessionEventIndexes).toContain("idx_session_events_rollup_turns_cover");
    expect(contextIndexes).toContain("idx_contexts_kind_created");
    expect(triggerColumns).toContain("execution_type");
    expect(triggerColumns).toContain("shell_command");
    expect(triggerColumns).toContain("shell_timeout_ms");
    expect(triggerColumns).toContain("shell_env_file");
    expect(triggerColumns).toContain("on_error");
    expect(triggerColumns).toContain("filter_reject_count");
    expect(triggerColumns).toContain("last_filter_reject_at");
    expect(reactionColumns).toEqual(
      new Set([
        "idempotency_key_hash",
        "key_source",
        "action_type",
        "action_fingerprint",
        "rule_id",
        "source_turn_ids_json",
        "target_type",
        "target_id",
        "created_at",
        "completed_at",
      ]),
    );
    expect(reactionIndexes).toContain("idx_reaction_actions_source");
  });

  it("adds the cron owner column to legacy cron tables and keeps old rows as operator (NULL)", () => {
    const db = getDb();
    db.exec("ALTER TABLE cron_jobs DROP COLUMN owner_principal");
    db.prepare(
      `INSERT INTO cron_jobs (id, name, schedule_type, schedule_every, payload_text, created_at, updated_at)
       VALUES ('legacy-cron', 'legacy', 'every', 60000, 'noop', 1, 1)`,
    ).run();

    closeRouterDb();
    const reopened = getDb();

    const cronColumns = new Set(
      (reopened.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    expect(cronColumns).toContain("owner_principal");
    const legacy = reopened.prepare("SELECT owner_principal FROM cron_jobs WHERE id = 'legacy-cron'").get() as {
      owner_principal: string | null;
    };
    expect(legacy.owner_principal).toBeNull();
  });

  it("scopes Console inbox item idempotency by Console and organization", () => {
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO console_inbox_items (
         console_url,
         organization_id,
         subscription_id,
         item_id,
         sequence,
         event_type,
         category,
         severity,
         dedupe_key,
         nats_subject,
         nats_payload_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, 'shared-item', 1, 'task.created', 'task', 'info', ?, 'ravi.console.inbox.item', '{}', 1, 1)`,
    );
    const insertScope = (consoleUrl: string, organizationId: string) =>
      insert.run(
        consoleUrl,
        organizationId,
        `subscription:${consoleUrl}:${organizationId}`,
        `dedupe:${consoleUrl}:${organizationId}`,
      );

    insertScope("https://console-a.ravi.bot", "org-a");
    insertScope("https://console-a.ravi.bot", "org-b");
    insertScope("https://console-b.ravi.bot", "org-a");

    expect(() => insertScope("https://console-a.ravi.bot", "org-a")).toThrow(/UNIQUE constraint failed/);
    expect(
      db
        .prepare(
          `SELECT console_url AS consoleUrl, organization_id AS organizationId, item_id AS itemId
           FROM console_inbox_items
           ORDER BY console_url, organization_id`,
        )
        .all(),
    ).toEqual([
      { consoleUrl: "https://console-a.ravi.bot", organizationId: "org-a", itemId: "shared-item" },
      { consoleUrl: "https://console-a.ravi.bot", organizationId: "org-b", itemId: "shared-item" },
      { consoleUrl: "https://console-b.ravi.bot", organizationId: "org-a", itemId: "shared-item" },
    ]);
  });

  it("gets reading lists by exact primary-key id without falling back to name", () => {
    const missingId = "crl_0123456789abcdef01234567";
    const list = dbCreateChatReadingList({
      name: missingId,
      ownerType: "system",
      ownerId: "billing",
      visibility: "private",
      mode: "dynamic",
      selector: { chatIds: ["chat-safe"] },
    });

    expect(dbGetChatReadingList({ id: missingId })).toBeNull();
    expect(dbGetChatReadingList({ id: list.id })?.id).toBe(list.id);
    expect(dbGetChatReadingList({ id: list.id, ownerType: "system", ownerId: "other" })).toBeNull();
  });

  it("preserves retired permission tables while another process may still use them", () => {
    const legacyDb = new Database(join(stateDir!, "ravi.db"));
    legacyDb.exec(`
      CREATE TABLE relations (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);
      CREATE TABLE permission_policy_rules (id TEXT PRIMARY KEY, marker TEXT NOT NULL);
      CREATE TABLE permission_policy_materializations (id TEXT PRIMARY KEY, marker TEXT NOT NULL);
      INSERT INTO relations (id, marker) VALUES (1, 'relation');
      INSERT INTO permission_policy_rules (id, marker) VALUES ('rule-1', 'rule');
      INSERT INTO permission_policy_materializations (id, marker) VALUES ('materialization-1', 'materialization');
    `);
    legacyDb.close();

    const db = getDb();
    const tables = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('relations', 'permission_policy_rules', 'permission_policy_materializations')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual([
      "permission_policy_materializations",
      "permission_policy_rules",
      "relations",
    ]);
    expect(db.prepare("SELECT marker FROM relations WHERE id = 1").get()).toEqual({ marker: "relation" });
    expect(db.prepare("SELECT marker FROM permission_policy_rules WHERE id = 'rule-1'").get()).toEqual({
      marker: "rule",
    });
    expect(
      db.prepare("SELECT marker FROM permission_policy_materializations WHERE id = 'materialization-1'").get(),
    ).toEqual({ marker: "materialization" });
  });

  it("persists native Slack instanceId and canonicalChatId on context source", () => {
    dbCreateAgent({ id: "agent-a", cwd: "/tmp/ravi-agent-a" });
    getOrCreateSession("agent:agent-a:slack:hana-slack:C123", "agent-a", "/tmp/ravi-agent-a", {
      name: "hana-slack",
    });

    const created = dbCreateContext({
      contextId: "ctx_native_slack",
      contextKey: "key-ctx_native_slack",
      kind: "turn-runtime",
      agentId: "agent-a",
      sessionKey: "agent:agent-a:slack:hana-slack:C123",
      sessionName: "hana-slack",
      source: {
        channel: "slack",
        accountId: "hana-slack",
        chatId: "C123",
        instanceId: "hana-slack",
        canonicalChatId: "chat_slack_C123",
      },
      capabilities: [],
    });

    expect(created.source).toEqual({
      channel: "slack",
      accountId: "hana-slack",
      chatId: "C123",
      instanceId: "hana-slack",
      canonicalChatId: "chat_slack_C123",
    });
    expect(dbGetContext("ctx_native_slack")?.source).toEqual(created.source);

    const updated = dbUpdateContextRuntimeState("ctx_native_slack", {
      sessionName: "hana-slack",
      source: {
        channel: "slack",
        accountId: "hana-slack-secret",
        chatId: "C123",
        instanceId: "hana-slack",
        canonicalChatId: "chat_slack_C123",
      },
    });
    expect(updated.source).toMatchObject({
      instanceId: "hana-slack",
      canonicalChatId: "chat_slack_C123",
      accountId: "hana-slack-secret",
    });
  });

  it("persists native channel credential connection references through router schema bootstrap", () => {
    const db = getDb();
    const channelColumns = new Set(
      (db.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    expect(channelColumns).toContain("provider");
    expect(channelColumns).toContain("credential_connection");

    const created = dbUpsertChannel({
      name: "ravi-rbbt-slack",
      provider: "slack",
      credentialConnection: "rbbt-secret",
    });
    expect(created.credentialConnection).toBe("rbbt-secret");

    const preserved = dbUpdateChannel("ravi-rbbt-slack", { enabled: false });
    expect(preserved.enabled).toBe(false);
    expect(preserved.credentialConnection).toBe("rbbt-secret");

    const cleared = dbUpdateChannel("ravi-rbbt-slack", { credentialConnection: null });
    expect(cleared.credentialConnection).toBeUndefined();
    expect(dbGetChannel("ravi-rbbt-slack")?.provider).toBe("slack");
  });

  it("backfills legacy Slack instances into channel configs without overwriting explicit channels", () => {
    dbUpsertInstance({ name: "legacy-slack", channel: "slack" });
    dbUpsertInstance({
      name: "legacy-slack-disabled",
      channel: "slack",
      enabled: false,
      defaults: { credentials: { slackConnection: "legacy-slack-secret" } },
    });
    dbUpsertInstance({ name: "legacy-whatsapp", channel: "whatsapp" });
    dbUpsertInstance({ name: "legacy-slack-deleted", channel: "slack" });
    dbDeleteInstance("legacy-slack-deleted");
    dbUpsertInstance({ name: "deleted-channel-slack", channel: "slack" });
    dbUpsertChannel({
      name: "deleted-channel-slack",
      provider: "slack",
      credentialConnection: "deleted-channel-secret",
    });
    dbDeleteChannel("deleted-channel-slack");

    dbUpsertInstance({
      name: "configured-slack",
      channel: "slack",
      defaults: { slackCredentialConnection: "legacy-connection" },
    });
    const configured = dbUpsertChannel({
      name: "configured-slack",
      provider: "slack",
      enabled: false,
      credentialConnection: "explicit-connection",
      defaults: { subscriptionScope: "chat_and_thread" },
    });

    closeRouterDb();
    getDb();

    expect(dbGetChannel("legacy-slack")).toMatchObject({
      name: "legacy-slack",
      provider: "slack",
      enabled: true,
      credentialConnection: "legacy-slack",
    });
    expect(dbGetChannel("legacy-slack")?.defaults).toBeUndefined();
    expect(dbGetChannel("legacy-slack-disabled")).toMatchObject({
      name: "legacy-slack-disabled",
      provider: "slack",
      enabled: false,
      credentialConnection: "legacy-slack-secret",
    });
    expect(dbGetChannel("legacy-whatsapp")).toBeNull();
    expect(dbGetChannel("legacy-slack-deleted")).toBeNull();
    expect(dbGetChannel("deleted-channel-slack")).toBeNull();
    expect(dbGetChannel("configured-slack")).toEqual(configured);

    const firstPass = dbListChannels();
    closeRouterDb();
    getDb();
    expect(dbListChannels()).toEqual(firstPass);
  });
});

function insertLegacyPlaintextContext(contextId: string, contextKey: string): void {
  getDb()
    .prepare(
      "INSERT INTO contexts (context_id, context_key, kind, capabilities_json, created_at) VALUES (?, ?, 'turn-runtime', '[]', ?)",
    )
    .run(contextId, contextKey, Date.now());
}

function storedContextKey(contextId: string): string | undefined {
  return (
    getDb().prepare("SELECT context_key FROM contexts WHERE context_id = ?").get(contextId) as
      | { context_key: string }
      | undefined
  )?.context_key;
}

describe("context keys at rest", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-context-key-digest-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("stores only the digest and hands the plaintext key back once, at creation", () => {
    const key = "rctx_digest_at_rest_example";
    const created = dbCreateContext({ contextId: "ctx_digest", contextKey: key, capabilities: [] });

    expect(created.contextKey).toBe(key);
    const raw = getDb().prepare("SELECT context_key FROM contexts").all() as Array<{ context_key: string }>;
    expect(raw).toHaveLength(1);
    expect(raw.some((row) => row.context_key.includes("rctx_"))).toBe(false);
    expect(raw[0]?.context_key).toBe(contextKeyDigest(key));
    expect(raw[0]?.context_key.startsWith("kh1:")).toBe(true);

    // Reads that are not a lookup by key never return the plaintext.
    expect(dbGetContext("ctx_digest")?.contextKey).toBe(contextKeyDigest(key));
    expect(dbListContexts({ includeInactive: true }).map((ctx) => ctx.contextKey)).toEqual([contextKeyDigest(key)]);
  });

  it("finds a context by its plaintext key and never by its stored digest", () => {
    const key = "rctx_lookup_example";
    dbCreateContext({ contextId: "ctx_lookup", contextKey: key, capabilities: [] });
    const digest = storedContextKey("ctx_lookup")!;

    expect(dbGetContextByKey(key)).toMatchObject({ contextId: "ctx_lookup", contextKey: key });
    expect(dbGetContextByKeyReadOnly(key)).toMatchObject({ contextId: "ctx_lookup", contextKey: key });
    expect(dbGetContextByKey(digest)).toBeNull();
    expect(dbGetContextByKeyReadOnly(digest)).toBeNull();
  });

  it("refuses a key that uses the digest prefix or collides with a legacy plaintext row", () => {
    expect(() => dbCreateContext({ contextId: "ctx_prefixed", contextKey: "kh1:abc", capabilities: [] })).toThrow(
      "reserved kh1: digest prefix",
    );

    insertLegacyPlaintextContext("ctx_legacy_dup", "rctx_legacy_dup");
    expect(() =>
      dbCreateContext({ contextId: "ctx_new_dup", contextKey: "rctx_legacy_dup", capabilities: [] }),
    ).toThrow("Context already exists");
  });

  it("serves legacy plaintext rows before migration (mixed versions) and after it", () => {
    insertLegacyPlaintextContext("ctx_legacy", "rctx_legacy_key");
    // Opening the DB alone never migrates: only daemon boot does.
    closeRouterDb();
    getDb();
    expect(storedContextKey("ctx_legacy")).toBe("rctx_legacy_key");

    expect(dbGetContextByKey("rctx_legacy_key")).toMatchObject({
      contextId: "ctx_legacy",
      contextKey: "rctx_legacy_key",
    });
    expect(dbGetContextByKeyReadOnly("rctx_legacy_key")?.contextId).toBe("ctx_legacy");

    expect(migrateContextKeysToDigest()).toEqual({ migrated: 1, skipped: 0, skippedContextIds: [] });

    expect(storedContextKey("ctx_legacy")).toBe(contextKeyDigest("rctx_legacy_key"));
    expect(dbGetContextByKey("rctx_legacy_key")).toMatchObject({
      contextId: "ctx_legacy",
      contextKey: "rctx_legacy_key",
    });
    expect(dbGetContextByKeyReadOnly("rctx_legacy_key")?.contextId).toBe("ctx_legacy");
    expect(dbGetContextByKey(contextKeyDigest("rctx_legacy_key"))).toBeNull();
  });

  it("migrates every plaintext row across batches and is idempotent", () => {
    dbCreateContext({ contextId: "ctx_already_digest", contextKey: "rctx_already_digest", capabilities: [] });
    const total = 1_234;
    const db = getDb();
    db.exec("BEGIN");
    for (let i = 0; i < total; i++) insertLegacyPlaintextContext(`ctx_legacy_${i}`, `rctx_legacy_${i}`);
    db.exec("COMMIT");

    expect(migrateContextKeysToDigest()).toEqual({ migrated: total, skipped: 0, skippedContextIds: [] });
    const plaintext = db.prepare("SELECT COUNT(*) AS n FROM contexts WHERE context_key NOT LIKE 'kh1:%'").get() as {
      n: number;
    };
    expect(plaintext.n).toBe(0);
    expect(dbGetContextByKey("rctx_legacy_1233")?.contextId).toBe("ctx_legacy_1233");
    expect(dbGetContextByKey("rctx_already_digest")?.contextId).toBe("ctx_already_digest");

    expect(migrateContextKeysToDigest()).toEqual({ migrated: 0, skipped: 0, skippedContextIds: [] });
  });

  it("leaves a plaintext row in place when its digest is already taken, and reports its id", () => {
    dbCreateContext({ contextId: "ctx_hashed", contextKey: "rctx_shared", capabilities: [] });
    // Only reachable by hand-editing the DB: dbCreateContext refuses this pair.
    insertLegacyPlaintextContext("ctx_plain_twin", "rctx_shared");
    insertLegacyPlaintextContext("ctx_plain_other", "rctx_other");

    const result = migrateContextKeysToDigest();
    expect(result).toEqual({ migrated: 1, skipped: 1, skippedContextIds: ["ctx_plain_twin"] });
    expect(JSON.stringify(result)).not.toContain("rctx_");
    expect(storedContextKey("ctx_plain_twin")).toBe("rctx_shared");
    expect(storedContextKey("ctx_plain_other")).toBe(contextKeyDigest("rctx_other"));
  });

  it.each([
    ["plaintext twin inserted after the digest row", false],
    ["plaintext twin inserted before the digest row", true],
  ])("resolves the digest row over a legacy plaintext twin (%s)", (_label, plaintextFirst) => {
    // Raw inserts: dbCreateContext refuses a twin, so this pair is only reachable by hand-editing the DB.
    const insertDigestRow = () => insertLegacyPlaintextContext("ctx_hashed", contextKeyDigest("rctx_twin"));
    if (plaintextFirst) insertLegacyPlaintextContext("ctx_plain_twin", "rctx_twin");
    insertDigestRow();
    if (!plaintextFirst) insertLegacyPlaintextContext("ctx_plain_twin", "rctx_twin");

    expect(getDb().prepare("SELECT COUNT(*) AS n FROM contexts").get()).toEqual({ n: 2 });
    expect(dbGetContextByKey("rctx_twin")?.contextId).toBe("ctx_hashed");
    expect(dbGetContextByKeyReadOnly("rctx_twin")?.contextId).toBe("ctx_hashed");

    // The plaintext row is only consulted when no digest matches.
    getDb().prepare("DELETE FROM contexts WHERE context_id = 'ctx_hashed'").run();
    expect(dbGetContextByKey("rctx_twin")?.contextId).toBe("ctx_plain_twin");
    expect(dbGetContextByKeyReadOnly("rctx_twin")?.contextId).toBe("ctx_plain_twin");
  });

  it("keeps a revoked digest row ahead of a live legacy plaintext twin", () => {
    // Falling through to the twin would let a hand-inserted plaintext row bypass revocation.
    insertLegacyPlaintextContext("ctx_hashed", contextKeyDigest("rctx_twin"));
    insertLegacyPlaintextContext("ctx_plain_twin", "rctx_twin");
    getDb().prepare("UPDATE contexts SET revoked_at = ? WHERE context_id = 'ctx_hashed'").run(Date.now());

    for (const lookup of [dbGetContextByKey, dbGetContextByKeyReadOnly]) {
      const record = lookup("rctx_twin");
      expect(record?.contextId).toBe("ctx_hashed");
      expect(record?.revokedAt).toBeDefined();
    }
  });
});

describe("agent model preset persistence", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-agent-preset-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("round-trips model_preset_id and keeps direct model and preset mutually exclusive", () => {
    createRuntimeModelPreset({ id: "fast-sonnet", provider: "anthropic", model: "sonnet" });

    const withPreset = dbCreateAgent({ id: "dev", cwd: "/tmp/ravi-dev", modelPresetId: "fast-sonnet" });
    expect(withPreset.modelPresetId).toBe("fast-sonnet");
    expect(withPreset.model).toBeUndefined();
    expect(dbGetAgent("dev")?.modelPresetId).toBe("fast-sonnet");

    // Writing a direct model clears the preset in the same update.
    const direct = dbUpdateAgent("dev", { model: "opus", modelPresetId: null });
    expect(direct.model).toBe("opus");
    expect(direct.modelPresetId).toBeUndefined();
    const afterDirect = dbGetAgent("dev");
    expect(afterDirect?.model).toBe("opus");
    expect(afterDirect?.modelPresetId).toBeUndefined();

    // Assigning a preset clears the direct model in the same update.
    const rePreset = dbUpdateAgent("dev", { modelPresetId: "fast-sonnet", model: null });
    expect(rePreset.modelPresetId).toBe("fast-sonnet");
    expect(rePreset.model).toBeUndefined();
    const afterPreset = dbGetAgent("dev");
    expect(afterPreset?.modelPresetId).toBe("fast-sonnet");
    expect(afterPreset?.model).toBeUndefined();
  });
});

describe("canonical message receipts", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-message-receipt-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("returns stable canonical identity and the latest supplied provider timestamp", () => {
    const chat = dbUpsertChat({
      channel: "slack",
      instanceId: "slack-main",
      platformChatId: "C123",
      chatType: "group",
    });
    const input = {
      chatId: chat.id,
      channel: "slack",
      instanceId: "slack-main",
      providerMessageId: "1713000000.000100",
      rawChatId: "C123",
      actorType: "agent",
      agentId: "main",
      messageType: "text",
      content: { type: "text", text: "hello" },
      providerTimestamp: 1_713_000_000_000,
    } as const;

    const first = dbUpsertChatMessage(input);
    const repeated = dbUpsertChatMessage({ ...input, providerTimestamp: 1_713_000_000_999 });

    expect(first).toMatchObject({
      created: true,
      canonicalMessageId: first.message.id,
      providerMessageId: "1713000000.000100",
      providerTimestamp: 1_713_000_000_000,
    });
    expect(repeated).toMatchObject({
      created: false,
      canonicalMessageId: first.message.id,
      providerMessageId: "1713000000.000100",
      providerTimestamp: 1_713_000_000_999,
    });
  });
});

describe("ravi.db file permissions", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-db-mode-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const posixOnly = process.platform === "win32" ? it.skip : it;
  const modeOf = (path: string) => statSync(path).mode & 0o777;

  posixOnly("ravi.db and its WAL files are 0600 after getDb", () => {
    getDb();
    const dbPath = join(stateDir!, "ravi.db");
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(path)) expect(modeOf(path)).toBe(0o600);
    }
    expect(modeOf(dbPath)).toBe(0o600);
  });

  posixOnly("chat.db (message contents) is created 0600", () => {
    saveMessage("agent:main:main", "user", "hello");
    expect(modeOf(join(stateDir!, "chat.db"))).toBe(0o600);
  });

  posixOnly("an existing 0644 ravi.db is tightened when it is reopened", () => {
    getDb();
    closeRouterDb();
    const dbPath = join(stateDir!, "ravi.db");
    chmodSync(dbPath, 0o644);

    getDb();

    expect(modeOf(dbPath)).toBe(0o600);
  });
});
