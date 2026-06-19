import { describe, expect, it } from "bun:test";
import type { ContextCapability } from "../router/router-db.js";
import { canWithCapabilities } from "./capability-context.js";
import { buildEffectiveCapabilities, materializeDelegatedAuthority } from "./delegation.js";

const cap = (permission: string, objectType: string, objectId: string): ContextCapability => ({
  permission,
  objectType,
  objectId,
});

const expandedConstraintCap = (permission: string, objectType: string, objectId: string): ContextCapability => ({
  permission,
  objectType,
  objectId,
  source: "constraint:role:public-chat",
});

const allows = (capabilities: ContextCapability[], permission: string, objectType: string, objectId: string): boolean =>
  canWithCapabilities(capabilities, permission, objectType, objectId);

describe("delegated authority materialization", () => {
  it("allows only when agent, actor, and explicit surface all permit", () => {
    const result = materializeDelegatedAuthority({
      agentPrincipal: { subjectType: "agent", subjectId: "executor" },
      actorPrincipal: { subjectType: "contact", subjectId: "luis" },
      surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      agentCapabilities: [cap("use", "tool", "*")],
      actorCapabilities: [cap("use", "tool", "Bash")],
      surfaceCapabilities: [cap("use", "tool", "Bash")],
    });

    expect(allows(result.effectiveCapabilities, "use", "tool", "Bash")).toBe(true);
    expect(allows(result.effectiveCapabilities, "use", "tool", "Read")).toBe(false);
  });

  it("denies when the actor lacks the capability even if agent and surface allow", () => {
    const result = materializeDelegatedAuthority({
      agentPrincipal: { subjectType: "agent", subjectId: "executor" },
      actorPrincipal: { subjectType: "contact", subjectId: "luis" },
      surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      agentCapabilities: [cap("use", "tool", "*")],
      actorCapabilities: [],
      surfaceCapabilities: [cap("use", "tool", "*")],
    });

    expect(allows(result.effectiveCapabilities, "use", "tool", "Bash")).toBe(false);
  });

  it("denies when the executor agent ceiling lacks the capability", () => {
    const result = materializeDelegatedAuthority({
      agentPrincipal: { subjectType: "agent", subjectId: "executor" },
      actorPrincipal: { subjectType: "contact", subjectId: "luis" },
      surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      agentCapabilities: [],
      actorCapabilities: [cap("use", "tool", "Bash")],
      surfaceCapabilities: [cap("use", "tool", "*")],
    });

    expect(allows(result.effectiveCapabilities, "use", "tool", "Bash")).toBe(false);
  });

  it("inherits the actor branch when the surface has no decision for the object", () => {
    const result = materializeDelegatedAuthority({
      agentPrincipal: { subjectType: "agent", subjectId: "executor" },
      actorPrincipal: { subjectType: "contact", subjectId: "luis" },
      surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      agentCapabilities: [cap("execute", "group", "*")],
      actorCapabilities: [cap("execute", "group", "sessions_info")],
      surfaceCapabilities: [],
    });

    expect(allows(result.effectiveCapabilities, "execute", "group", "sessions_info")).toBe(true);
    expect(allows(result.effectiveCapabilities, "execute", "group", "whatsapp_group_create")).toBe(false);
  });

  it("vetoes via an explicit deny on any branch", () => {
    const result = materializeDelegatedAuthority({
      agentPrincipal: { subjectType: "agent", subjectId: "executor" },
      actorPrincipal: { subjectType: "contact", subjectId: "luis" },
      surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      agentCapabilities: [cap("execute", "group", "*")],
      actorCapabilities: [cap("execute", "group", "sessions_info")],
      surfaceCapabilities: [cap("deny_execute", "group", "sessions_info")],
    });

    expect(allows(result.effectiveCapabilities, "execute", "group", "sessions_info")).toBe(false);
  });

  it("bounds the surface to constraint capabilities when present", () => {
    const result = materializeDelegatedAuthority({
      agentPrincipal: { subjectType: "agent", subjectId: "executor" },
      actorPrincipal: { subjectType: "contact", subjectId: "luis" },
      surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      agentCapabilities: [cap("execute", "group", "*")],
      actorCapabilities: [cap("execute", "group", "sessions_info"), cap("execute", "group", "whatsapp_group_create")],
      surfaceCapabilities: [
        cap("constrain", "role", "public-chat"),
        expandedConstraintCap("execute", "group", "sessions_info"),
      ],
    });

    expect(allows(result.effectiveCapabilities, "execute", "group", "sessions_info")).toBe(true);
    expect(allows(result.effectiveCapabilities, "execute", "group", "whatsapp_group_create")).toBe(false);
  });

  it("lets surface delegation override satisfy both actor and surface branches without exceeding the agent", () => {
    const result = materializeDelegatedAuthority({
      agentPrincipal: { subjectType: "agent", subjectId: "executor" },
      actorPrincipal: { subjectType: "contact", subjectId: "luis" },
      surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      agentCapabilities: [cap("use", "tool", "Bash")],
      actorCapabilities: [],
      surfaceCapabilities: [],
      surfaceDelegationOverrides: [cap("use", "tool", "Bash")],
    });

    expect(allows(result.effectiveCapabilities, "use", "tool", "Bash")).toBe(true);
  });

  it("does not let a delegation override exceed the executor agent ceiling", () => {
    const result = materializeDelegatedAuthority({
      agentPrincipal: { subjectType: "agent", subjectId: "executor" },
      actorPrincipal: { subjectType: "contact", subjectId: "luis" },
      surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      agentCapabilities: [],
      actorCapabilities: [],
      surfaceCapabilities: [],
      surfaceDelegationOverrides: [cap("use", "tool", "Bash")],
    });

    expect(allows(result.effectiveCapabilities, "use", "tool", "Bash")).toBe(false);
  });

  it("does not apply human delegation overrides for automation actors", () => {
    const result = materializeDelegatedAuthority({
      agentPrincipal: { subjectType: "agent", subjectId: "executor" },
      actorPrincipal: { subjectType: "automation", subjectId: "cron:job-1" },
      surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      agentCapabilities: [cap("use", "tool", "Bash")],
      actorCapabilities: [],
      surfaceCapabilities: [],
      surfaceDelegationOverrides: [cap("use", "tool", "Bash")],
    });

    expect(allows(result.effectiveCapabilities, "use", "tool", "Bash")).toBe(false);
  });

  it("intersects without a surface branch when none is provided", () => {
    const effective = buildEffectiveCapabilities({
      agentCapabilities: [cap("use", "tool", "*")],
      actorCapabilities: [cap("use", "tool", "Bash")],
    });

    expect(canWithCapabilities(effective, "use", "tool", "Bash")).toBe(true);
    expect(canWithCapabilities(effective, "use", "tool", "Read")).toBe(false);
  });
});
