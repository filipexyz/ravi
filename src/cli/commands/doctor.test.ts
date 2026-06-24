import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectDoctor, runDoctor } from "./doctor.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeHealthyDeps() {
  const home = makeTempDir("ravi-doctor-home-");
  const stateDir = join(home, ".ravi");
  const cwd = "/repo";
  const providerRuntimePath = join(cwd, "src", "permissions", "provider-runtime.ts");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ravi.db"), "");
  writeFileSync(join(stateDir, "insights.db"), "");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "^(Bash|shell)$",
              hooks: [
                {
                  type: "command",
                  command: "ravi context codex-bash-hook",
                  statusMessage: "ravi codex bash permission gate",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );

  return {
    inspectCliRuntimeTarget: () => ({
      cliExecPath: "/usr/local/bin/ravi",
      cliBundlePath: "/repo/dist/bundle/index.js",
      dbPath: join(stateDir, "ravi.db"),
      daemon: {
        online: true,
        execPath: "/repo/dist/bundle/index.js",
        cwd: "/repo",
        matchesCli: true,
      },
      instance: null,
    }),
    getRaviStateDir: () => stateDir,
    getRaviDbPath: () => join(stateDir, "ravi.db"),
    dbListAgents: () =>
      [
        { id: "main", cwd: "/agents/main", provider: "claude" },
        { id: "codex-dev", cwd: "/agents/codex-dev", provider: "codex" },
      ] as any,
    dbListInstances: () =>
      [
        {
          name: "main",
          enabled: true,
          channel: "whatsapp",
          instanceId: "inst_main",
          dmPolicy: "open",
          groupPolicy: "open",
          createdAt: 1,
          updatedAt: 1,
        },
      ] as any,
    dbListRoutes: () => [] as any,
    getDefaultAgentId: () => "main",
    inspectAgentInstructionFiles: () => ({
      state: "agents-canonical" as const,
      agents: null,
      claude: null,
    }),
    listTaskAutomations: () =>
      [
        { id: "a1", enabled: true },
        { id: "a2", enabled: false },
      ] as any,
    getRuntimeCompatibilityIssues: () => [],
    listRegisteredRuntimeProviderIds: () => ["codex", "claude"] as any,
    getConfiguredPermissionProviders: () => [{ id: "operator-control" }, { id: "context-capabilities" }] as any,
    getConfiguredCapabilityMaterializers: () =>
      [
        { id: "runtime-bootstrap" },
        { id: "agent-default-capabilities" },
        { id: "agent-identity-permissions" },
        { id: "contact-policy-permissions" },
      ] as any,
    authorizePermission: () => ({ allowed: false, reasonCode: "missing_subject" }) as any,
    localOperatorCan: () => true,
    materializeSubjectCapabilities: (subjectType: string, subjectId: string) =>
      subjectType === "agent" && subjectId === "main"
        ? [{ permission: "view", objectType: "agent", objectId: "*" }]
        : [],
    checkAppManifests: () => [] as any,
    discoverAppManifests: () => [] as any,
    getRegistry: () => ({ commands: [] }) as any,
    currentWeakPublicReturnCommands: () => [],
    currentCliOnlyCommands: () => [],
    queryRows: (sql: string) => {
      if (sql.includes("sqlite_master")) {
        return [
          { name: "agents" },
          { name: "instances" },
          { name: "routes" },
          { name: "chats" },
          { name: "message_metadata" },
          { name: "cost_events" },
          { name: "session_turns" },
          { name: "schema_migrations" },
        ] as any;
      }
      if (sql.includes("PRAGMA user_version")) {
        return [{ user_version: 1 }] as any;
      }
      if (sql.includes("message_metadata")) {
        return [{ total: 0, unresolved_actor: 0, unresolved_owner: 0 }] as any;
      }
      if (sql.includes("COUNT(*) AS total")) {
        return [{ total: 0 }] as any;
      }
      return [] as any;
    },
    listSpecFiles: () => [],
    listSkillFiles: () => [],
    getGitInfo: () => ({ branch: "main", commit: "abc123", dirty: false, ahead: 0, behind: 0 }),
    exists: (path: string) =>
      [
        stateDir,
        join(stateDir, "ravi.db"),
        join(stateDir, "insights.db"),
        join(home, ".codex", "hooks.json"),
        providerRuntimePath,
      ].includes(path),
    readFile: (path: string) =>
      path === providerRuntimePath
        ? 'import { contextCapabilitiesProvider } from "./context-capabilities-provider.js";'
        : readFileSync(path, "utf8"),
    readDir: () => [] as any,
    homeDir: () => home,
    cwd: () => cwd,
    now: () => new Date("2026-06-08T12:00:00.000Z"),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("inspectDoctor", () => {
  it("reports a healthy runtime when all critical substrates are in place", async () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor(deps);

    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "runtime.daemon")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "codex.bash-hook")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "agents.instructions")?.status).toBe("pass");
    expect(report.findings.find((finding) => finding.id === "tasks.automations")?.summary).toContain(
      "2 task automations",
    );
    expect(report.findings.every((finding) => finding.severity !== "error")).toBe(true);
  });

  it("surfaces fail and warn states when critical config is missing or divergent", () => {
    const home = makeTempDir("ravi-doctor-bad-home-");
    const stateDir = join(home, ".ravi");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ravi.db"), "");

    const report = inspectDoctor({
      inspectCliRuntimeTarget: () => ({
        cliExecPath: "/old/bin/ravi",
        cliBundlePath: "/old/dist/bundle/index.js",
        dbPath: join(stateDir, "ravi.db"),
        daemon: {
          online: false,
          execPath: null,
          cwd: null,
          matchesCli: null,
        },
        instance: null,
      }),
      getRaviStateDir: () => stateDir,
      getRaviDbPath: () => join(stateDir, "ravi.db"),
      dbListAgents: () =>
        [
          { id: "legacy", cwd: "/agents/legacy", provider: "claude" },
          { id: "broken", cwd: "/agents/broken", provider: "codex" },
        ] as any,
      dbListInstances: () => [] as any,
      dbListRoutes: () => [] as any,
      inspectAgentInstructionFiles: (cwd: string) =>
        ({
          state: cwd.includes("legacy") ? "legacy-claude-canonical" : "divergent-custom-both",
          agents: null,
          claude: null,
        }) as any,
      listTaskAutomations: () => [] as any,
      getRuntimeCompatibilityIssues: (provider) =>
        provider === "codex"
          ? [
              {
                code: "restricted_tool_access_unsupported",
                message: "codex cannot do restricted access",
              },
            ]
          : [],
      checkAppManifests: () => [] as any,
      discoverAppManifests: () => [] as any,
      getRegistry: () => ({ commands: [] }) as any,
      currentWeakPublicReturnCommands: () => [],
      currentCliOnlyCommands: () => [],
      queryRows: (sql: string) => {
        if (sql.includes("sqlite_master")) {
          return [] as any;
        }
        if (sql.includes("PRAGMA user_version")) {
          return [{ user_version: 0 }] as any;
        }
        if (sql.includes("message_metadata")) {
          return [{ total: 0, unresolved_actor: 0, unresolved_owner: 0 }] as any;
        }
        if (sql.includes("COUNT(*) AS total")) {
          return [{ total: 0 }] as any;
        }
        return [] as any;
      },
      listSpecFiles: () => [],
      listSkillFiles: () => [],
      getGitInfo: () => ({ branch: "main", commit: "abc123", dirty: false, ahead: 0, behind: 0 }),
      exists: (path: string) => path === stateDir || path === join(stateDir, "ravi.db"),
      readFile: () => "",
      readDir: () => [] as any,
      homeDir: () => home,
      cwd: () => "/repo",
      now: () => new Date("2026-06-08T12:00:00.000Z"),
    });

    expect(report.summary.errors).toBeGreaterThan(0);
    expect(report.summary.warnings).toBeGreaterThan(0);
    expect(report.checks.find((check) => check.id === "runtime.daemon")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "substrate.insights-db")?.severity).toBe("warn");
    expect(report.checks.find((check) => check.id === "codex.bash-hook")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "agents.instructions")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "runtime.providers")?.status).toBe("fail");
  });

  it("does not flag mutating public commands that declare command access metadata", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      getRegistry: () =>
        ({
          commands: [
            {
              fullName: "demo.create",
              scope: "open",
              returns: true,
              access: { kind: "mutate", resource: "demo", action: "create", risk: "medium" },
            },
          ],
        }) as any,
    });

    expect(report.checks.find((check) => check.id === "permissions.command_mutation_unclassified")?.status).toBe(
      "pass",
    );
    expect(report.checks.find((check) => check.id === "permissions.command_access.coverage")?.data).toMatchObject({
      publicCommands: 1,
      annotated: 1,
      missing: 0,
    });
  });

  it("fails mutation metadata when a mutating action is declared as read access", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      getRegistry: () =>
        ({
          commands: [
            {
              fullName: "daemon.restart",
              scope: "open",
              returns: true,
              access: { kind: "read", resource: "daemon", action: "restart", risk: "low" },
            },
          ],
        }) as any,
    });

    const check = report.checks.find((item) => item.id === "permissions.command_mutation_unclassified");
    expect(check?.status).toBe("fail");
    expect(check?.data).toMatchObject({
      total: 1,
      readMutating: ["daemon.restart"],
    });
  });

  it("does not flag explicitly allowlisted read-only commands with mutating-looking names", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      getRegistry: () =>
        ({
          commands: [
            {
              fullName: "crm.pipeline.policy.send-window-check",
              scope: "open",
              returns: true,
              access: { kind: "read", resource: "crm.pipeline.policy", action: "send-window-check", risk: "low" },
            },
          ],
        }) as any,
    });

    const check = report.checks.find((item) => item.id === "permissions.command_mutation_unclassified");
    expect(check?.status).toBe("pass");
    expect(check?.data).toMatchObject({ total: 0 });
  });

  it("fails command access coverage when a public command lacks metadata", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      getRegistry: () =>
        ({
          commands: [
            {
              fullName: "demo.list",
              scope: "open",
              returns: true,
            },
          ],
        }) as any,
    });

    expect(report.checks.find((check) => check.id === "permissions.command_access.coverage")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "permissions.command_access.coverage")?.data).toMatchObject({
      publicCommands: 1,
      annotated: 0,
      missing: 1,
    });
  });
});

describe("runDoctor", () => {
  it("prints JSON output when requested", () => {
    const deps = makeHealthyDeps();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      runDoctor({ json: true }, deps);
    } finally {
      console.log = originalLog;
    }

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] ?? "{}");
    expect(payload.summary.errors).toBe(0);
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.checks)).toBe(true);
    expect(payload.checks.some((check: { id: string }) => check.id === "codex.bash-hook")).toBe(true);
    expect(Array.isArray(payload.findings)).toBe(true);
  });
});
