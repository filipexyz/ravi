import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeContext } from "./context-registry.js";
import {
  dbUpsertSkillGateRule,
  dbUpsertSkillGrant,
  getOrCreateSession,
  getSession,
  resetSessionIfUnchanged,
} from "../router/index.js";
import { dbUpdateAgent } from "../router/router-db.js";
import {
  flushPermissionAuditEvents,
  listPermissionDenials,
  setPermissionAuditPublisherForTest,
} from "../permissions/denials.js";
import {
  evaluateSkillGate,
  runtimeSkillGateForCommand,
  runtimeSkillGateForTool,
} from "./skill-gate.js";
import { createRuntimeHostServices } from "./host-services.js";
import type { RuntimeSkillVisibilitySnapshot } from "./types.js";

let stateDir: string | null = null;
let previousCodexHome: string | undefined;

beforeEach(async () => {
  previousCodexHome = process.env.CODEX_HOME;
  stateDir = await createIsolatedRaviState("ravi-skill-gate-");
  process.env.CODEX_HOME = join(stateDir, "codex");
});

afterEach(async () => {
  setPermissionAuditPublisherForTest();
  if (previousCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = previousCodexHome;
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function writeCodexSkill(name: string): void {
  const dir = join(process.env.CODEX_HOME!, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n\nUse this skill before running the tool.\n`,
  );
}

describe("evaluateSkillGate", () => {
  it("soft-gates a missing skill, delivers it, and marks it loaded for the session", () => {
    writeCodexSkill("demo-skill");
    // Custom skills must be granted to the agent (Invariant G,
    // spec skills/scoping/per-agent-visibility) before the gate delivers them.
    dbUpsertSkillGrant({ agentId: "main", skillName: "demo-skill" });
    getOrCreateSession("agent:main:main", "main", stateDir!, {
      name: "skill-gate-test",
      runtimeProvider: "codex",
      providerSessionId: "thread-1",
      runtimeSessionDisplayId: "thread-1",
    });
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionName: "skill-gate-test",
    });

    const first = evaluateSkillGate({
      gate: { skill: "demo-skill", source: "config" },
      context,
      toolName: "demo_run",
    });

    expect(first.allowed).toBe(false);
    expect(first.code).toBe("RAVI_SKILL_REQUIRED");
    expect(first.reason).toContain("# demo-skill");

    const persisted = getSession("agent:main:main")?.runtimeSessionParams
      ?.skillVisibility as RuntimeSkillVisibilitySnapshot;
    expect(persisted.loadedSkills).toEqual(["demo-skill"]);

    const second = evaluateSkillGate({
      gate: { skill: "demo-skill", source: "config" },
      context,
      toolName: "demo_run",
    });

    expect(second.allowed).toBe(true);
  });

  it("reports configuration errors distinctly when the declared skill does not exist", () => {
    // Grant a made-up skill to isolate this test from the Invariant G
    // (per-agent visibility) allowlist check: we want to exercise the branch
    // where the skill is allowed to the agent but not installed/publish-ed.
    dbUpsertSkillGrant({ agentId: "main", skillName: "missing-skill" });
    getOrCreateSession("agent:main:main", "main", stateDir!, { name: "skill-gate-test", runtimeProvider: "codex" });
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionName: "skill-gate-test",
    });

    const decision = evaluateSkillGate({
      gate: { skill: "missing-skill", source: "config" },
      context,
      toolName: "demo_run",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("RAVI_SKILL_GATE_CONFIG_ERROR");
    expect(decision.reason).toContain("no installed or catalog skill provides it");
  });

  it("resolves flexible operator-configured gates for tools and external CLI commands", () => {
    dbUpsertSkillGateRule({ id: "external-lookup", tool: "external_lookup", skill: "external-skill" });
    dbUpsertSkillGateRule({ id: "github-issue", commandPrefix: "gh issue", skill: "github" });

    const toolGate = runtimeSkillGateForTool("external_lookup");
    if (!toolGate) {
      throw new Error("Expected external_lookup to resolve a configured skill gate.");
    }
    expect(toolGate).toMatchObject({
      skill: "external-skill",
      source: "config",
    });
    expect(Object.prototype.hasOwnProperty.call(toolGate, "variant")).toBe(false);
    expect(runtimeSkillGateForCommand("gh issue view 123")).toMatchObject({
      skill: "github",
      source: "config",
    });
  });

  it("applies operator overrides and removals to default Ravi group gates", () => {
    dbUpsertSkillGateRule({ id: "image", skill: "custom-image-skill" });
    dbUpsertSkillGateRule({ id: "tasks", disabled: true });
    dbUpsertSkillGateRule({ id: "linear", pattern: "^linear(?:[._]|$)", skill: "linear-skill" });

    expect(runtimeSkillGateForTool("image_generate")).toMatchObject({
      skill: "custom-image-skill",
      source: "config",
      ruleId: "image",
    });
    expect(runtimeSkillGateForTool("tasks_list")).toBeUndefined();
    expect(runtimeSkillGateForCommand("ravi tasks list")).toBeUndefined();
    expect(runtimeSkillGateForTool("linear_issue_list")).toMatchObject({
      skill: "linear-skill",
      source: "config",
    });
  });

  it("infers Ravi CLI gates from parsed commands without matching quoted text", () => {
    expect(runtimeSkillGateForCommand("bin/ravi commands list --agent dev --json")).toMatchObject({
      skill: "ravi-system-commands",
      source: "inferred",
      ruleId: "commands",
    });
    expect(runtimeSkillGateForCommand("bin/ravi skill-gates list --json")).toMatchObject({
      skill: "ravi-system-skill-gates",
      source: "inferred",
      ruleId: "skill-gates",
    });
    expect(runtimeSkillGateForCommand("bin/ravi apps guide --json")).toMatchObject({
      skill: "ravi-system-apps",
      source: "inferred",
      ruleId: "apps",
    });
    expect(runtimeSkillGateForCommand("bin/ravi context codex-bash-hook")).toBeUndefined();
    expect(runtimeSkillGateForCommand('echo "ravi tasks list"')).toBeUndefined();
  });
});

describe("runtime host skill-gate enforcement", () => {
  for (const ownershipChange of ["reset", "redirect"] as const) {
    it(`does not persist or publish skill state after a ${ownershipChange} ownership race`, async () => {
      writeCodexSkill("ravi-system-image");
      dbUpdateAgent("main", {
        defaults: { runtimePermissions: { capabilities: ["execute:group:image_generate"] } },
      });
      const admitted = getOrCreateSession("agent:main:main", "main", stateDir!, {
        name: "skill-gate-test",
        runtimeProvider: "codex",
        providerSessionId: "thread-1",
        runtimeSessionDisplayId: "thread-1",
      });
      const context = createRuntimeContext({
        kind: "agent-runtime",
        agentId: "main",
        sessionKey: admitted.sessionKey,
        sessionName: "skill-gate-test",
        capabilities: [{ permission: "use", objectType: "tool", objectId: "image_generate", source: "test" }],
      });
      let callbackSnapshot: RuntimeSkillVisibilitySnapshot | undefined;
      const services = createRuntimeHostServices({
        context,
        admittedSession: admitted,
        agentId: "main",
        sessionName: "skill-gate-test",
        toolContext: {},
        onSkillGatePersisted: (skillVisibility) => {
          callbackSnapshot = skillVisibility;
        },
      });
      if (ownershipChange === "reset") {
        expect(resetSessionIfUnchanged(admitted)).toBe(true);
      } else {
        const redirected = getOrCreateSession(admitted.sessionKey, "redirected-agent", join(stateDir!, "redirected"));
        expect(redirected.lifecycleGeneration).toBe(admitted.lifecycleGeneration! + 1);
      }

      const result = await services.executeDynamicTool({
        toolName: "image_generate",
        arguments: { prompt: "dry-run stale skill gate" },
      });

      expect(result.success).toBe(false);
      expect(result.reason).toContain("session ownership changed");
      expect(callbackSnapshot).toBeUndefined();
      expect(admitted.runtimeSessionParams).toBeUndefined();
      expect(getSession(admitted.sessionKey)?.runtimeSessionParams?.skillVisibility).toBeUndefined();
    });
  }

  it("never persists or publishes the full command denied by native runtime policy", async () => {
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const auditEvents: Array<Record<string, unknown>> = [];
    setPermissionAuditPublisherForTest(async (_topic, data) => {
      auditEvents.push(data);
    });
    getOrCreateSession("agent:main:main", "main", stateDir!, {
      name: "skill-gate-test",
      runtimeProvider: "codex",
    });
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionName: "skill-gate-test",
      capabilities: [{ permission: "use", objectType: "tool", objectId: "Bash", source: "test" }],
    });
    const services = createRuntimeHostServices({
      context,
      agentId: "main",
      sessionName: "skill-gate-test",
      toolContext: {},
    });
    const command = 'bash -c "printf SENTINEL_SECRET_7M4Q"';

    try {
      const decision = await services.authorizeCommandExecution({ command, input: {} });
      await flushPermissionAuditEvents();

      expect(decision.approved).toBe(false);
      expect(listPermissionDenials({ subjectType: "agent", subjectId: "main" })[0]?.command).toBe(
        `[REDACTED:content length=${command.length}]`,
      );
      expect(auditEvents[0]?.command).toBe(`[REDACTED:content length=${command.length}]`);
      expect(JSON.stringify(auditEvents)).not.toContain("SENTINEL_SECRET_7M4Q");
    } finally {
      setPermissionAuditPublisherForTest();
    }
  });

  it("delivers and marks a required skill loaded when a dynamic tool is attempted", async () => {
    writeCodexSkill("ravi-system-image");
    // System skills are visible through provider-owned group capabilities. The
    // tool-local context permission below authorizes execution but must not
    // accidentally become the agent's persisted skill allowlist.
    dbUpdateAgent("main", {
      defaults: { runtimePermissions: { capabilities: ["execute:group:image_generate"] } },
    });
    getOrCreateSession("agent:main:main", "main", stateDir!, {
      name: "skill-gate-test",
      runtimeProvider: "codex",
      providerSessionId: "thread-1",
      runtimeSessionDisplayId: "thread-1",
    });
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionName: "skill-gate-test",
      capabilities: [{ permission: "use", objectType: "tool", objectId: "image_generate", source: "test" }],
    });
    let callbackSnapshot: RuntimeSkillVisibilitySnapshot | undefined;
    const services = createRuntimeHostServices({
      context,
      agentId: "main",
      sessionName: "skill-gate-test",
      toolContext: {},
      onSkillGatePersisted: (skillVisibility) => {
        callbackSnapshot = skillVisibility;
      },
    });

    const result = await services.executeDynamicTool({
      toolName: "image_generate",
      arguments: { prompt: "dry-run skill gate check" },
    });

    expect(result.success).toBe(false);
    const contentItem = result.contentItems[0];
    expect(contentItem?.type).toBe("inputText");
    if (contentItem?.type !== "inputText") {
      throw new Error("Expected skill gate to return text content.");
    }
    expect(contentItem.text).toContain("RAVI_SKILL_REQUIRED: image_generate requires skill ravi-system-image");
    expect(contentItem.text).toContain("# ravi-system-image");
    expect(callbackSnapshot?.loadedSkills).toEqual(["ravi-system-image"]);

    const persisted = getSession("agent:main:main")?.runtimeSessionParams
      ?.skillVisibility as RuntimeSkillVisibilitySnapshot;
    expect(persisted.loadedSkills).toEqual(["ravi-system-image"]);
  });

  it("checks Bash permission before delivering a required skill", async () => {
    writeCodexSkill("ravi-system-daemon-manager");
    getOrCreateSession("agent:main:main", "main", stateDir!, {
      name: "skill-gate-test",
      runtimeProvider: "codex",
      providerSessionId: "thread-1",
      runtimeSessionDisplayId: "thread-1",
    });
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionName: "skill-gate-test",
    });
    const services = createRuntimeHostServices({
      context,
      agentId: "main",
      sessionName: "skill-gate-test",
      toolContext: {},
    });

    const decision = await services.authorizeCommandExecution({
      command: "ravi daemon status",
      input: {},
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).not.toContain("RAVI_SKILL_REQUIRED");
    expect(decision.reason).toContain("No approval source available");
    expect(getSession("agent:main:main")?.runtimeSessionParams?.skillVisibility).toBeUndefined();
  });

  it("does not infer a Ravi skill gate from quoted Bash text", async () => {
    writeCodexSkill("ravi-system-tasks");
    getOrCreateSession("agent:main:main", "main", stateDir!, {
      name: "skill-gate-test",
      runtimeProvider: "codex",
      providerSessionId: "thread-1",
      runtimeSessionDisplayId: "thread-1",
    });
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionName: "skill-gate-test",
      capabilities: [
        { permission: "use", objectType: "tool", objectId: "Bash", source: "test" },
        { permission: "execute", objectType: "executable", objectId: "echo", source: "test" },
      ],
    });
    const services = createRuntimeHostServices({
      context,
      agentId: "main",
      sessionName: "skill-gate-test",
      toolContext: {},
    });

    const decision = await services.authorizeCommandExecution({
      command: 'echo "ravi tasks list"',
      input: {},
    });

    expect(decision.approved).toBe(true);
    expect(getSession("agent:main:main")?.runtimeSessionParams?.skillVisibility).toBeUndefined();
  });

  it("keeps executable grants bounded to the issued agent-runtime context", async () => {
    getOrCreateSession("agent:main:main", "main", stateDir!, {
      name: "permission-live-grant-test",
      runtimeProvider: "codex",
      providerSessionId: "thread-1",
      runtimeSessionDisplayId: "thread-1",
    });
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionName: "permission-live-grant-test",
      capabilities: [{ permission: "use", objectType: "tool", objectId: "Bash", source: "test" }],
    });
    const services = createRuntimeHostServices({
      context,
      agentId: "main",
      sessionName: "permission-live-grant-test",
      toolContext: {},
    });

    const decision = await services.authorizeCommandExecution({
      command: "git status",
      input: {},
    });

    expect(decision.approved).toBe(false);
  });
});
