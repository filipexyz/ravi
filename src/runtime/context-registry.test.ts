import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clearRelations, grantRelation } from "../permissions/relations.js";
import { dbCreateAgent, dbDeleteAgent, dbGetContext, getDb } from "../router/router-db.js";
import {
  createRuntimeContext,
  issueRuntimeContext,
  resolveRuntimeContext,
  resolveRuntimeContextOrThrow,
  revokeRuntimeContext,
  snapshotAgentCapabilities,
} from "./context-registry.js";

const TEST_AGENT_ID = "test-context-agent";

function cleanup(): void {
  const db = getDb();
  db.prepare("DELETE FROM contexts WHERE agent_id = ?").run(TEST_AGENT_ID);
  clearRelations({ subjectType: "agent", subjectId: TEST_AGENT_ID });
  dbDeleteAgent(TEST_AGENT_ID);
}

describe("runtime context registry", () => {
  beforeEach(() => {
    cleanup();
    dbCreateAgent({ id: TEST_AGENT_ID, cwd: "/tmp/test-context-agent" });
  });

  afterEach(() => {
    cleanup();
  });

  it("creates a context with its own identity and resolves it by key", () => {
    const context = createRuntimeContext({
      kind: "test-runtime",
      agentId: TEST_AGENT_ID,
      metadata: { origin: "unit-test" },
      capabilities: [{ permission: "execute", objectType: "group", objectId: "context" }],
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "5511999999999",
      },
    });

    const resolved = resolveRuntimeContext(context.contextKey, { touch: false });
    expect(resolved).not.toBeNull();
    expect(resolved!.contextId).toBe(context.contextId);
    expect(resolved!.contextId).not.toBe(context.sessionKey);
    expect(resolved!.kind).toBe("test-runtime");
    expect(resolved!.agentId).toBe(TEST_AGENT_ID);
    expect(resolved!.metadata).toEqual({ origin: "unit-test" });
    expect(resolved!.capabilities).toEqual([{ permission: "execute", objectType: "group", objectId: "context" }]);
    expect(resolved!.source).toMatchObject({
      channel: "whatsapp",
      accountId: "main",
      chatId: "5511999999999",
    });
  });

  it("snapshots agent relations as context capabilities", () => {
    grantRelation("agent", TEST_AGENT_ID, "execute", "group", "context", "manual");
    grantRelation("agent", TEST_AGENT_ID, "access", "session", "dev-*", "manual");

    const capabilities = snapshotAgentCapabilities(TEST_AGENT_ID);
    expect(capabilities).toContainEqual({
      permission: "execute",
      objectType: "group",
      objectId: "context",
      source: "manual",
    });
    expect(capabilities).toContainEqual({
      permission: "access",
      objectType: "session",
      objectId: "dev-*",
      source: "manual",
    });
  });

  it("rejects expired contexts", () => {
    const context = createRuntimeContext({
      agentId: TEST_AGENT_ID,
      ttlMs: -1000,
    });

    expect(resolveRuntimeContext(context.contextKey, { touch: false })).toBeNull();
    expect(() => resolveRuntimeContextOrThrow(context.contextKey, { touch: false })).toThrow("Context expired");
  });

  it("rejects revoked contexts", () => {
    const context = createRuntimeContext({
      agentId: TEST_AGENT_ID,
      ttlMs: 60_000,
    });

    revokeRuntimeContext(context.contextId);

    expect(resolveRuntimeContext(context.contextKey, { touch: false })).toBeNull();
    expect(() => resolveRuntimeContextOrThrow(context.contextKey, { touch: false })).toThrow("Context revoked");
  });

  it("issues a child context with explicit least-privilege capabilities", () => {
    const parent = createRuntimeContext({
      kind: "agent-runtime",
      agentId: TEST_AGENT_ID,
      ttlMs: 30 * 60 * 1000,
      capabilities: [
        { permission: "execute", objectType: "group", objectId: "daemon" },
        { permission: "access", objectType: "session", objectId: "agent:dev:main" },
      ],
      metadata: {
        approvalSource: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "5511999999999",
        },
      },
    });

    const child = issueRuntimeContext({
      parent,
      cliName: "sync-cli",
      ttlMs: 2 * 60 * 60 * 1000,
      capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
    });

    expect(child.contextId).not.toBe(parent.contextId);
    expect(child.kind).toBe("cli-runtime");
    expect(child.agentId).toBe(TEST_AGENT_ID);
    expect(child.capabilities).toEqual([{ permission: "execute", objectType: "group", objectId: "daemon" }]);
    expect(child.expiresAt).toBe(parent.expiresAt);
    expect(child.metadata).toMatchObject({
      parentContextId: parent.contextId,
      parentContextKind: "agent-runtime",
      issuedFor: "sync-cli",
      issuanceMode: "explicit",
      approvalSource: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "5511999999999",
      },
    });
  });

  it("rejects child capabilities that exceed the parent context", () => {
    const parent = createRuntimeContext({
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "execute", objectType: "group", objectId: "context" }],
    });

    expect(() =>
      issueRuntimeContext({
        parent,
        cliName: "sync-cli",
        capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
      }),
    ).toThrow("Capability not granted by parent context");
  });

  it("cascades revocation to descendants with a single shared revokedAt", () => {
    grantRelation("agent", TEST_AGENT_ID, "admin", "system", "*", "manual");

    const parent = createRuntimeContext({
      kind: "agent-runtime",
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
      ttlMs: 60 * 60 * 1000,
    });

    const child = issueRuntimeContext({
      parent,
      cliName: "child-cli",
      capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
    });

    const grandchild = issueRuntimeContext({
      parent: child,
      cliName: "grandchild-cli",
      capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
    });

    const result = revokeRuntimeContext(parent.contextId, { reason: "regression-test" });
    expect(result.cascaded).toHaveLength(2);
    const cascadedIds = result.cascaded.map((ctx) => ctx.contextId).sort();
    expect(cascadedIds).toEqual([child.contextId, grandchild.contextId].sort());

    const refreshedParent = dbGetContext(parent.contextId);
    const refreshedChild = dbGetContext(child.contextId);
    const refreshedGrandchild = dbGetContext(grandchild.contextId);
    expect(refreshedParent?.revokedAt).toBe(result.revokedAt);
    expect(refreshedChild?.revokedAt).toBe(result.revokedAt);
    expect(refreshedGrandchild?.revokedAt).toBe(result.revokedAt);

    expect(resolveRuntimeContext(parent.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(grandchild.contextKey, { touch: false })).toBeNull();

    expect(refreshedChild?.metadata?.revokedViaCascade).toBe(true);
    expect(refreshedGrandchild?.metadata?.revokedViaCascade).toBe(true);
    expect(refreshedChild?.metadata?.cascadeRootContextId).toBe(parent.contextId);
    expect(refreshedGrandchild?.metadata?.cascadeRootContextId).toBe(parent.contextId);
    expect(refreshedParent?.metadata?.revocationReason).toBe("regression-test");
  });

  it("supports --no-cascade narrow revoke that leaves descendants live", () => {
    grantRelation("agent", TEST_AGENT_ID, "admin", "system", "*", "manual");

    const parent = createRuntimeContext({
      kind: "agent-runtime",
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
      ttlMs: 60 * 60 * 1000,
    });

    const child = issueRuntimeContext({
      parent,
      cliName: "child-cli",
      capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
    });

    const result = revokeRuntimeContext(parent.contextId, { cascade: false });
    expect(result.cascaded).toHaveLength(0);

    const refreshedParent = dbGetContext(parent.contextId);
    const refreshedChild = dbGetContext(child.contextId);
    expect(refreshedParent?.revokedAt).toBe(result.revokedAt);
    expect(refreshedChild?.revokedAt).toBeUndefined();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).not.toBeNull();
  });

  it("allows existing parent contexts to issue new capabilities after live superadmin grant", () => {
    const parent = createRuntimeContext({
      agentId: TEST_AGENT_ID,
      capabilities: [],
    });

    expect(() =>
      issueRuntimeContext({
        parent,
        cliName: "sync-cli",
        capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
      }),
    ).toThrow("Capability not granted by parent context");

    grantRelation("agent", TEST_AGENT_ID, "admin", "system", "*", "manual");

    const child = issueRuntimeContext({
      parent,
      cliName: "sync-cli",
      capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
    });

    expect(child.capabilities).toEqual([{ permission: "execute", objectType: "group", objectId: "daemon" }]);
  });
});
