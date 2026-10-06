import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbCreateAgent, dbDeleteAgent, dbGetContext, getDb } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  DELEGATED_SESSION_ACTOR_REQUIRES_SESSION,
  DELEGATED_SESSION_ACTOR_UNAVAILABLE,
  DELEGATED_SESSION_BINDINGS_MUST_BE_PAIRED,
  IDENTITY_DELEGATION_REQUIRES_ADMIN,
  RuntimeContextError,
} from "./context-errors.js";
import {
  ADMIN_BOOTSTRAP_KIND,
  createRuntimeContext,
  issueRuntimeContext,
  LEGACY_AGENT_RUNTIME_CONTEXT_KIND,
  listLiveAdminContexts,
  resolveRuntimeContext,
  resolveRuntimeContextOrThrow,
  revokeAgentRuntimeContextsForSession,
  revokeLiveRuntimeContextsForAgent,
  revokeLiveRuntimeContextsForContactGrant,
  revokeRuntimeContext,
  snapshotAgentCapabilities,
} from "./context-registry.js";

const TEST_AGENT_ID = "test-context-agent";
let stateDir: string | null = null;

function cleanup(): void {
  const db = getDb();
  db.prepare("DELETE FROM contexts WHERE agent_id = ?").run(TEST_AGENT_ID);
  db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(TEST_AGENT_ID);
  dbDeleteAgent(TEST_AGENT_ID);
}

function createTestSession(sessionKey: string): void {
  getOrCreateSession(sessionKey, TEST_AGENT_ID, "/tmp/test-context-agent", {
    name: sessionKey.replaceAll(":", "-"),
  });
}

