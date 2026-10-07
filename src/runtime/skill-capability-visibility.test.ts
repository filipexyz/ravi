import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeContext } from "./context-registry.js";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { dbUpsertSkillGrant, getOrCreateSession } from "../router/index.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import * as providerRuntime from "../permissions/provider-runtime.js";
import { SkillsCommands } from "../cli/commands/skills.js";
import * as skillManager from "../skills/manager.js";
import { discoverSkills, withResolvedSkillSource } from "../skills/manager.js";
import { ContractError } from "../cli/agent-contract.js";
import { runWithContext } from "../cli/context.js";
import { evaluateSkillGate, runtimeSkillGateForCommand, runtimeSkillGateForTool } from "./skill-gate.js";
import { createRuntimeHostServices } from "./host-services.js";
import { isSkillAuthorizedForAgent } from "./skill-authorization.js";
import { resolveAgentSkills } from "./allowed-skills.js";
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
    // Same logical skill: after the gate delivers it, command/tool aliases proceed.
    expect(allow.allowed).toBe(true);
    expect(tool.allowed).toBe(true);
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
    expect(show.reason).toBe(
      "SKILL_NOT_AUTHORIZED: Skill 'ravi-system-permissions-manager' is not authorized for agent 'restricted'. " +
        "It ships with Ravi, so there is nothing to install: grant it " +
        "('ravi skills grant restricted permissions-manager') or give the agent the " +
        "'use:skill:permissions-manager' capability. Granting needs mutate:skills:grant; " +
        "if this agent cannot run it, ask an operator.",
    );

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
    const envelopeError = (thrown as InstanceType<typeof ContractError>).envelope().error;
    expect(envelopeError.code).toBe("SKILL_NOT_AUTHORIZED");
    expect(envelopeError.message).toBe("Skill 'permissions-manager' is not authorized for agent 'restricted'.");
    expect(envelopeError.suggestedAction).toContain("ravi skills grant restricted permissions-manager");
    expect(envelopeError.issues).toEqual([
      { path: [], code: "SKILL_NOT_AUTHORIZED", message: envelopeError.message },
      { path: ["suggestedAction"], code: "SUGGESTED_ACTION", message: envelopeError.suggestedAction },
    ]);

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
      reason:
        "SKILL_NOT_AUTHORIZED: Skill 'ravi-system-permissions-manager' is not authorized for agent 'restricted'. " +
        "It ships with Ravi, so there is nothing to install: grant it " +
        "('ravi skills grant restricted permissions-manager') or give the agent the " +
        "'use:skill:permissions-manager' capability. Granting needs mutate:skills:grant; " +
        "if this agent cannot run it, ask an operator.",
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
      runWithContext({ transport: "tool", agentId }, () =>
        commands.show("permissions-manager", undefined, undefined, true),
      ),
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

