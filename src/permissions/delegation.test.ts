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

// The subagent tool goes by two names, `Task` and `Agent`. The composition keeps a grant that no deny overlaps and drops
// a whole grant that one does, so a deny has to overlap a grant under either name, patterns included.
describe("the subagent tool in a governed chat", () => {
  const names = ["Task", "Agent"] as const;
  const use = (objectId: string) => cap("use", "tool", objectId);
  const deny = (objectId: string) => cap("deny_use", "tool", objectId);
  const compose = (actor: ContextCapability[], agent: ContextCapability[] = [use("*")]) =>
    buildEffectiveCapabilities({ agentCapabilities: agent, actorCapabilities: actor });
  const reaches = (effective: ContextCapability[], toolName: string) => allows(effective, "use", "tool", toolName);

  it("lets a deny withhold a grant that reaches the subagent under the other name", () => {
    const pairs = [
      ["Task", "Agent"],
      ["Agent", "Task"],
      ["Task", "Ag*"],
      ["Agent", "Task*"],
      ["Ag*", "Task"],
      ["Task*", "Agent"],
      // Neither pattern covers the other; both reach the subagent tool.
      ["Ag*", "Task*"],
      ["Task*", "Ag*"],
      ["Age*", "Ta*"],
      ["A*", "T*"],
    ] as const;
    for (const [granted, denied] of pairs) {
      const effective = compose([use(granted), deny(denied)]);
      for (const name of names)
        expect(reaches(effective, name), `grant ${granted}, deny ${denied}: ${name}`).toBe(false);
    }
  });

  it("withholds the subagent on a surface deny of the other name through the whole builder", () => {
    for (const [granted, denied] of [
      ["Ag*", "Task*"],
      ["Task*", "Ag*"],
    ] as const) {
      const result = materializeDelegatedAuthority({
        agentPrincipal: { subjectType: "agent", subjectId: "executor" },
        actorPrincipal: { subjectType: "contact", subjectId: "luis" },
        surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
        agentCapabilities: [use("*")],
        actorCapabilities: [use(granted)],
        surfaceCapabilities: [deny(denied)],
      });
      for (const name of names) {
        expect(reaches(result.effectiveCapabilities, name), `grant ${granted}, surface deny ${denied}: ${name}`).toBe(
          false,
        );
      }
    }
  });

  it("keeps a grant that no deny reaches, and opens both names on it", () => {
    for (const name of names) {
      expect(reaches(compose([use("Ag*"), deny("Bash*")]), name)).toBe(true);
      expect(reaches(compose([use("Task*"), deny("Bash*")]), name)).toBe(true);
    }
    // Another tool of the Task family is not the subagent: a deny of the subagent leaves its grant alone.
    const effective = compose([use("TaskOutput"), deny("Agent")]);
    expect(reaches(effective, "TaskOutput")).toBe(true);
    expect(reaches(effective, "Agent")).toBe(false);
  });

  it("lets a deny win over an explicit grant, whichever name each one uses", () => {
    for (const granted of names) {
      for (const denied of names) {
        const effective = compose([use(granted), deny(denied)]);
        for (const name of names)
          expect(reaches(effective, name), `grant ${granted}, deny ${denied}: ${name}`).toBe(false);
      }
    }
  });

  it("drops a whole prefix grant that overlaps the denied subagent, as it does for a deny under its own name", () => {
    const underItsOwnName = compose([use("Task*"), deny("Task")]);
    const underTheOtherName = compose([use("Task*"), deny("Agent")]);

    expect(underTheOtherName).toEqual(underItsOwnName);
    // The composition fails closed for a prefix that covers the denied tool: the other Task tools go with it.
    expect(reaches(underTheOtherName, "TaskOutput")).toBe(false);
  });

  it("intersects exact names across the two names", () => {
    const effective = compose([use("Agent")], [use("Task")]);

    for (const name of names) expect(reaches(effective, name)).toBe(true);
    expect(reaches(effective, "TaskOutput")).toBe(false);
  });

  it("leaves the intersection of two prefix grants that reach different names empty: grant the exact name", () => {
    const effective = compose([use("Ag*")], [use("Task*")]);

    for (const name of names) expect(reaches(effective, name)).toBe(false);
  });

  it("renames tool objects only: session patterns of the same spelling stay apart", () => {
    const effective = buildEffectiveCapabilities({
      agentCapabilities: [cap("access", "session", "*")],
      actorCapabilities: [cap("access", "session", "Ag*"), cap("deny_access", "session", "Task*")],
    });

    expect(allows(effective, "access", "session", "Agent-1")).toBe(true);
  });
});
