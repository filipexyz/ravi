import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { recordPermissionDenial } from "./denials.js";
import { explainPermissionDecision, explainPermissionDenial } from "./explain.js";
import { grantRelation, revokeRelation } from "./relations.js";

let stateDir: string | null = null;

describe("permission explain", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permissions-explain-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("distinguishes revoked grants from never-granted requests", () => {
    grantRelation("agent", "reviewer", "execute", "group", "sessions_info", "manual", { permanent: true });
    revokeRelation("agent", "reviewer", "execute", "group", "sessions_info", { revokedAt: 321 });

    const revoked = explainPermissionDecision({
      agentId: "reviewer",
      relation: "execute",
      objectType: "group",
      objectId: "sessions_info",
    });
    const neverGranted = explainPermissionDecision({
      agentId: "reviewer",
      relation: "execute",
      objectType: "group",
      objectId: "context_codex-bash-hook",
    });

    expect(revoked.final.allowed).toBe(false);
    expect(revoked.branches[0].grantState).toBe("revoked");
    expect(revoked.nearMissRelations[0]).toMatchObject({ revokedAt: 321 });
    expect(neverGranted.branches[0].grantState).toBe("never_granted");
    expect(neverGranted.nearMissRelations).toHaveLength(0);
  });

  it("groups large revocation waves into one event", () => {
    const revokedAt = 456;
    for (let index = 0; index < 12; index++) {
      const group = `group_${index}`;
      grantRelation("agent", "reviewer", "execute", "group", group, "manual", { permanent: true });
      revokeRelation("agent", "reviewer", "execute", "group", group, { revokedAt });
    }

    const decision = explainPermissionDecision({
      agentId: "reviewer",
      relation: "execute",
      objectType: "group",
      objectId: "group_0",
    });

    expect(decision.revocationEvents).toHaveLength(1);
    expect(decision.revocationEvents[0]).toMatchObject({
      id: `revoked_at:${revokedAt}`,
      relationCount: 12,
    });
  });

  it("explains delegated actor inheritance and explicit surface deny", () => {
    grantRelation("agent", "reviewer", "execute", "group", "sessions_info", "manual", { permanent: true });
    grantRelation("contact", "luis", "execute", "group", "sessions_info", "manual", { permanent: true });

    const inherited = explainPermissionDecision({
      agentId: "reviewer",
      actor: "contact:luis",
      chat: "chat:chat_group_1",
      relation: "execute",
      objectType: "group",
      objectId: "sessions_info",
    });

    expect(inherited.final.allowed).toBe(true);
    expect(inherited.branches.find((branch) => branch.branch === "surface")).toMatchObject({
      verdict: "allow",
      grantState: "allowed",
    });

    grantRelation("chat", "chat_group_1", "admin", "system", "*", "manual", { permanent: true });
    const surfaceAdmin = explainPermissionDecision({
      agentId: "reviewer",
      actor: "contact:luis",
      chat: "chat:chat_group_1",
      relation: "execute",
      objectType: "group",
      objectId: "sessions_info",
    });

    expect(surfaceAdmin.final.allowed).toBe(true);
    expect(surfaceAdmin.branches.find((branch) => branch.branch === "surface")).toMatchObject({
      verdict: "allow",
      grantState: "allowed",
      matchedRelations: [
        expect.objectContaining({
          subject: "chat:chat_group_1",
          relation: "admin",
          object: "system:*",
        }),
      ],
    });

    grantRelation("chat", "chat_group_1", "deny_execute", "group", "sessions_info", "manual", { permanent: true });
    const denied = explainPermissionDecision({
      agentId: "reviewer",
      actor: "contact:luis",
      chat: "chat:chat_group_1",
      relation: "execute",
      objectType: "group",
      objectId: "sessions_info",
    });

    expect(denied.final.allowed).toBe(false);
    expect(denied.branches.find((branch) => branch.branch === "surface")).toMatchObject({
      verdict: "deny",
      grantState: "constrained",
    });
  });

  it("explains chat delegation overrides as actor and surface provenance", () => {
    grantRelation("agent", "reviewer", "use", "tool", "Bash", "manual", { permanent: true });
    grantRelation("chat", "chat_group_1", "delegate_use", "tool", "Bash", "manual", { permanent: true });

    const decision = explainPermissionDecision({
      agentId: "reviewer",
      actor: "contact:luis",
      chat: "chat:chat_group_1",
      relation: "use",
      objectType: "tool",
      objectId: "Bash",
    });

    expect(decision.final.allowed).toBe(true);
    expect(decision.branches.find((branch) => branch.branch === "actor")).toMatchObject({
      verdict: "allow",
      detail: "actor branch satisfied by delegation override",
      matchedRelations: [
        {
          subject: "chat:chat_group_1",
          relation: "delegate_use",
          object: "tool:Bash",
        },
      ],
    });
    expect(decision.branches.find((branch) => branch.branch === "surface")).toMatchObject({
      verdict: "allow",
      detail: "surface branch satisfied by delegation override",
      matchedRelations: [
        {
          subject: "chat:chat_group_1",
          relation: "delegate_use",
          object: "tool:Bash",
        },
      ],
    });
  });

  it("explains agent delegation overrides without mislabeling the missing surface branch", () => {
    grantRelation("agent", "reviewer", "use", "tool", "Bash", "manual", { permanent: true });
    grantRelation("agent", "reviewer", "delegate_use", "tool", "Bash", "manual", { permanent: true });

    const decision = explainPermissionDecision({
      agentId: "reviewer",
      actor: "contact:luis",
      chat: "chat:chat_group_1",
      relation: "use",
      objectType: "tool",
      objectId: "Bash",
    });

    expect(decision.final).toMatchObject({
      allowed: false,
      reason: "surface has no explicit allow or override, and actor direct grants cannot be inherited",
    });
    expect(decision.branches.find((branch) => branch.branch === "actor")).toMatchObject({
      verdict: "allow",
      detail: "actor branch satisfied by delegation override",
      matchedRelations: [
        {
          subject: "agent:reviewer",
          relation: "delegate_use",
          object: "tool:Bash",
        },
      ],
    });
    expect(decision.branches.find((branch) => branch.branch === "surface")).toMatchObject({
      verdict: "deny",
    });
  });

  it("ignores delegated superadmin overrides in explanations", () => {
    grantRelation("agent", "reviewer", "admin", "system", "*", "manual", { permanent: true });
    grantRelation("chat", "chat_group_1", "delegate_admin", "system", "*", "manual", { permanent: true });

    const decision = explainPermissionDecision({
      agentId: "reviewer",
      actor: "contact:luis",
      chat: "chat:chat_group_1",
      relation: "admin",
      objectType: "system",
      objectId: "*",
    });

    expect(decision.final.allowed).toBe(false);
    expect(decision.branches.find((branch) => branch.branch === "actor")).toMatchObject({
      verdict: "deny",
      matchedRelations: [],
    });
    expect(decision.matchedRelations.some((relation) => relation.relation === "delegate_admin")).toBe(false);
  });

  it("explains surface constraints that include the requested capability", () => {
    grantRelation("agent", "reviewer", "use", "tool", "Read", "manual", { permanent: true });
    grantRelation("contact", "luis", "use", "tool", "Read", "manual", { permanent: true });
    grantRelation("chat", "chat_group_1", "constrain", "role", "public-chat", "manual", { permanent: true });
    grantRelation("role", "public-chat", "use", "tool", "Read", "manual", { permanent: true });

    const decision = explainPermissionDecision({
      agentId: "reviewer",
      actor: "contact:luis",
      chat: "chat:chat_group_1",
      relation: "use",
      objectType: "tool",
      objectId: "Read",
    });

    expect(decision.final.allowed).toBe(true);
    expect(decision.branches.find((branch) => branch.branch === "surface")).toMatchObject({
      verdict: "allow",
      detail: "surface constraints include the request",
      matchedRelations: expect.arrayContaining([
        expect.objectContaining({
          subject: "chat:chat_group_1",
          relation: "constrain",
          object: "role:public-chat",
        }),
        expect.objectContaining({
          subject: "role:public-chat",
          relation: "use",
          object: "tool:Read",
        }),
      ]),
    });
  });

  it("keeps surface constraints above direct surface grants in explanations", () => {
    grantRelation("agent", "reviewer", "use", "tool", "Bash", "manual", { permanent: true });
    grantRelation("contact", "luis", "use", "tool", "Bash", "manual", { permanent: true });
    grantRelation("chat", "chat_group_1", "use", "tool", "Bash", "manual", { permanent: true });
    grantRelation("chat", "chat_group_1", "constrain", "role", "public-chat", "manual", { permanent: true });
    grantRelation("role", "public-chat", "use", "tool", "Read", "manual", { permanent: true });

    const decision = explainPermissionDecision({
      agentId: "reviewer",
      actor: "contact:luis",
      chat: "chat:chat_group_1",
      relation: "use",
      objectType: "tool",
      objectId: "Bash",
    });

    expect(decision.final).toMatchObject({
      allowed: false,
      reason: "surface has explicit role constraints that do not include the request",
    });
    expect(decision.branches.find((branch) => branch.branch === "surface")).toMatchObject({
      verdict: "deny",
      grantState: "constrained",
    });
  });

  it("does not treat surface role grants as explicit surface decisions", () => {
    grantRelation("agent", "reviewer", "execute", "group", "sessions_info", "manual", { permanent: true });
    grantRelation("contact", "luis", "execute", "group", "sessions_info", "manual", { permanent: true });
    grantRelation("chat", "chat_group_1", "member", "role", "blocked-surface", "manual", { permanent: true });
    grantRelation("role", "blocked-surface", "deny_execute", "group", "sessions_info", "manual", { permanent: true });

    const decision = explainPermissionDecision({
      agentId: "reviewer",
      actor: "contact:luis",
      chat: "chat:chat_group_1",
      relation: "execute",
      objectType: "group",
      objectId: "sessions_info",
    });

    expect(decision.final.allowed).toBe(true);
    expect(decision.branches.find((branch) => branch.branch === "surface")).toMatchObject({
      verdict: "allow",
      detail: "surface has no explicit allow/deny for this object; inherited actor branch",
    });
  });

  it("re-evaluates a recorded denial against the current graph", () => {
    const denial = recordPermissionDenial({
      subjectType: "agent",
      subjectId: "reviewer",
      agentId: "reviewer",
      relation: "execute",
      objectType: "group",
      objectId: "sessions_info",
      detail: {
        context: {
          actorPrincipal: "contact:luis",
          surfacePrincipal: "chat:chat_group_1",
        },
      },
    });
    expect(denial).not.toBeNull();

    grantRelation("agent", "reviewer", "execute", "group", "sessions_info", "manual", { permanent: true });
    grantRelation("contact", "luis", "execute", "group", "sessions_info", "manual", { permanent: true });
    const explanation = explainPermissionDenial(denial!.id);

    expect(explanation.currentlyDenied).toBe(false);
    expect(explanation.current.final.allowed).toBe(true);
  });

  it("keeps recorded turn capabilities as an upper bound when explaining a denial", () => {
    grantRelation("agent", "reviewer", "execute", "group", "sessions_info", "manual", { permanent: true });
    grantRelation("contact", "luis", "execute", "group", "sessions_info", "manual", { permanent: true });
    const denial = recordPermissionDenial({
      subjectType: "agent",
      subjectId: "reviewer",
      agentId: "reviewer",
      relation: "execute",
      objectType: "group",
      objectId: "sessions_info",
      detail: {
        context: {
          actorPrincipal: "contact:luis",
          surfacePrincipal: "chat:chat_group_1",
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
      },
    });

    const explanation = explainPermissionDenial(denial!.id);

    expect(explanation.currentlyDenied).toBe(true);
    expect(explanation.current.final).toMatchObject({
      allowed: false,
      reason: "turn capability upper bound does not include the request",
    });
    expect(explanation.current.branches.find((branch) => branch.branch === "turn")).toMatchObject({
      verdict: "deny",
      grantState: "constrained",
      capabilitiesCount: 1,
    });
  });
});
