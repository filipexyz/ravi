import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  type ContextRecord,
  dbCreateAgent,
  dbCreateContext,
  dbGetContext,
  dbRenewActiveContext,
  dbRevokeContextCascade,
  dbUpdateContextMetadata,
  dbUpdateContextRuntimeState,
  getDb,
} from "./router-db.js";
import { resolveRuntimeContext } from "../runtime/context-registry.js";
import { getOrCreateSession } from "./sessions.js";

const AGENT_ID = "context-storage-test";
const SESSION_KEY = `agent:${AGENT_ID}:test`;
const REVOKED_AT = 4_000;
let stateDir: string | null = null;

function createContext(id: string, overrides: Partial<ContextRecord> = {}): ContextRecord {
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
      metadata: { ...metadata, authorityRevokedAt: REVOKED_AT, revocationReason: "permission_profile_reduced" },
    });
    expect(dbGetContext(root.contextId)).toEqual(result.context);
    expect(result.cascaded.map((context) => context.contextId).sort()).toEqual(["child", "grandchild"]);
    for (const original of [child, grandchild]) {
      expect(dbGetContext(original.contextId)).toEqual({
        ...original,
        revokedAt: REVOKED_AT,
        metadata: {
          ...original.metadata,
          authorityRevokedAt: REVOKED_AT,
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

  it("keeps explicit withdrawal after ordinary completion and metadata refresh", () => {
    const root = createContext("withdrawn");
    const unaffected = createContext("normal");
    dbRevokeContextCascade(root.contextId, { revokedAt: 3_000, reason: "turn_context_completed" });
    expect(dbGetContext(root.contextId)?.metadata?.authorityRevokedAt).toBeUndefined();
    dbRevokeContextCascade(root.contextId, { revokedAt: REVOKED_AT });
    dbRevokeContextCascade(root.contextId, { revokedAt: 5_000, reason: "turn_context_completed" });
    dbUpdateContextMetadata(root.contextId, { arbitraryRefresh: true, authorityRevokedAt: null });
    dbUpdateContextRuntimeState(root.contextId, { metadata: { activation: true } });
    expect(dbGetContext(root.contextId)?.metadata).toEqual({ activation: true, authorityRevokedAt: REVOKED_AT });
    dbUpdateContextRuntimeState(root.contextId, {});
    expect(dbGetContext(root.contextId)?.metadata).toEqual({ authorityRevokedAt: REVOKED_AT });
    expect(dbGetContext(root.contextId)?.revokedAt).toBe(5_000);
    expect(dbGetContext(unaffected.contextId)).toEqual(unaffected);
  });

  it("preserves a withdrawal committed after cascade targets were read but before completion acquires its lock", () => {
    const { root, child, grandchild, unrelated } = createFamily();
    const db = getDb();
    const writer = new Database(db.filename);
    const originalExec = db.exec;
    let interleavings = 0;

    // Intercept timing only: another connection commits a real withdrawal
    // after the cascade captured stale targets, before its BEGIN IMMEDIATE.
    db.exec = ((sql: string) => {
      if (sql === "BEGIN IMMEDIATE" && interleavings === 0) {
        interleavings++;
        expect(db.inTransaction).toBe(false);
        writer.transaction(() => {
          writer
            .prepare(`
            UPDATE contexts
            SET revoked_at = ?, metadata_json = json_set(
              metadata_json, '$.authorityRevokedAt', ?, '$.revocationReason', 'explicit_revoke'
            )
            WHERE context_id IN (?, ?, ?)
          `)
            .run(REVOKED_AT, REVOKED_AT, root.contextId, child.contextId, grandchild.contextId);
        })();
        expect(writer.inTransaction).toBe(false);
      }
      return originalExec.call(db, sql);
    }) as typeof db.exec;

    try {
      const result = dbRevokeContextCascade(root.contextId, {
        revokedAt: 5_000,
        reason: "turn_context_completed",
      });

      expect(interleavings).toBe(1);
      for (const context of [result.context, ...result.cascaded]) {
        expect(context.metadata?.authorityRevokedAt).toBe(REVOKED_AT);
        expect(context.metadata?.revocationReason).toBe("turn_context_completed");
        expect(context.revokedAt).toBe(5_000);
      }
      expect(result.cascaded.map((context) => context.contextId).sort()).toEqual(["child", "grandchild"]);

      db.transaction(() => {
        dbUpdateContextMetadata(root.contextId, { refresh: "metadata", authorityRevokedAt: null });
        dbUpdateContextRuntimeState(child.contextId, { metadata: { refresh: "runtime", authorityRevokedAt: null } });
        expect(db.inTransaction).toBe(true);
      })();
      expect(dbGetContext(root.contextId)?.metadata).toEqual({ refresh: "metadata", authorityRevokedAt: REVOKED_AT });
      expect(dbGetContext(child.contextId)?.metadata).toEqual({ refresh: "runtime", authorityRevokedAt: REVOKED_AT });
      expect(dbGetContext(unrelated.contextId)).toEqual(unrelated);
      expect(db.inTransaction).toBe(false);
    } finally {
      db.exec = originalExec;
      writer.close();
    }
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

  it("keeps authority unchanged when renewing, and revocation wins over a pending renewal", () => {
    const now = Date.now();
    const context = createContext("active-turn", {
      expiresAt: now + 60_000,
      metadata: { authorityMode: "agent-identity", actorPrincipal: "system:test" },
    });
    const renewed = dbRenewActiveContext(context.contextId, context.expiresAt, 60_000, now + 1_000)!;
    expect(renewed).toEqual({ ...context, expiresAt: now + 61_000 });
    expect(resolveRuntimeContext(context.contextKey, { touch: false })?.capabilities).toEqual(context.capabilities);
    // An old heartbeat cannot overwrite a newer expiry, even before revocation.
    expect(dbRenewActiveContext(context.contextId, context.expiresAt, 60_000, now + 2_000)).toBeNull();
    expect(dbGetContext(context.contextId)?.expiresAt).toBe(renewed.expiresAt);

    dbRevokeContextCascade(context.contextId, { reason: "permission_removed" });
    expect(dbRenewActiveContext(context.contextId, renewed.expiresAt, 60_000, now + 2_000)).toBeNull();
    expect(resolveRuntimeContext(context.contextKey, { touch: false })).toBeNull();
    expect(dbGetContext(context.contextId)?.expiresAt).toBe(renewed.expiresAt);
  });

  it("cannot use active-turn renewal to revive expiry or extend derived or bridge authority", () => {
    const now = Date.now();
    const expired = createContext("expired-turn", {
      expiresAt: now - 1,
      metadata: { authorityMode: "agent-identity" },
    });
    expect(dbRenewActiveContext(expired.contextId, expired.expiresAt, 60_000, now)).toBeNull();
    expect(resolveRuntimeContext(expired.contextKey, { touch: false })).toBeNull();
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