describe("full-access and use:skill capabilities reach every skill Ravi knows", () => {
  function bindSession(agentId: string, sessionName: string, capabilities: ContextCapability[]) {
    getOrCreateSession(`agent:${agentId}:main`, agentId, stateDir!, { name: sessionName, runtimeProvider: "codex" });
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId,
      sessionKey: `agent:${agentId}:main`,
      sessionName,
      capabilities,
    });
    const services = createRuntimeHostServices({ context, agentId, sessionName, toolContext: {} });
    return { context, services };
  }

  it("lets a full-access agent read bases and catalog skills no command gate maps", () => {
    const agentId = "full-access-main";
    createAgent(agentId, { runtimePermissions: { profile: "full-access" } });

    const materialized = materializeSubjectCapabilities("agent", agentId);
    expect(canWithCapabilities(materialized, "use", "skill", "*")).toBe(true);
    for (const skill of ["bases", "ravi-system-bases", "ravi-system:bases", "crm-manager", "app-creator"]) {
      expect(isSkillAuthorizedForAgent(agentId, skill)).toBe(true);
    }
    // Skills that only exist on disk still need `skills install` first.
    expect(isSkillAuthorizedForAgent(agentId, "made-up-disk-only-skill")).toBe(false);

    const shown = withoutLogs(() =>
      runWithContext(
        {
          transport: "tool",
          agentId,
          context: createRuntimeContext({ kind: "agent-runtime", agentId, capabilities: materialized }),
        },
        () => new SkillsCommands().show("bases", undefined, undefined, true),
      ),
    );
    expect(shown.skill.name).toBe("bases");
  });

  it("delivers the bases skill on the first `ravi bases` call, then lets the retry through", async () => {
    const agentId = "full-access-main";
    createAgent(agentId, { runtimePermissions: { profile: "full-access" } });
    const { services } = bindSession(agentId, "bases-gate", materializeSubjectCapabilities("agent", agentId));

    const show = await services.authorizeCommandExecution({ command: "ravi skills show bases --json", input: {} });
    expect(String(show.reason ?? "")).not.toContain("SKILL_NOT_AUTHORIZED");

    const first = await services.authorizeCommandExecution({ command: "ravi bases list --json", input: {} });
    expect(first.approved).toBe(false);
    expect(first.reason).toContain("RAVI_SKILL_REQUIRED: Bash requires skill ravi-system-bases.");
    const retry = await services.authorizeCommandExecution({ command: "ravi bases list --json", input: {} });
    expect(retry.approved).toBe(true);
  });

  it("honors use:skill capabilities with the tool/group matcher and announces only concrete ones", () => {
    const agentId = "skill-caps";
    createAgent(agentId, {
      runtimePermissions: { capabilities: ["use:skill:ravi-system:bases", "use:skill:ravi-dev-*"] },
    });

    expect(isSkillAuthorizedForAgent(agentId, "bases")).toBe(true);
    expect(isSkillAuthorizedForAgent(agentId, "ravi-system-bases")).toBe(true);
    expect(isSkillAuthorizedForAgent(agentId, "app-creator")).toBe(true);
    expect(isSkillAuthorizedForAgent(agentId, "ravi-dev-cli-creator")).toBe(true);
    expect(isSkillAuthorizedForAgent(agentId, "crm-manager")).toBe(false);

    const resolved = resolveAgentSkills(agentId);
    expect(resolved.provenance.fromCapabilities).toContain("bases");
    expect(resolved.allowlist).toContain("bases");
    // Globs authorize reads but never widen the advertised catalog.
    expect(resolved.allowlist).not.toContain("app-creator");
    expect(resolved.allowlist).not.toContain("ravi-dev-app-creator");

    const wildcard = [cap("use", "skill", "*")];
    createAgent("restricted-wildcard");
    expect(isSkillAuthorizedForAgent("restricted-wildcard", "crm-manager")).toBe(false);
    expect(isSkillAuthorizedForAgent("restricted-wildcard", "crm-manager", { capabilities: wildcard })).toBe(true);
    // Any use:skill capability, a wildcard included, configures the agent, so
    // it never falls back to grandfathered reads of disk-only skills.
    expect(resolveAgentSkills("restricted-wildcard", { capabilitiesOverride: wildcard }).hasConfiguration).toBe(true);
    expect(
      resolveAgentSkills("restricted-wildcard", { capabilitiesOverride: [cap("use", "tool", "Bash")] })
        .hasConfiguration,
    ).toBe(false);
    const materialize = providerRuntime.materializeSubjectCapabilities;
    const wildcardOnly = spyOn(providerRuntime, "materializeSubjectCapabilities").mockImplementation(
      (subjectType, subjectId) => (subjectId === "wildcard-only" ? wildcard : materialize(subjectType, subjectId)),
    );
    try {
      expect(isSkillAuthorizedForAgent("wildcard-only", "crm-manager")).toBe(true);
      expect(isSkillAuthorizedForAgent("wildcard-only", "made-up-disk-only-skill")).toBe(false);
    } finally {
      wildcardOnly.mockRestore();
    }
    for (const wrongVerb of [cap("execute", "skill", "*"), cap("read", "skill", "bases")]) {
      createAgent(`wrong-verb-${wrongVerb.permission}`);
      expect(
        isSkillAuthorizedForAgent(`wrong-verb-${wrongVerb.permission}`, "crm-manager", { capabilities: [wrongVerb] }),
      ).toBe(false);
    }
  });

  it("keeps a narrowed turn's capabilities as the ceiling for a full-access agent", async () => {
    const agentId = "full-access-overlay";
    createAgent(agentId, { runtimePermissions: { profile: "full-access" } });
    // A contact chat overlay keeps Bash and `skills show` but not use:skill:*.
    const narrowed = [cap("use", "tool", "Bash"), cap("execute", "executable", "ravi"), cap("read", "skills", "show")];

    expect(isSkillAuthorizedForAgent(agentId, "crm-manager")).toBe(true);
    expect(isSkillAuthorizedForAgent(agentId, "crm-manager", { capabilities: narrowed })).toBe(false);
    // A concrete use:skill:<id> puts the name on the agent's allowlist; the turn still decides.
    createAgent("concrete-skill-cap", { runtimePermissions: { capabilities: ["use:skill:crm-manager"] } });
    expect(resolveAgentSkills("concrete-skill-cap").allowlist).toContain("crm-manager");
    expect(isSkillAuthorizedForAgent("concrete-skill-cap", "crm-manager")).toBe(true);
    expect(isSkillAuthorizedForAgent("concrete-skill-cap", "crm-manager", { capabilities: narrowed })).toBe(false);
    dbUpsertSkillGrant({ agentId: "concrete-skill-cap", skillName: "crm-manager" });
    expect(isSkillAuthorizedForAgent("concrete-skill-cap", "crm-manager", { capabilities: narrowed })).toBe(true);

    const { services } = bindSession(agentId, "overlay", narrowed);
    const show = await services.authorizeCommandExecution({ command: "ravi skills show crm-manager", input: {} });
    expect(show.approved).toBe(false);
    expect(show.reason).toContain("SKILL_NOT_AUTHORIZED: Skill 'crm-manager' is not authorized");
  });

  function writeSkill(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Same name, other content.\n---\n\nBody.\n`);
    return dir;
  }

  function showAs(agentId: string, name: string, source?: string): unknown {
    const capabilities = materializeSubjectCapabilities("agent", agentId);
    const context = createRuntimeContext({ kind: "agent-runtime", agentId, capabilities });
    return withoutLogs(() =>
      runWithContext({ transport: "tool", agentId, context }, () =>
        new SkillsCommands().show(name, source, undefined, true),
      ),
    );
  }

  function showOutcome(agentId: string, name: string, source?: string): string {
    try {
      showAs(agentId, name, source);
      return "allowed";
    } catch (error) {
      if (error instanceof ContractError) return error.envelope().error.code;
      throw error;
    }
  }

  function showDenialAction(agentId: string, name: string, source?: string): string | undefined {
    try {
      showAs(agentId, name, source);
      return undefined;
    } catch (error) {
      if (error instanceof ContractError) return error.envelope().error.suggestedAction;
      throw error;
    }
  }

  it("never lets a Ravi skill name cover same-named content from --source", () => {
    createAgent("skill-wildcard", { runtimePermissions: { capabilities: ["use:skill:*"] } });
    // With a grant, a generic execute:group:* dump keeps official skills off the
    // allowlist, so pages is reached only through name-based command implication.
    createAgent("pages-group", { runtimePermissions: { capabilities: ["execute:group:*"] } });
    dbUpsertSkillGrant({ agentId: "pages-group", skillName: "gmail-pack" });
    expect(resolveAgentSkills("pages-group").allowlist).not.toContain("pages");
    // An explicit grant puts the name itself on the allowlist.
    createAgent("crm-grant");
    dbUpsertSkillGrant({ agentId: "crm-grant", skillName: "crm-manager" });

    for (const agentId of ["skill-wildcard", "crm-grant"]) {
      expect(showOutcome(agentId, "crm-manager")).toBe("allowed");
    }
    expect(showOutcome("pages-group", "pages")).toBe("allowed");

    const lookalikes = join(stateDir!, "lookalike");
    const crm = writeSkill(join(lookalikes, "crm-manager"), "crm-manager");
    const pages = writeSkill(join(lookalikes, "pages"), "pages");
    for (const agentId of ["skill-wildcard", "crm-grant"]) {
      expect(showOutcome(agentId, "crm-manager", crm)).toBe("SKILL_NOT_AUTHORIZED");
    }
    expect(showOutcome("pages-group", "pages", pages)).toBe("SKILL_NOT_AUTHORIZED");
    expect(showDenialAction("crm-grant", "crm-manager", crm)).toBe(
      "This --source content is not Ravi's own 'crm-manager' skill, and a grant or capability for that name " +
        "covers only Ravi's copy: read it without --source, or install this source " +
        "('ravi skills install --source <skill-dir>') and grant it.",
    );
  });

  it("covers an installed skill read from its own directory under a grant, use:skill:* and admin, nothing else", () => {
    const name = "installed-origin-check";
    const installedDir = writeSkill(join(stateDir!, "installed", name), name);
    const [installed] = withResolvedSkillSource(installedDir, (resolved) => discoverSkills(resolved));
    // The installed list lives under the OS home; stand in for it with this one skill.
    const installedSpy = spyOn(skillManager, "listInstalledSkills").mockImplementation(() => [
      { ...installed!, source: "plugin:ravi-user-skills", pluginName: "ravi-user-skills" },
    ]);
    try {
      const other = writeSkill(join(stateDir!, "other", name), name);
      createAgent("skill-wildcard", { runtimePermissions: { capabilities: ["use:skill:*"] } });
      createAgent("skill-admin", { runtimePermissions: { capabilities: ["admin:system:*"] } });
      createAgent("skill-grant");
      dbUpsertSkillGrant({ agentId: "skill-grant", skillName: name });
      for (const agentId of ["skill-wildcard", "skill-admin", "skill-grant"]) {
        expect(showOutcome(agentId, name, installedDir)).toBe("allowed");
        expect(showOutcome(agentId, name, other)).toBe("SKILL_NOT_AUTHORIZED");
      }
      // Denied on the installed copy itself, the agent only lacks the grant.
      createAgent("skill-none");
      expect(showDenialAction("skill-none", name, installedDir)).toContain("It is already installed in Ravi: grant it");
    } finally {
      installedSpy.mockRestore();
    }
  });

  it("matches an installed skill that shares a catalog skill's name to its own directory", () => {
    const name = "crm-manager";
    const installedDir = writeSkill(join(stateDir!, "installed", name), name);
    const [installed] = withResolvedSkillSource(installedDir, (resolved) => discoverSkills(resolved));
    const installedSpy = spyOn(skillManager, "listInstalledSkills").mockImplementation(() => [
      { ...installed!, source: "plugin:ravi-user-skills", pluginName: "ravi-user-skills" },
    ]);
    try {
      const other = writeSkill(join(stateDir!, "other", name), name);
      createAgent("skill-wildcard", { runtimePermissions: { capabilities: ["use:skill:*"] } });
      createAgent("skill-grant");
      dbUpsertSkillGrant({ agentId: "skill-grant", skillName: name });
      for (const agentId of ["skill-wildcard", "skill-grant"]) {
        expect(showOutcome(agentId, name, installedDir)).toBe("allowed");
        expect(showOutcome(agentId, name, other)).toBe("SKILL_NOT_AUTHORIZED");
      }
    } finally {
      installedSpy.mockRestore();
    }
  });

  it("tells a same-line remediation that the grant never ran", async () => {
    const agentId = "restricted";
    createAgent(agentId);
    const { services } = bindSession(agentId, "same-line", [cap("use", "tool", "Bash")]);

    const chained = await services.authorizeCommandExecution({
      command: "ravi skills grant restricted crm-manager && ravi skills show crm-manager",
      input: {},
    });
    expect(chained.approved).toBe(false);
    expect(chained.reason).toBe(
      "SKILL_NOT_AUTHORIZED: Skill 'crm-manager' is not authorized for agent 'restricted'. " +
        "It ships with Ravi, so there is nothing to install: grant it " +
        "('ravi skills grant restricted crm-manager') or give the agent the 'use:skill:crm-manager' capability. " +
        "Granting needs mutate:skills:grant; if this agent cannot run it, ask an operator. " +
        "This shell line also reads the skill, so it was rejected as a whole and the grant did not run: " +
        "run the grant as its own command first.",
    );

    const alone = await services.authorizeCommandExecution({ command: "ravi skills show crm-manager", input: {} });
    expect(alone.reason).toContain("SKILL_NOT_AUTHORIZED");
    expect(alone.reason).not.toContain("rejected as a whole");
  });
});
