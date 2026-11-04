import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  type ContextRecord,
  dbCreateAgent,
  dbCreateContext,
  dbGetContext,
  dbRevokeContextCascade,
  dbUpdateContextMetadata,
  getDb,
} from "./router-db.js";
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
});
