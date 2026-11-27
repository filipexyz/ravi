import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  type ContextRecord,
  dbCreateAgent,
  dbCreateContext,
  dbGetContext,
  dbGetOpenThreadHumanRequestTurns,
  ensureCronOwnerExplicitMigration,
  CRON_OWNER_EXPLICIT_MIGRATION_KEY,
  dbListContexts,
  dbRenewActiveContext,
  dbRevokeContextCascade,
  dbUpdateContextMetadata,
  closeRouterDb,
  getDb,
} from "./router-db.js";
import { resolveRuntimeContext } from "../runtime/context-registry.js";
import { getOrCreateSession } from "./sessions.js";
import { closeSlackThreadLifecycle, registerInboundSlackThread } from "../channels/slack/thread-lifecycle-store.js";

const AGENT_ID = "context-storage-test";
const SESSION_KEY = `agent:${AGENT_ID}:test`;
const REVOKED_AT = 4_000;
let stateDir: string | null = null;

/** The key each fixture was issued with; the registry keeps only its hash. */
function keyOf(context: ContextRecord): string {
  return `test-key-${context.contextId}`;
}

/** Created context in its stored form: what every read returns (no key, only the hash is kept). */
function createContext(id: string, overrides: Partial<ContextRecord> = {}): ContextRecord {
  const issued = createIssuedContext(id, overrides);
  expect(issued.contextKey).toBe(`test-key-${id}`);
  return { ...issued, contextKey: "" };
}

function createIssuedContext(id: string, overrides: Partial<ContextRecord> = {}): ContextRecord {
  return dbCreateContext({
    contextId: id,
    contextKey: `test-key-${id}`,
    kind: "turn-runtime",
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    sessionName: "context-storage-session",
    source: {
      channel: "slack",
      accountId: "test-account",
      chatId: "test-chat",
      threadId: "test-thread",
      instanceId: "test-instance",
      canonicalChatId: "test-canonical-chat",
    },
    capabilities: [{ permission: "read", objectType: "session", objectId: "test", source: "test-profile" }],
    metadata: { actor: { contactId: "test-contact" }, origin: "test-issuance" },
    createdAt: 1_000,
    lastUsedAt: 2_000,
    expiresAt: 9_000,
    ...overrides,
  });
}

function createFamily() {
  const root = createContext("root");
  const child = createContext("child", { metadata: { parentContextId: root.contextId, origin: "child-issuance" } });
  const grandchild = createContext("grandchild", {
    metadata: { parentContextId: child.contextId, cascadedFrom: ["earlier-root"], origin: "grandchild-issuance" },
  });
  const unrelated = createContext("unrelated");
  return { root, child, grandchild, unrelated };
}

