import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CONTEXT_KEY_HASH_PREFIX,
  dbCreateAgent,
  dbDeleteAgent,
  dbGetContext,
  dbGetContextByKeyReadOnly,
  getDb,
  hashContextKey,
  hashStoredContextKeys,
} from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  createRuntimeContext,
  resolveRuntimeContext,
  resolveRuntimeContextById,
  revokeRuntimeContext,
} from "./context-registry.js";

const AGENT = "test-context-key-hash";
let stateDir: string | null = null;

function storedKey(contextId: string): string {
  const row = getDb().prepare("SELECT context_key FROM contexts WHERE context_id = ?").get(contextId) as {
    context_key: string;
  };
  return row.context_key;
}

describe("context keys are stored as hashes", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-context-key-hash-");
    dbCreateAgent({ id: AGENT, cwd: "/tmp/test-context-key-hash" });
  });

  afterEach(async () => {
    getDb().prepare("DELETE FROM contexts WHERE agent_id = ?").run(AGENT);
    dbDeleteAgent(AGENT);
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("returns the clear key once to the issuer and stores only its hash", () => {
    const context = createRuntimeContext({ kind: "test-runtime", agentId: AGENT });

    expect(context.contextKey.startsWith("rctx_")).toBe(true);
    expect(storedKey(context.contextId)).toBe(hashContextKey(context.contextKey));
    expect(storedKey(context.contextId).startsWith(CONTEXT_KEY_HASH_PREFIX)).toBe(true);
    const clearRows = getDb().prepare("SELECT COUNT(*) AS n FROM contexts WHERE context_key LIKE 'rctx_%'").get() as {
      n: number;
    };
    expect(clearRows.n).toBe(0);
  });

  it("resolves the clear key, and the resolved record carries the key that was presented", () => {
    const context = createRuntimeContext({ kind: "test-runtime", agentId: AGENT });

    expect(resolveRuntimeContext(context.contextKey, { touch: false })?.contextId).toBe(context.contextId);
    expect(resolveRuntimeContext(context.contextKey, { touch: false })?.contextKey).toBe(context.contextKey);
    expect(dbGetContextByKeyReadOnly(context.contextKey)?.contextId).toBe(context.contextId);
  });

  it("never resolves the stored hash as if it were a key", () => {
    const context = createRuntimeContext({ kind: "test-runtime", agentId: AGENT });
    const stolen = storedKey(context.contextId);

    expect(resolveRuntimeContext(stolen, { touch: false })).toBeNull();
    expect(dbGetContextByKeyReadOnly(stolen)).toBeNull();
    expect(resolveRuntimeContext(stolen.slice(CONTEXT_KEY_HASH_PREFIX.length), { touch: false })).toBeNull();
  });

  it("gives no key to a record read by id", () => {
    const context = createRuntimeContext({ kind: "test-runtime", agentId: AGENT });

    expect(dbGetContext(context.contextId)?.contextKey).toBe("");
    expect(resolveRuntimeContextById(context.contextId)?.contextKey).toBe("");
  });

  it("applies the same liveness rules when resolving by id", () => {
    const live = createRuntimeContext({ kind: "test-runtime", agentId: AGENT });
    const expired = createRuntimeContext({ kind: "test-runtime", agentId: AGENT, expiresAt: Date.now() - 1 });
    const revoked = createRuntimeContext({ kind: "test-runtime", agentId: AGENT });
    revokeRuntimeContext(revoked.contextId, { cascade: false, reason: "test" });

    expect(resolveRuntimeContextById(live.contextId)?.contextId).toBe(live.contextId);
    expect(resolveRuntimeContextById(expired.contextId)).toBeNull();
    expect(resolveRuntimeContextById(revoked.contextId)).toBeNull();
    expect(resolveRuntimeContextById("ctx_missing")).toBeNull();
  });

  it("hashes keys stored in the clear by an older version, and their holders keep working", () => {
    const legacyKey = "rctx_legacyKeyStoredInTheClear0001";
    const context = createRuntimeContext({ kind: "test-runtime", agentId: AGENT, contextKey: legacyKey });
    getDb().prepare("UPDATE contexts SET context_key = ? WHERE context_id = ?").run(legacyKey, context.contextId);
    expect(storedKey(context.contextId)).toBe(legacyKey);

    expect(hashStoredContextKeys(getDb())).toBe(1);

    expect(storedKey(context.contextId)).toBe(hashContextKey(legacyKey));
    expect(resolveRuntimeContext(legacyKey, { touch: false })?.contextId).toBe(context.contextId);
    expect(hashStoredContextKeys(getDb())).toBe(0);
  });
});