describe("runtime context registry", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-context-registry-");
    cleanup();
    dbCreateAgent({ id: TEST_AGENT_ID, cwd: "/tmp/test-context-agent" });
  });

  afterEach(async () => {
    cleanup();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
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

  it("revokes live agent-runtime contexts for a session", () => {
    const sessionKey = "agent:test-context-agent:reset";
    createTestSession(sessionKey);
    const first = createRuntimeContext({
      kind: LEGACY_AGENT_RUNTIME_CONTEXT_KIND,
      agentId: TEST_AGENT_ID,
      sessionKey,
      sessionName: "test-reset",
      capabilities: [],
    });
    const child = issueRuntimeContext({
      parent: first,
      cliName: "child-cli",
      capabilities: [],
    });

    const result = revokeAgentRuntimeContextsForSession(sessionKey, { reason: "session_reset_test" });
    expect(result).toHaveLength(1);
    expect(result[0]!.context.contextId).toBe(first.contextId);
    expect(result[0]!.cascaded.map((ctx) => ctx.contextId)).toContain(child.contextId);
    expect(resolveRuntimeContext(first.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).toBeNull();
    expect(dbGetContext(first.contextId)?.metadata?.revocationReason).toBe("session_reset_test");
  });

  it("revokes live turn-runtime contexts for a session without touching other sessions", () => {
    const sessionKey = "agent:test-context-agent:turn-reset";
    const otherSessionKey = "agent:test-context-agent:turn-other";
    createTestSession(sessionKey);
    createTestSession(otherSessionKey);
    const turnContext = createRuntimeContext({
      kind: "turn-runtime",
      agentId: TEST_AGENT_ID,
      sessionKey,
      sessionName: "test-turn-reset",
      capabilities: [],
    });
    const child = issueRuntimeContext({
      parent: turnContext,
      cliName: "child-cli",
      capabilities: [],
    });
    const otherSession = createRuntimeContext({
      kind: "turn-runtime",
      agentId: TEST_AGENT_ID,
      sessionKey: otherSessionKey,
      sessionName: "test-turn-other",
      capabilities: [],
    });

    const result = revokeAgentRuntimeContextsForSession(sessionKey, { reason: "turn_reset_test" });

    expect(result.map((entry) => entry.context.contextId)).toEqual([turnContext.contextId]);
    expect(resolveRuntimeContext(turnContext.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).toBeNull();
    expect(dbGetContext(turnContext.contextId)?.metadata?.revocationReason).toBe("turn_reset_test");
    expect(resolveRuntimeContext(otherSession.contextKey, { touch: false })).not.toBeNull();
  });

  it("revokes every live authority snapshot when agent permissions change", () => {
    const agentRuntime = createRuntimeContext({
      kind: "agent-runtime",
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
    });
    const turnRuntime = createRuntimeContext({
      kind: "turn-runtime",
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
    });
    const child = issueRuntimeContext({
      parent: turnRuntime,
      cliName: "child-cli",
      inheritCapabilities: true,
    });
    const unrelated = createRuntimeContext({ kind: "turn-runtime", capabilities: [] });

    const result = revokeLiveRuntimeContextsForAgent(TEST_AGENT_ID);

    expect(result.map((entry) => entry.context.contextId).sort()).toEqual(
      [agentRuntime.contextId, turnRuntime.contextId].sort(),
    );
    expect(resolveRuntimeContext(agentRuntime.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(turnRuntime.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(unrelated.contextKey, { touch: false })).not.toBeNull();
    expect(dbGetContext(turnRuntime.contextId)?.metadata?.revocationReason).toBe("agent_permissions_changed");
  });

  it("revokes only live snapshots whose user overlay used a revoked contact grant", () => {
    const overlayMetadata = (actor: string, grants: string[]) => ({
      actorPrincipal: actor,
      actorAuthorizationMode: "user-overlay",
      userOverlay: "active",
      userOverlayGrants: grants,
    });
    const usesGrant = createRuntimeContext({
      kind: "turn-runtime",
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "mutate", objectType: "image", objectId: "generate" }],
      metadata: overlayMetadata("contact:ana", ["permission-image@chat:chat-1"]),
    });
    const child = issueRuntimeContext({ parent: usesGrant, cliName: "child-cli", inheritCapabilities: true });
    const otherChat = createRuntimeContext({
      kind: "turn-runtime",
      agentId: TEST_AGENT_ID,
      capabilities: [],
      metadata: overlayMetadata("contact:ana", ["permission-image@chat:chat-2"]),
    });
    const otherContact = createRuntimeContext({
      kind: "turn-runtime",
      agentId: TEST_AGENT_ID,
      capabilities: [],
      metadata: overlayMetadata("contact:bruno", ["permission-image@chat:chat-1"]),
    });

    const result = revokeLiveRuntimeContextsForContactGrant("ana", "permission-image@chat:chat-1");

    expect(result.map((entry) => entry.context.contextId)).toEqual([usesGrant.contextId]);
    expect(resolveRuntimeContext(usesGrant.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(otherChat.contextKey, { touch: false })).not.toBeNull();
    expect(resolveRuntimeContext(otherContact.contextKey, { touch: false })).not.toBeNull();
    expect(dbGetContext(usesGrant.contextId)?.metadata?.revocationReason).toBe("contact_grant_revoked");
  });

  it("snapshots provider materialized capabilities only", () => {
    const capabilities = snapshotAgentCapabilities(TEST_AGENT_ID);
    expect(capabilities).toContainEqual({
      permission: "use",
      objectType: "tool",
      objectId: "*",
      source: "runtime-bootstrap:agent",
    });
    expect(capabilities).not.toContainEqual({
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

  it("lets an admin parent delegate an explicit service identity", () => {
    getOrCreateSession("agent:main:main", "main", "/tmp/ravi-main", { name: "main" });
    const parent = createRuntimeContext({
      kind: ADMIN_BOOTSTRAP_KIND,
      agentId: TEST_AGENT_ID,
      capabilities: [
        { permission: "admin", objectType: "system", objectId: "*" },
        { permission: "access", objectType: "session", objectId: "main" },
      ],
    });

    const child = issueRuntimeContext({
      parent,
      cliName: "hub-client-issuer",
      capabilities: [{ permission: "access", objectType: "session", objectId: "main" }],
      identity: {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionName: "main",
      },
    });

    expect(child.agentId).toBe("main");
    expect(child.sessionKey).toBe("agent:main:main");
    expect(child.sessionName).toBe("main");
    expect(child.source).toBeUndefined();
    expect(child.metadata).toMatchObject({
      parentContextId: parent.contextId,
      issuedFor: "hub-client-issuer",
      identityDelegation: {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionName: "main",
      },
    });
  });

  describe("delegated session actor projection", () => {
    const SESSION_KEY = `agent:${TEST_AGENT_ID}:main`;

    beforeEach(() => {
      createTestSession(SESSION_KEY);
      createTestSession(`agent:${TEST_AGENT_ID}:other`);
    });

    function adminParent() {
      return createRuntimeContext({
        kind: ADMIN_BOOTSTRAP_KIND,
        agentId: TEST_AGENT_ID,
        capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
      });
    }

    function turnContext(metadata: Record<string, unknown>, expiresAt?: number) {
      return createRuntimeContext({
        kind: "turn-runtime",
        agentId: TEST_AGENT_ID,
        sessionKey: SESSION_KEY,
        sessionName: "main",
        metadata,
        ...(expiresAt ? { expiresAt } : {}),
      });
    }

    function issueWithActor(parent = adminParent()) {
      return issueRuntimeContext({
        parent,
        cliName: "nba",
        identity: { agentId: TEST_AGENT_ID, sessionKey: SESSION_KEY, sessionName: "main", projectSessionActor: true },
      });
    }

    it("projects the resolved human actor of the live session turn", () => {
      const turnExpiresAt = Date.now() + 5 * 60_000;
      const turn = turnContext(
        {
          actorPrincipal: "contact:c-1",
          actorResolution: "resolved",
          actorDisplayName: "Ana",
          consoleUserId: "u-1",
          userOverlayGrants: ["full@chat:x"],
        },
        turnExpiresAt,
      );

      const child = issueWithActor();

      expect(child.metadata).toMatchObject({
        actorPrincipal: "contact:c-1",
        actorResolution: "resolved",
        actorDisplayName: "Ana",
        consoleUserId: "u-1",
        actorProjection: {
          source: "delegated-session-turn",
          sourceContextId: turn.contextId,
          agentId: TEST_AGENT_ID,
          sessionKey: SESSION_KEY,
        },
      });
      expect(child.metadata?.userOverlayGrants).toBeUndefined();
      expect(child.expiresAt).toBe(turnExpiresAt);
    });

    it("keeps the projected actor authoritative over caller metadata", () => {
      turnContext({ actorPrincipal: "contact:c-1", actorResolution: "resolved" });
      const child = issueRuntimeContext({
        parent: adminParent(),
        cliName: "nba",
        metadata: {
          actorPrincipal: "contact:forged",
          consoleUserId: "user-forged",
          actorDisplayName: "Forged",
          actorProjection: { sourceContextId: "ctx_forged" },
        },
        identity: { agentId: TEST_AGENT_ID, sessionKey: SESSION_KEY, sessionName: "main", projectSessionActor: true },
      });
      expect(child.metadata?.actorPrincipal).toBe("contact:c-1");
      expect(child.metadata?.consoleUserId).toBeUndefined();
      expect(child.metadata?.actorDisplayName).toBeUndefined();
      expect(child.metadata?.actorProjection).toMatchObject({ source: "delegated-session-turn" });
    });

    it("revokes the projected child when the source turn is revoked", () => {
      const turn = turnContext({ actorPrincipal: "contact:c-1", actorResolution: "resolved" });
      const child = issueWithActor();

      const result = revokeRuntimeContext(turn.contextId, { reason: "turn_superseded" });

      expect(result.cascaded.map((ctx) => ctx.contextId)).toContain(child.contextId);
      expect(resolveRuntimeContext(child.contextKey)).toBeNull();
    });

    it("revokes the projected child when the session slot is reset", () => {
      turnContext({ actorPrincipal: "contact:c-1", actorResolution: "resolved" });
      const child = issueWithActor();

      revokeAgentRuntimeContextsForSession(SESSION_KEY);

      expect(resolveRuntimeContext(child.contextKey)).toBeNull();
    });

    it("revokes the projected child even when the source turn is revoked without cascade", () => {
      const turn = turnContext({ actorPrincipal: "contact:c-1", actorResolution: "resolved" });
      const child = issueWithActor();

      revokeRuntimeContext(turn.contextId, { cascade: false });

      expect(resolveRuntimeContext(child.contextKey)).toBeNull();
    });

    it("fails closed without a live turn, a resolved actor or a human actor", () => {
      const cases: Array<[Record<string, unknown> | null, string]> = [
        [null, "no_live_turn"],
        [{ actorPrincipal: "contact:c-1", actorResolution: "missing_contact" }, "actor_not_resolved"],
        [{ actorPrincipal: "automation:cron-1", actorResolution: "resolved" }, "actor_not_human"],
      ];
      for (const [metadata, reason] of cases) {
        getDb().prepare("DELETE FROM contexts WHERE agent_id = ?").run(TEST_AGENT_ID);
        if (metadata) turnContext(metadata);
        try {
          issueWithActor();
          throw new Error(`expected projection to fail: ${reason}`);
        } catch (error) {
          expect(error).toBeInstanceOf(RuntimeContextError);
          expect(error).toMatchObject({
            code: "PERMISSION_DENIED",
            message: DELEGATED_SESSION_ACTOR_UNAVAILABLE,
            details: { reason },
          });
        }
      }
    });

    it("ignores revoked turns and turns of other sessions", () => {
      const revoked = turnContext({ actorPrincipal: "contact:c-1", actorResolution: "resolved" });
      revokeRuntimeContext(revoked.contextId);
      createRuntimeContext({
        kind: "turn-runtime",
        agentId: TEST_AGENT_ID,
        sessionKey: `agent:${TEST_AGENT_ID}:other`,
        metadata: { actorPrincipal: "contact:c-2", actorResolution: "resolved" },
      });

      expect(() => issueWithActor()).toThrow(DELEGATED_SESSION_ACTOR_UNAVAILABLE);
    });

    it("requires a delegated session binding", () => {
      expect(() =>
        issueRuntimeContext({
          parent: adminParent(),
          cliName: "nba",
          identity: { agentId: TEST_AGENT_ID, projectSessionActor: true },
        }),
      ).toThrow(DELEGATED_SESSION_ACTOR_REQUIRES_SESSION);
    });

    it("does not project an actor without the explicit flag", () => {
      turnContext({ actorPrincipal: "contact:c-1", actorResolution: "resolved" });
      const child = issueRuntimeContext({
        parent: adminParent(),
        cliName: "nba",
        identity: { agentId: TEST_AGENT_ID, sessionKey: SESSION_KEY, sessionName: "main" },
      });
      expect(child.metadata?.actorPrincipal).toBeUndefined();
      expect(child.metadata?.actorProjection).toBeUndefined();
    });

    it("still requires an admin parent", () => {
      turnContext({ actorPrincipal: "contact:c-1", actorResolution: "resolved" });
      expect(() => issueWithActor(createRuntimeContext({ agentId: TEST_AGENT_ID }))).toThrow(
        IDENTITY_DELEGATION_REQUIRES_ADMIN,
      );
    });
  });

  it("rejects identity delegation from a non-admin parent", () => {
    const parent = createRuntimeContext({
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "access", objectType: "session", objectId: "main" }],
    });

    expect(() =>
      issueRuntimeContext({
        parent,
        cliName: "hub-client-issuer",
        capabilities: [{ permission: "access", objectType: "session", objectId: "main" }],
        identity: { agentId: "main" },
      }),
    ).toThrow(RuntimeContextError);
    try {
      issueRuntimeContext({
        parent,
        cliName: "hub-client-issuer",
        capabilities: [{ permission: "access", objectType: "session", objectId: "main" }],
        identity: { agentId: "main" },
      });
      throw new Error("expected identity delegation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeContextError);
      expect(error).toMatchObject({
        code: "PERMISSION_DENIED",
        message: IDENTITY_DELEGATION_REQUIRES_ADMIN,
        details: { requiredCapability: "admin:system:*" },
      });
    }
  });

  it("rejects unpaired delegated session bindings", () => {
    const parent = createRuntimeContext({
      kind: ADMIN_BOOTSTRAP_KIND,
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
    });

    expect(() =>
      issueRuntimeContext({
        parent,
        cliName: "hub-client-issuer",
        identity: { agentId: "main", sessionKey: "agent:main:main" },
      }),
    ).toThrow(DELEGATED_SESSION_BINDINGS_MUST_BE_PAIRED);
    try {
      issueRuntimeContext({
        parent,
        cliName: "hub-client-issuer",
        identity: { agentId: "main", sessionKey: "agent:main:main" },
      });
      throw new Error("expected unpaired session bindings to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeContextError);
      expect(error).toMatchObject({
        code: "USAGE_ERROR",
        exitCode: 2,
        message: DELEGATED_SESSION_BINDINGS_MUST_BE_PAIRED,
      });
    }
  });

  it("cascades revocation to descendants with a single shared revokedAt", () => {
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

  it("keeps existing parent contexts bounded after live superadmin grant changes", () => {
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

    expect(() =>
      issueRuntimeContext({
        parent,
        cliName: "sync-cli",
        capabilities: [{ permission: "execute", objectType: "group", objectId: "daemon" }],
      }),
    ).toThrow("Capability not granted by parent context");
  });

  it("only treats bootstrap admin contexts as live admin contexts", () => {
    createTestSession("agent:test-context-agent:admin");
    createRuntimeContext({
      kind: "agent-runtime",
      agentId: TEST_AGENT_ID,
      sessionKey: "agent:test-context-agent:admin",
      capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
      ttlMs: 60_000,
    });

    const bootstrap = createRuntimeContext({
      kind: ADMIN_BOOTSTRAP_KIND,
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
      ttlMs: 60_000,
    });
    const nonAdminBootstrap = createRuntimeContext({
      kind: ADMIN_BOOTSTRAP_KIND,
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "use", objectType: "tool", objectId: "*" }],
      ttlMs: 60_000,
    });
    const expiredBootstrap = createRuntimeContext({
      kind: ADMIN_BOOTSTRAP_KIND,
      agentId: TEST_AGENT_ID,
      capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
      expiresAt: Date.now() - 1,
    });

    const testAgentAdminContextIds = listLiveAdminContexts()
      .filter((context) => context.agentId === TEST_AGENT_ID)
      .map((context) => context.contextId);
    expect(testAgentAdminContextIds).toEqual([bootstrap.contextId]);
    expect(testAgentAdminContextIds).not.toContain(nonAdminBootstrap.contextId);
    expect(testAgentAdminContextIds).not.toContain(expiredBootstrap.contextId);
  });
});