describe("context metadata and transactional revocation persistence", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-contexts-");
    dbCreateAgent({ id: AGENT_ID, cwd: "/tmp/context-storage-test" });
    getOrCreateSession(SESSION_KEY, AGENT_ID, "/tmp/context-storage-test", { name: "context-storage-session" });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("lists active contexts at exact expiry and revocation boundaries without changing their records", () => {
    const now = 1_000_000;
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      const timestamps = [undefined, 0, now - 1, now, now + 1];
      const records: ContextRecord[] = [];
      for (const expiresAt of timestamps) {
        for (const revokedAt of timestamps) {
          records.push(
            createContext(`boundary-${records.length}`, {
              createdAt: 1_000 + records.length,
              expiresAt,
              revokedAt,
            }),
          );
        }
      }
      const active = records.filter(
        (record) => (!record.expiresAt || record.expiresAt > now) && (!record.revokedAt || record.revokedAt > now),
      );

      expect(dbListContexts()).toEqual([...active].reverse());
      expect(active).toHaveLength(9);
      expect(dbListContexts({ includeInactive: true })).toEqual([...records].reverse());
      for (const record of records) expect(dbGetContext(record.contextId)).toEqual(record);
    } finally {
      clock.mockRestore();
    }
  });

  it("stops listing authority immediately after revocation while retaining its audit record", () => {
    const original = createContext("revoke-after-list", { expiresAt: Date.now() + 60_000 });
    expect(dbListContexts()).toEqual([original]);

    const revoked = dbRevokeContextCascade(original.contextId, { reason: "operator_revoked" }).context;

    expect(dbListContexts()).toEqual([]);
    expect(dbListContexts({ includeInactive: true })).toEqual([revoked]);
    expect(dbGetContext(original.contextId)).toEqual(revoked);
  });

  it("preserves agent, session and kind filters for both active and historical context inspection", () => {
    const now = 1_000_000;
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      const otherAgent = "other-context-agent";
      const otherSession = `agent:${otherAgent}:test`;
      dbCreateAgent({ id: otherAgent, cwd: "/tmp/context-storage-test" });
      getOrCreateSession(otherSession, otherAgent, "/tmp/context-storage-test", { name: "other-context-session" });
      const records: ContextRecord[] = [];
      for (const agentId of [AGENT_ID, otherAgent]) {
        for (const sessionKey of [SESSION_KEY, otherSession]) {
          for (const kind of ["turn-runtime", "cli-runtime"]) {
            for (const expiresAt of [now - 1, now + 1]) {
              records.push(
                createContext(`filtered-${records.length}`, {
                  agentId,
                  sessionKey,
                  kind,
                  expiresAt,
                  createdAt: 1_000 + records.length,
                }),
              );
            }
          }
        }
      }
      for (const agentId of [undefined, AGENT_ID, "missing-agent"]) {
        for (const sessionKey of [undefined, SESSION_KEY, "missing-session"]) {
          for (const kind of [undefined, "turn-runtime", "missing-kind"]) {
            for (const includeInactive of [false, true]) {
              const expected = records.filter(
                (record) =>
                  (!agentId || record.agentId === agentId) &&
                  (!sessionKey || record.sessionKey === sessionKey) &&
                  (!kind || record.kind === kind) &&
                  (includeInactive || (record.expiresAt ?? 0) > now),
              );
              expect(dbListContexts({ agentId, sessionKey, kind, includeInactive })).toEqual([...expected].reverse());
            }
          }
        }
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("marks historical authority withdrawn without changing provenance, capabilities or lifecycle timestamps", () => {
    const original = createContext("historical", { revokedAt: 3_000 });
    const metadata = { ...original.metadata, permissionProfileRevokedAt: REVOKED_AT };
    const unrelated = createContext("unrelated");

    dbUpdateContextMetadata(original.contextId, metadata);

    expect(dbGetContext(original.contextId)).toEqual({ ...original, metadata });
    expect(dbGetContext(unrelated.contextId)).toEqual(unrelated);
  });

  it("rejects malformed metadata and missing contexts without changing stored records", () => {
    const original = createContext("existing");

    expect(() => dbUpdateContextMetadata(original.contextId, [] as unknown as Record<string, unknown>)).toThrow();
    expect(() => dbUpdateContextMetadata("missing", { permissionProfileRevokedAt: REVOKED_AT })).toThrow(
      "Context not found: missing",
    );

    expect(dbGetContext(original.contextId)).toEqual(original);
    expect(dbGetContext("missing")).toBeNull();
  });

  it("commits metadata and descendant revocations in the caller's transaction while retaining lineage", () => {
    const { root, child, grandchild, unrelated } = createFamily();
    const metadata = { ...root.metadata, permissionProfileRevokedAt: REVOKED_AT };
    const result = getDb().transaction(() => {
      dbUpdateContextMetadata(root.contextId, metadata);
      return dbRevokeContextCascade(root.contextId, { revokedAt: REVOKED_AT, reason: "permission_profile_reduced" });
    })();

    expect(result.context).toEqual({
      ...root,
      revokedAt: REVOKED_AT,
      metadata: { ...metadata, revocationReason: "permission_profile_reduced" },
    });
    expect(dbGetContext(root.contextId)).toEqual(result.context);
    expect(result.cascaded.map((context) => context.contextId).sort()).toEqual(["child", "grandchild"]);
    for (const original of [child, grandchild]) {
      expect(dbGetContext(original.contextId)).toEqual({
        ...original,
        revokedAt: REVOKED_AT,
        metadata: {
          ...original.metadata,
          revocationReason: "permission_profile_reduced",
          revokedViaCascade: true,
          cascadeRootContextId: root.contextId,
          cascadedFrom: [...((original.metadata?.cascadedFrom as string[] | undefined) ?? []), root.contextId],
        },
      });
    }
    expect(dbGetContext(unrelated.contextId)).toEqual(unrelated);
    expect(getDb().inTransaction).toBe(false);
  });

  it("rolls back metadata and the entire cascade when the surrounding write fails", () => {
    const family = createFamily();
    const failAfterRevocation = new Error("surrounding profile write failed");

    expect(() =>
      getDb().transaction(() => {
        dbUpdateContextMetadata(family.root.contextId, {
          ...family.root.metadata,
          permissionProfileRevokedAt: REVOKED_AT,
        });
        dbRevokeContextCascade(family.root.contextId, { revokedAt: REVOKED_AT, reason: "permission_profile_reduced" });
        expect(dbGetContext(family.grandchild.contextId)?.revokedAt).toBe(REVOKED_AT);
        throw failAfterRevocation;
      })(),
    ).toThrow(failAfterRevocation);

    for (const original of Object.values(family)) {
      expect(dbGetContext(original.contextId)).toEqual(original);
    }
    expect(getDb().inTransaction).toBe(false);
  });

  it("still revokes descendants when no caller transaction exists", () => {
    const { root, child, grandchild, unrelated } = createFamily();

    dbRevokeContextCascade(root.contextId, { revokedAt: REVOKED_AT, reason: "standalone_revoke" });

    for (const original of [root, child, grandchild]) {
      expect(dbGetContext(original.contextId)?.revokedAt).toBe(REVOKED_AT);
      expect(dbGetContext(original.contextId)?.metadata?.revocationReason).toBe("standalone_revoke");
    }
    expect(dbGetContext(unrelated.contextId)).toEqual(unrelated);
    expect(getDb().inTransaction).toBe(false);
  });

  it.each(["operator_revoked", undefined])("ordinary cleanup cannot undo withdrawal (%s)", (reason) => {
    const { root, child } = createFamily();
    dbRevokeContextCascade(root.contextId, { revokedAt: 3_000, reason: "turn_context_completed", cascade: false });
    dbRevokeContextCascade(root.contextId, { revokedAt: 4_000, reason });
    dbRevokeContextCascade(root.contextId, { revokedAt: 5_000, reason: "turn_context_completed" });
    for (const id of [root.contextId, child.contextId]) {
      expect(dbGetContext(id)?.metadata?.revocationReason).toBe(reason ?? "context_revoked");
    }
  });

  it("keeps authority unchanged when renewing, and revocation wins over a pending renewal", () => {
    const now = Date.now();
    const context = createContext("active-turn", {
      expiresAt: now + 60_000,
      metadata: { authorityMode: "agent-identity", actorPrincipal: "system:test" },
    });
    const renewed = dbRenewActiveContext(context.contextId, context.expiresAt, 60_000, now + 1_000)!;
    expect(renewed).toEqual({ ...context, expiresAt: now + 61_000 });
    expect(resolveRuntimeContext(keyOf(context), { touch: false })?.capabilities).toEqual(context.capabilities);
    // An old heartbeat cannot overwrite a newer expiry, even before revocation.
    expect(dbRenewActiveContext(context.contextId, context.expiresAt, 60_000, now + 2_000)).toBeNull();
    expect(dbGetContext(context.contextId)?.expiresAt).toBe(renewed.expiresAt);

    dbRevokeContextCascade(context.contextId, { reason: "permission_removed" });
    expect(dbRenewActiveContext(context.contextId, renewed.expiresAt, 60_000, now + 2_000)).toBeNull();
    expect(resolveRuntimeContext(keyOf(context), { touch: false })).toBeNull();
    expect(dbGetContext(context.contextId)?.expiresAt).toBe(renewed.expiresAt);
  });

  it("cannot use active-turn renewal to revive expiry or extend derived or bridge authority", () => {
    const now = Date.now();
    const expired = createContext("expired-turn", {
      expiresAt: now - 1,
      metadata: { authorityMode: "agent-identity" },
    });
    expect(dbRenewActiveContext(expired.contextId, expired.expiresAt, 60_000, now)).toBeNull();
    expect(resolveRuntimeContext(keyOf(expired), { touch: false })).toBeNull();
    for (const [id, overrides] of [
      ["cli-child", { kind: "cli-runtime", metadata: { authorityMode: "agent-identity" } }],
      ["turn-child", { metadata: { authorityMode: "agent-identity", parentContextId: "parent" } }],
      ["bridge-turn", { metadata: { authorityMode: "agent-identity", bridgeTurnId: "bridge" } }],
    ] as const) {
      const context = createContext(id, { expiresAt: now + 60_000, ...overrides });
      expect(dbRenewActiveContext(context.contextId, context.expiresAt, 60_000, now + 1_000)).toBeNull();
      expect(dbGetContext(context.contextId)).toEqual(context);
    }
  });
});

describe("dbGetOpenThreadHumanRequestTurns", () => {
  const PARENT_KEY = `agent:${AGENT_ID}:slack:group:C0THR`;
  const CHILD_KEY = `${PARENT_KEY}:thread:1712345678.000001`;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-thread-human-turns-");
    dbCreateAgent({ id: AGENT_ID, cwd: "/tmp/context-storage-test" });
    getOrCreateSession(PARENT_KEY, AGENT_ID, "/tmp/context-storage-test", { name: "thr-parent" });
    getOrCreateSession(CHILD_KEY, AGENT_ID, "/tmp/context-storage-test", { name: "thr-child" });
    registerInboundSlackThread({
      parentSessionKey: PARENT_KEY,
      parentSessionName: "thr-parent",
      childSessionKey: CHILD_KEY,
      childSessionName: "thr-child",
      accountId: "slack-main",
      instanceId: "slack-main",
      platformChatId: "C0THR",
      threadCanonicalChatId: "chat-thr",
      providerThreadId: "1712345678.000001",
    });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const human = (id: string, createdAt: number, overrides: Partial<ContextRecord> = {}) =>
    createContext(id, {
      sessionKey: CHILD_KEY,
      createdAt,
      metadata: { humanRequest: { callerContextId: "ctx_caller", originContextId: "ctx_origin" } },
      ...overrides,
    });

  it("returns the open thread's parent and only its turn-runtime human-request turns, oldest first", () => {
    human("late", 3_000);
    human("early", 1_500);
    createContext("agent-only", { sessionKey: CHILD_KEY, createdAt: 1_000, metadata: { actorPrincipal: "agent:x" } });
    human("cli-child", 1_200, { kind: "cli-runtime" });
    human("other-session", 1_100, { sessionKey: PARENT_KEY });

    const thread = dbGetOpenThreadHumanRequestTurns(CHILD_KEY);

    expect(thread?.parentSessionKey).toBe(PARENT_KEY);
    expect(thread?.parentAgentId).toBe(AGENT_ID);
    expect(thread?.humanRequestTurns.map((turn) => turn.contextId)).toEqual(["early", "late"]);
  });

  it("returns null for a closed thread, a session that is not a thread child and a blank key", () => {
    human("early", 1_500);
    expect(dbGetOpenThreadHumanRequestTurns(PARENT_KEY)).toBeNull();
    expect(dbGetOpenThreadHumanRequestTurns("  ")).toBeNull();
    closeSlackThreadLifecycle({ childSessionKey: CHILD_KEY });
    expect(dbGetOpenThreadHumanRequestTurns(CHILD_KEY)).toBeNull();
  });
});

describe("ensureCronOwnerExplicitMigration (legacy NULL cron owners)", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-cron-owner-migration-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function insertJob(id: string, enabled: boolean, ownerPrincipal: string | null, executionType = "agent") {
    getDb()
      .prepare(
        `INSERT INTO cron_jobs (id, name, enabled, schedule_type, schedule_every, session_target, payload_text,
          execution_type, shell_command, owner_principal, created_at, updated_at)
         VALUES (?, ?, ?, 'every', 60000, 'main', 'x', ?, ?, ?, 1000, 2000)`,
      )
      .run(id, `job-${id}`, enabled ? 1 : 0, executionType, executionType === "shell" ? "true" : null, ownerPrincipal);
  }

  function ownerOf(id: string) {
    return getDb().prepare("SELECT owner_principal, enabled, updated_at FROM cron_jobs WHERE id = ?").get(id) as {
      owner_principal: string | null;
      enabled: number;
      updated_at: number;
    };
  }

  it("makes enabled legacy owners explicit once, leaves disabled ones NULL and touches nothing else", () => {
    getDb().prepare("DELETE FROM router_meta WHERE key = ?").run(CRON_OWNER_EXPLICIT_MIGRATION_KEY);
    insertJob("legacy-on", true, null);
    insertJob("legacy-shell-on", true, null, "shell");
    insertJob("legacy-off", false, null);
    insertJob("contact-job", true, "contact:c_ana");

    ensureCronOwnerExplicitMigration();

    expect(ownerOf("legacy-on")).toEqual({ owner_principal: "operator", enabled: 1, updated_at: 2000 });
    expect(ownerOf("legacy-shell-on")).toEqual({ owner_principal: "operator", enabled: 1, updated_at: 2000 });
    expect(ownerOf("legacy-off")).toEqual({ owner_principal: null, enabled: 0, updated_at: 2000 });
    expect(ownerOf("contact-job").owner_principal).toBe("contact:c_ana");
    const marker = getDb()
      .prepare("SELECT value FROM router_meta WHERE key = ?")
      .get(CRON_OWNER_EXPLICIT_MIGRATION_KEY) as {
      value: string;
    };
    expect(JSON.parse(marker.value)).toEqual({ jobIds: ["legacy-on", "legacy-shell-on"] });

    // One-shot: a NULL row enabled later never becomes the operator's.
    insertJob("legacy-late", true, null);
    ensureCronOwnerExplicitMigration();
    expect(ownerOf("legacy-late").owner_principal).toBeNull();
  });

  it("runs when the router schema opens, before anything reads the jobs", () => {
    getDb().prepare("DELETE FROM router_meta WHERE key = ?").run(CRON_OWNER_EXPLICIT_MIGRATION_KEY);
    insertJob("legacy-before-boot", true, null, "shell");
    closeRouterDb();

    // Reopening runs the schema init; the migration is part of it.
    expect(ownerOf("legacy-before-boot").owner_principal).toBe("operator");
    const marker = getDb()
      .prepare("SELECT value FROM router_meta WHERE key = ?")
      .get(CRON_OWNER_EXPLICIT_MIGRATION_KEY) as { value: string } | null;
    expect(marker).not.toBeNull();
    expect(JSON.parse(marker!.value)).toEqual({ jobIds: ["legacy-before-boot"] });
  });
});
