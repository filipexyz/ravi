import { describe, expect, it } from "bun:test";
import { buildAuditContextProvenance } from "./audit-provenance.js";

describe("audit context provenance", () => {
  it("preserves serialized turn capabilities for denial explanation", () => {
    const provenance = buildAuditContextProvenance({
      context: {
        contextId: "ctx_1",
        contextKey: "key_1",
        kind: "turn-runtime",
        agentId: "reviewer",
        capabilities: [],
        metadata: {
          authorityMode: "delegated",
          turnCapabilityCount: 1,
          turnCapabilities: [
            {
              permission: "execute",
              objectType: "group",
              objectId: "observer_report",
              source: "observer-rule",
            },
          ],
        },
        createdAt: 1,
      },
    });

    expect(provenance?.turnCapabilities).toEqual([
      {
        permission: "execute",
        objectType: "group",
        objectId: "observer_report",
        source: "observer-rule",
      },
    ]);
  });

  it("preserves agent identity provenance fields", () => {
    const provenance = buildAuditContextProvenance({
      context: {
        contextId: "ctx_agent_identity",
        contextKey: "key_agent_identity",
        kind: "turn-runtime",
        agentId: "worker",
        capabilities: [],
        metadata: {
          authorityMode: "agent-identity",
          authorityResolver: "agent-identity-v1",
          executorAgentId: "worker",
          actorPrincipal: "unknown",
          actorResolution: "missing_contact",
          actorAuthorizationMode: "invoke-only",
          surfacePrincipal: "chat:chat_alpha",
          surfaceAuthorizationMode: "compartment",
          agentIdentityPrincipal: "agent_identity:worker:chat:chat_alpha",
          agentIdentityCompartment: "chat:chat_alpha",
          agentIdentityCapabilityCount: 0,
          effectiveCapabilityCount: 0,
        },
        createdAt: 1,
      },
    });

    expect(provenance).toMatchObject({
      authorityMode: "agent-identity",
      authorityResolver: "agent-identity-v1",
      executorAgentId: "worker",
      actorPrincipal: "unknown",
      actorResolution: "missing_contact",
      actorAuthorizationMode: "invoke-only",
      surfacePrincipal: "chat:chat_alpha",
      surfaceAuthorizationMode: "compartment",
      agentIdentityPrincipal: "agent_identity:worker:chat:chat_alpha",
      agentIdentityCompartment: "chat:chat_alpha",
      agentIdentityCapabilityCount: 0,
      effectiveCapabilityCount: 0,
    });
  });

  it("redacts token-shaped values before provenance reaches audit", () => {
    const provenance = buildAuditContextProvenance({
      contextId: "ctx_safe",
      sessionName: "prefix rctx_private_context suffix",
      metadata: {
        actorDisplayName: "Bearer private.access.token",
        surfacePrincipal: "sk-abcdefghijklmnop",
      },
      source: {
        channel: "slack",
        accountId: "rctx_private_account",
        chatId: "chat_safe",
      },
    });

    expect(provenance).toMatchObject({
      contextId: "ctx_safe",
      sessionName: "prefix [REDACTED:rctx] suffix",
      actorDisplayName: "Bearer [REDACTED]",
      surfacePrincipal: "[REDACTED:token]",
      source: { channel: "slack", accountId: "[REDACTED:rctx]", chatId: "chat_safe" },
    });
    expect(JSON.stringify(provenance)).not.toContain("private");
  });
});
