import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  dbCreateAgent,
  dbCreateChatReadingList,
  dbCreateContext,
  dbDeleteChannel,
  dbDeleteInstance,
  dbGetAgent,
  dbGetChannel,
  dbGetChatReadingList,
  dbListChannels,
  dbListContexts,
  dbPruneContexts,
  dbUpdateAgent,
  dbUpdateChannel,
  dbUpsertChannel,
  dbUpsertInstance,
  closeRouterDb,
  getDb,
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

  it("creates trace indexes and shell trigger columns during schema bootstrap", () => {
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
