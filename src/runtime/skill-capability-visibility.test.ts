import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeContext } from "./context-registry.js";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { dbUpsertSkillGrant, getOrCreateSession } from "../router/index.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { SkillsCommands } from "../cli/commands/skills.js";
import { ContractError } from "../cli/agent-contract.js";
import { runWithContext } from "../cli/context.js";
import { evaluateSkillGate, runtimeSkillGateForCommand, runtimeSkillGateForTool } from "./skill-gate.js";
import { createRuntimeHostServices } from "./host-services.js";
import { isSkillAuthorizedForAgent } from "./skill-authorization.js";
import { authorizePiToolCall } from "./pi-tool-permissions.js";
import type { ContextCapability } from "../router/router-db.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-skill-cap-vis-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId, source: "test" };
}

function createAgent(id: string, defaults?: Record<string, unknown>) {
  dbCreateAgent({ id, cwd: `/tmp/${id}` });
  if (defaults) {
    dbUpdateAgent(id, { defaults });
  }
}

function withoutLogs<T>(run: () => T): T {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return run();
  } finally {
    console.log = originalLog;
  }
}

describe("capability-aware official skill visibility", () => {
  it("maps permissions and pages command aliases to the same official skills", () => {
    expect(runtimeSkillGateForCommand("ravi permissions --help")).toMatchObject({
      skill: "ravi-system-permissions-manager",
    });
    expect(runtimeSkillGateForCommand("ravi permissions allow docs --apply --json")).toMatchObject({
      skill: "ravi-system-permissions-manager",
    });
    expect(runtimeSkillGateForTool("permissions_allow")).toMatchObject({
      skill: "ravi-system-permissions-manager",
    });
    expect(runtimeSkillGateForCommand("ravi pages --help")).toMatchObject({
      skill: "ravi-system-pages",
    });
    expect(runtimeSkillGateForTool("pages_ship")).toMatchObject({
      skill: "ravi-system-pages",
    });
  });

  it("lets an admin identity with a custom grant load permissions-manager instead of CONFIG_ERROR", () => {
    const agentId = "codex-admin";
    createAgent(agentId, { runtimePermissions: { profile: "full-access" } });
    dbUpsertSkillGrant({ agentId, skillName: "gmail-pack" });
    getOrCreateSession(`agent:${agentId}:main`, agentId, stateDir!, {
      name: "admin-visibility",
      runtimeProvider: "codex",
      providerSessionId: "thread-admin",
      runtimeSessionDisplayId: "thread-admin",
    });
    const capabilities = [
      cap("admin", "system", "*"),
      cap("mutate", "permissions", "allow"),
      cap("use", "tool", "Bash"),
    ];
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId,
      sessionKey: `agent:${agentId}:main`,
      sessionName: "admin-visibility",
      capabilities,
    });

    expect(isSkillAuthorizedForAgent(agentId, "ravi-system-permissions-manager", { capabilities })).toBe(true);
    expect(isSkillAuthorizedForAgent(agentId, "permissions-manager", { capabilities })).toBe(true);

    const help = evaluateSkillGate({
      gate: runtimeSkillGateForCommand("ravi permissions --help"),
      context,
      toolName: "Bash",
    });
    const allow = evaluateSkillGate({
      gate: runtimeSkillGateForCommand("ravi permissions allow docs --json"),
      context,
      toolName: "Bash",
    });
    const tool = evaluateSkillGate({
      gate: runtimeSkillGateForTool("permissions_allow"),
      context,
      toolName: "permissions_allow",
    });

    expect(help.allowed).toBe(false);
    expect(help.code).toBe("RAVI_SKILL_REQUIRED");
    expect(help.skill).toBe("ravi-system-permissions-manager");
    expect(allow.code).toBe("RAVI_SKILL_REQUIRED");
    expect(tool.code).toBe("RAVI_SKILL_REQUIRED");
  });

  it("lets mutate:pages:ship load pages while keeping permissions-manager denied", () => {
    const agentId = "pages-worker";
    createAgent(agentId, {
      runtimePermissions: { capabilities: ["mutate:pages:ship"] },
    });
    dbUpsertSkillGrant({ agentId, skillName: "gmail-pack" });
    getOrCreateSession(`agent:${agentId}:main`, agentId, stateDir!, {
      name: "pages-visibility",
      runtimeProvider: "codex",
    });
    const capabilities = [cap("mutate", "pages", "ship"), cap("use", "tool", "Bash")];
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId,
      sessionKey: `agent:${agentId}:main`,
      sessionName: "pages-visibility",
      capabilities,
    });

    const pages = evaluateSkillGate({
      gate: runtimeSkillGateForCommand("ravi pages --help"),
      context,
      toolName: "Bash",
    });
    const permissions = evaluateSkillGate({
      gate: runtimeSkillGateForCommand("ravi permissions --help"),
      context,
      toolName: "Bash",
    });

    expect(pages.code).toBe("RAVI_SKILL_REQUIRED");
    expect(permissions.code).toBe("RAVI_SKILL_GATE_CONFIG_ERROR");
    expect(permissions.reason).toContain("not visible");
  });

  it("keeps unauthorized identities denied across host, CLI, and Pi aliases", async () => {
    const agentId = "restricted";
    createAgent(agentId);
    dbUpsertSkillGrant({ agentId, skillName: "gmail-pack" });
    getOrCreateSession(`agent:${agentId}:main`, agentId, stateDir!, {
      name: "restricted-visibility",
      runtimeProvider: "codex",
    });
    const capabilities = [cap("use", "tool", "Bash")];
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId,
      sessionKey: `agent:${agentId}:main`,
      sessionName: "restricted-visibility",
      capabilities,
    });
    const services = createRuntimeHostServices({
      context,
      agentId,
      sessionName: "restricted-visibility",
      toolContext: {},
    });

    const help = await services.authorizeCommandExecution({
      command: "ravi permissions --help",
      input: {},
    });
    expect(help.approved).toBe(false);
    expect(help.reason).toContain("RAVI_SKILL_GATE_CONFIG_ERROR");

    const show = await services.authorizeCommandExecution({
      command: "ravi skills show ravi-system-permissions-manager --json",
      input: {},
    });
    expect(show.approved).toBe(false);
    expect(show.reason).toContain("SKILL_NOT_AUTHORIZED");

    const commands = new SkillsCommands();
    let thrown: unknown;
    try {
      withoutLogs(() =>
        runWithContext({ transport: "tool", agentId, context }, () =>
          commands.show("ravi-system-permissions-manager", undefined, undefined, true),
        ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as InstanceType<typeof ContractError>).envelope().error.code).toBe("SKILL_NOT_AUTHORIZED");

    await expect(
      authorizePiToolCall(
        "Skill",
        { skill: "ravi-system-permissions-manager" },
        {
          canUseTool: async () => ({ behavior: "allow" }),
          allowedSkills: ["gmail-pack"],
          agentId,
          capabilities,
        },
      ),
    ).resolves.toEqual({
      allowed: false,
      reason: "SKILL_NOT_AUTHORIZED: Skill not authorized for agent: ravi-system-permissions-manager",
    });
  });

  it("authorizes official lookup for an admin identity on catalog aliases", () => {
    const agentId = "alias-admin";
    createAgent(agentId, { runtimePermissions: { profile: "full-access" } });
    dbUpsertSkillGrant({ agentId, skillName: "gmail-pack" });
    const commands = new SkillsCommands();
    const shown = withoutLogs(() =>
      runWithContext({ transport: "tool", agentId }, () =>
        commands.show("ravi-system-permissions-manager", undefined, undefined, true),
      ),
    );
    expect(shown.skill.name).toBe("permissions-manager");

    const short = withoutLogs(() =>
      runWithContext({ transport: "tool", agentId }, () => commands.show("permissions-manager", undefined, undefined, true)),
    );
    expect(short.skill.name).toBe("permissions-manager");
  });

  it("never grants mutate:permissions:allow just because the skill is visible", () => {
    const agentId = "docs-only";
    createAgent(agentId);
    dbUpsertSkillGrant({ agentId, skillName: "ravi-system-permissions-manager" });

    expect(isSkillAuthorizedForAgent(agentId, "ravi-system-permissions-manager")).toBe(true);
    const materialized = materializeSubjectCapabilities("agent", agentId);
    expect(canWithCapabilities(materialized, "mutate", "permissions", "allow")).toBe(false);
    expect(canWithCapabilities(materialized, "admin", "system", "*")).toBe(false);
  });

  it("authorizes Pi official skill use from identity capabilities, not only the advertised allowlist", async () => {
    const agentId = "pi-admin";
    createAgent(agentId, { runtimePermissions: { profile: "full-access" } });
    dbUpsertSkillGrant({ agentId, skillName: "gmail-pack" });

    await expect(
      authorizePiToolCall(
        "Skill",
        { skill: "ravi-system-permissions-manager" },
        {
          canUseTool: async () => ({ behavior: "allow" }),
          allowedSkills: ["gmail-pack"],
          agentId,
          capabilities: [cap("admin", "system", "*"), cap("mutate", "permissions", "allow")],
        },
      ),
    ).resolves.toEqual({ allowed: true });
  });
});
