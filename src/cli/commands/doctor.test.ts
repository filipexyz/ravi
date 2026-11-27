import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsExposureReport } from "../../security/nats-exposure.js";
import type { OmniDbAuthReport } from "../../security/omni-db-auth.js";
import type { StateDirPermissionsInspection } from "../../security/state-dir-permissions.js";
import { PREPARE_STATE_COMMAND } from "../../db/state-readiness.js";
import type { ManagedRuntimeMemberIdentity } from "../../managed-runtime.js";
import { runnerReleaseGuardAdapter } from "../../channels/runner-release-status.js";
import {
  buildChannelRunnerReleaseCheck,
  buildNativeChannelRuntimeCheck,
  inspectDoctor,
  probeDoctorRunnerAdapters,
  runDoctor,
} from "./doctor.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function natsReport(overrides: Partial<NatsExposureReport> = {}): NatsExposureReport {
  return {
    status: "loopback_only",
    natsUrl: "nats://127.0.0.1:4222",
    host: "127.0.0.1",
    port: 4222,
    reachableAddresses: [],
    authRequired: null,
    tlsRequired: null,
    firewall: "on",
    message: "NATS port 4222 is not reachable on any non-loopback address",
    remediation: [],
    ...overrides,
  };
}

function stateDirPermissions(
  path: string,
  overrides: Partial<StateDirPermissionsInspection> = {},
): StateDirPermissionsInspection {
  return {
    path,
    supported: true,
    exists: true,
    isDirectory: true,
    isSymlink: false,
    ownedByCurrentUser: true,
    mode: 0o700,
    modeOctal: "0700",
    groupOrOtherAccess: false,
    setgid: false,
    ...overrides,
  };
}

const EXPOSED_NATS = natsReport({
  status: "exposed",
  reachableAddresses: ["192.168.1.10:4222"],
  authRequired: false,
  tlsRequired: false,
  firewall: "off",
  message: "NATS port 4222 accepts unauthenticated connections from the network (192.168.1.10:4222)",
  remediation: ["bind nats-server to loopback: start it with `-a 127.0.0.1`", "enable the host firewall"],
});

function makeHealthyDeps() {
  const home = makeTempDir("ravi-doctor-home-");
  const stateDir = join(home, ".ravi");
  const tempDir = join(home, "tmp");
  mkdirSync(tempDir, { recursive: true });
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
    inspectExecutionPlane: () =>
      ({
        plane: "host",
        runtimeContext: false,
        hostEvidence: { stateDir: true, sqliteDb: true, cloudCredentials: true, cliGatewaySocket: false },
        markers: [],
        daemonIsolationLikely: false,
        sourceTree: true,
      }) as any,
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
    dbListCronJobs: () =>
      [
        {
          id: "cron-1",
          name: "Daily",
          enabled: true,
          agentId: "main",
          executionType: "agent",
          schedule: { type: "every", every: 1_800_000 },
          sessionTarget: "main",
          message: "hello",
          deleteAfterRun: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ] as any,
    dbGetAgent: (id: string) => (id === "main" || id === "codex-dev" ? { id } : null) as any,
    resolveSession: () => null as any,
    deriveSourceFromSessionKey: () => null as any,
    exists: (path: string) =>
      [
        stateDir,
        tempDir,
        cwd,
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
    tempDir: () => tempDir,
    statDisk: () => ({ totalBytes: 500 * 1024 ** 3, freeBytes: 200 * 1024 ** 3, deviceId: 66 }),
    probeDir: () => ({ ok: true }),
    probeNatsExposure: async () => natsReport(),
    probeOmniDatabaseAuth: async () => omniDbReport(),
    inspectStateDirPermissions: (path: string) => stateDirPermissions(path),
    inspectKnowledgeExposure: () => ({ ok: true, offenders: [], checkedAgents: 2 }),
    knowledgeSettings: () => knowledgeSettingsFixture(),
    resolveOwnerDirectTarget: () => ({
      channel: "whatsapp",
      accountId: "main",
      to: "5511999999999@s.whatsapp.net",
      chatId: "5511999999999@s.whatsapp.net",
      contactId: "c_owner",
    }),
    agentHasNoExec: () => true,
    codexKnowledgeParityHolds: () => true,
    listInboxSubscriptions: () => [{ id: "sub_1" }],
    inspectNativeChannelRuntime: () => ({ channels: [], runnerStatus: null }),
    inspectManagedRuntime: () => null,
    probeChannelRunnerAdapters: async () => null,
  };
}

function knowledgeSettingsFixture(overrides: Record<string, unknown> = {}) {
  return {
    contactMemoryAgents: [] as string[],
    project: null as string | null,
    curatorAgent: null as string | null,
    digestTime: "08:00",
    digestTimezone: "America/Sao_Paulo",
    ownerTarget: null as string | null,
    egressAllow: () => null,
    ...overrides,
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

  it("fails and rewrites a stale codex-tool-hook command", () => {
    const deps = makeHealthyDeps();
    const hooksPath = join(deps.homeDir(), ".codex", "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "^(Bash|shell)$",
                hooks: [
                  {
                    type: "command",
                    command: "ravi context codex-tool-hook",
                    statusMessage: "ravi codex native tool permission gate",
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

    const report = inspectDoctor(deps);
    const check = report.checks.find((item) => item.id === "codex.bash-hook");
    const finding = report.findings.find((item) => item.id === "codex.bash-hook");
    expect(check?.status).toBe("fail");
    expect(check?.data?.staleCommand).toBe(true);
    expect(finding?.summary).toContain("codex-tool-hook");
    expect(finding?.summary).toContain("codex-bash-hook");

    const rewritten = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(rewritten.hooks.PreToolUse).toHaveLength(1);
    expect(rewritten.hooks.PreToolUse[0]?.matcher).toBe("^(Bash|shell)$");
    expect(rewritten.hooks.PreToolUse[0]?.hooks[0]?.command).toContain("codex-bash-hook");
    expect(rewritten.hooks.PreToolUse[0]?.hooks[0]?.command).not.toContain("codex-tool-hook");
  });

  it("fails and repairs an invalid PreToolUse matcher", () => {
    const deps = makeHealthyDeps();
    const hooksPath = join(deps.homeDir(), ".codex", "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "^(Bash|shell|exec_command|view_image)$",
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

    const report = inspectDoctor(deps);
    const check = report.checks.find((item) => item.id === "codex.bash-hook");
    const finding = report.findings.find((item) => item.id === "codex.bash-hook");
    expect(check?.status).toBe("fail");
    expect(check?.data?.matcherOk).toBe(false);
    expect(finding?.summary).toContain("^(Bash|shell)$");

    const rewritten = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(rewritten.hooks.PreToolUse[0]?.matcher).toBe("^(Bash|shell)$");
  });

  it("accepts a custom authorization chain made of registered providers", () => {
    const deps = makeHealthyDeps();
    deps.getConfiguredPermissionProviders = () => [{ id: "operator-control" }, { id: "external-authority" }] as any;
    const report = inspectDoctor(deps);
    const check = report.checks.find((item) => item.id === "permissions.provider_runtime_default_chain");
    expect(check?.status).toBe("pass");
    expect(check?.data?.customAuthorization).toBe(true);
  });

  it("fails the authorization chain check when operator-control is missing", () => {
    const deps = makeHealthyDeps();
    deps.getConfiguredPermissionProviders = () => [{ id: "external-authority" }] as any;
    const report = inspectDoctor(deps);
    const check = report.checks.find((item) => item.id === "permissions.provider_runtime_default_chain");
    expect(check?.status).toBe("fail");
  });

  it("fails the authorization chain check when a configured provider is unregistered", () => {
    const deps = makeHealthyDeps();
    deps.getConfiguredPermissionProviders = () => [{ id: "operator-control" }, { id: "unavailable:nao-existe" }] as any;
    const report = inspectDoctor(deps);
    const check = report.checks.find((item) => item.id === "permissions.provider_runtime_default_chain");
    expect(check?.status).toBe("fail");
    expect(check?.data?.unavailableAuthorization).toEqual(["unavailable:nao-existe"]);
  });

  it("passes the disk/temp pressure check when free space is healthy", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor(deps);
    const check = report.checks.find((item) => item.id === "runtime.disk_space_low");
    expect(check?.status).toBe("pass");
    expect(check?.domain).toBe("runtime");
    expect(check?.data?.thresholds).toMatchObject({
      criticalFreeBytes: 1 * 1024 ** 3,
      warnFreeBytes: 5 * 1024 ** 3,
    });
    const targets = (check?.data?.targets ?? []) as Array<{ label: string; writeProbeOk: boolean }>;
    expect(targets.map((t) => t.label).sort()).toEqual(["cwd", "state", "temp"]);
    expect(targets.every((t) => t.writeProbeOk)).toBe(true);
  });

  it("warns the disk/temp pressure check when free space is below the operational margin", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      statDisk: () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 4 * 1024 ** 3, deviceId: 66 }),
    });
    const check = report.checks.find((item) => item.id === "runtime.disk_space_low");
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("warn");
  });

  it("errors the disk/temp pressure check when free space is critically low", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      statDisk: () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 512 * 1024 ** 2, deviceId: 66 }),
    });
    const check = report.checks.find((item) => item.id === "runtime.disk_space_low");
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("error");
    expect(report.summary.errors).toBeGreaterThan(0);
  });

  it("errors the disk/temp pressure check when a directory cannot pass the write/remove smoke test", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      probeDir: (path: string) =>
        path === deps.tempDir() ? { ok: false, error: "ENOSPC: no space left on device" } : { ok: true },
    });
    const check = report.checks.find((item) => item.id === "runtime.disk_space_low");
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("error");
    const targets = (check?.data?.targets ?? []) as Array<{ label: string; writeProbeOk: boolean; severity: string }>;
    expect(targets.find((t) => t.label === "temp")?.writeProbeOk).toBe(false);
    expect(targets.find((t) => t.label === "temp")?.severity).toBe("fail");
  });

  it("redacts home-relative paths in the disk/temp pressure evidence", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor(deps);
    const check = report.checks.find((item) => item.id === "runtime.disk_space_low");
    const targets = (check?.data?.targets ?? []) as Array<{ label: string; path: string }>;
    expect(targets.find((t) => t.label === "state")?.path.startsWith("~/")).toBe(true);
  });

  it("returns the disk/temp pressure check under the runtime domain filter", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor(deps, { domain: "runtime" });
    expect(report.checks.some((item) => item.id === "runtime.disk_space_low")).toBe(true);
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
      inspectExecutionPlane: () =>
        ({
          plane: "host",
          runtimeContext: false,
          hostEvidence: { stateDir: true, sqliteDb: true, cloudCredentials: false, cliGatewaySocket: false },
          markers: [],
          daemonIsolationLikely: false,
          sourceTree: false,
        }) as any,
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

  it("reports cron targets with stale agents as fail", () => {
    const deps = makeHealthyDeps();
    deps.dbListCronJobs = () =>
      [
        {
          id: "cron-stale",
          name: "Stale Job",
          enabled: true,
          agentId: "deleted-agent",
          executionType: "agent",
          schedule: { type: "every", every: 1_800_000 },
          sessionTarget: "main",
          message: "hello",
          deleteAfterRun: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ] as any;
    deps.dbGetAgent = () => null as any;

    const report = inspectDoctor(deps);
    const cronCheck = report.checks.find((check) => check.id === "cron.targets");
    expect(cronCheck).toBeDefined();
    expect(cronCheck!.status).toBe("fail");
    const findings = (cronCheck!.data as any).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("cron.agent_missing");
    expect(findings[0].fixHint).toContain("ravi cron show");
  });

  it("reports derived-key routing as warn", () => {
    const deps = makeHealthyDeps();
    deps.dbListCronJobs = () =>
      [
        {
          id: "cron-derived",
          name: "Derived Job",
          enabled: true,
          agentId: "main",
          executionType: "agent",
          replySession: "agent:main:whatsapp:main:group:123",
          schedule: { type: "every", every: 1_800_000 },
          sessionTarget: "main",
          message: "hello",
          deleteAfterRun: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ] as any;
    deps.resolveSession = () => null as any;
    deps.deriveSourceFromSessionKey = () => ({
      channel: "whatsapp",
      accountId: "main",
      chatId: "group:123",
    });

    const report = inspectDoctor(deps);
    const cronCheck = report.checks.find((check) => check.id === "cron.targets");
    expect(cronCheck).toBeDefined();
    expect(cronCheck!.status).toBe("pass");
    expect(cronCheck!.severity).toBe("warn");
    const findings = (cronCheck!.data as any).findings;
    expect(findings[0].id).toBe("cron.routing_derived_key");
  });

  it("reports ok when all cron targets are valid", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor(deps);
    const cronCheck = report.checks.find((check) => check.id === "cron.targets");
    expect(cronCheck).toBeDefined();
    expect(cronCheck!.status).toBe("pass");
  });

  it("reports ok when no enabled crons exist", () => {
    const deps = makeHealthyDeps();
    deps.dbListCronJobs = () => [] as any;

    const report = inspectDoctor(deps);
    const cronCheck = report.checks.find((check) => check.id === "cron.targets");
    expect(cronCheck).toBeDefined();
    expect(cronCheck!.status).toBe("pass");
    expect(report.findings.find((finding) => finding.id === "cron.targets")?.summary).toContain("no enabled");
  });

  it("shell jobs without notification targets are ok, not agent_missing", () => {
    const deps = makeHealthyDeps();
    deps.dbListCronJobs = () =>
      [
        {
          id: "cron-shell",
          name: "Shell Job",
          enabled: true,
          agentId: "ghost",
          executionType: "shell",
          shellCommand: "echo ok",
          schedule: { type: "every", every: 1_800_000 },
          sessionTarget: "main",
          message: "",
          deleteAfterRun: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ] as any;
    deps.dbGetAgent = () => null as any;

    const report = inspectDoctor(deps);
    const cronCheck = report.checks.find((check) => check.id === "cron.targets");
    expect(cronCheck).toBeDefined();
    expect(cronCheck!.status).toBe("pass");
  });

  it("does not fail restricted providers for unused built-in pi", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      listRegisteredRuntimeProviderIds: () => ["codex", "claude", "pi"] as any,
      dbListAgents: () => [{ id: "main", cwd: "/agents/main", provider: "codex" }] as any,
      getRuntimeCompatibilityIssues: (provider) =>
        provider === "pi"
          ? [
              {
                code: "restricted_tool_access_unsupported",
                message:
                  "Runtime provider 'pi' requires full tool and executable access because Ravi permission hooks are unsupported",
              },
            ]
          : [],
    });

    expect(report.checks.find((check) => check.id === "runtime.providers")?.status).toBe("pass");
    expect(JSON.stringify(report.checks.find((check) => check.id === "runtime.providers"))).not.toContain("pi");
  });

  it("does not treat a sandboxed daemon probe as host-offline", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      inspectCliRuntimeTarget: () => ({
        ...deps.inspectCliRuntimeTarget(),
        daemon: { online: false, execPath: null, cwd: null, matchesCli: null },
      }),
      inspectExecutionPlane: () =>
        ({
          plane: "provider-sandbox",
          runtimeContext: true,
          hostEvidence: { stateDir: true, sqliteDb: true, cloudCredentials: true, cliGatewaySocket: true },
          markers: ["codex-sandbox", "runtime-context-key"],
          daemonIsolationLikely: true,
          sourceTree: false,
        }) as any,
    });

    const daemon = report.checks.find((check) => check.id === "runtime.daemon");
    const isolation = report.checks.find((check) => check.id === "runtime.isolation");
    expect(daemon?.status).toBe("skip");
    expect(daemon?.severity).toBe("warn");
    expect(daemon?.data).toMatchObject({ isolated: true, plane: "provider-sandbox" });
    expect(isolation?.status).toBe("pass");
    expect(isolation?.severity).toBe("warn");
    expect(JSON.stringify(isolation)).not.toContain("pi");
  });

  it("skips provider-runtime source checks outside a Ravi source tree", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      cwd: () => "/agents/main",
      exists: (path: string) => path === deps.getRaviStateDir() || path === deps.getRaviDbPath(),
    });

    expect(report.checks.find((check) => check.id === "permissions.provider_runtime_boundaries")?.status).toBe("skip");
  });

  it("reports chat-only ceiling honestly", () => {
    const deps = makeHealthyDeps();
    const unused = inspectDoctor(deps);
    expect(unused.checks.find((check) => check.id === "permissions.chat_only_ceiling")?.status).toBe("pass");
    expect(unused.findings.find((finding) => finding.id === "permissions.chat_only_ceiling")?.summary).toContain(
      "no chat-only agents configured",
    );

    const leaking = inspectDoctor({
      ...deps,
      dbListAgents: () =>
        [
          {
            id: "reception",
            cwd: "/agents/reception",
            provider: "claude",
            defaults: { runtimePermissions: { profile: "chat-only" } },
          },
        ] as any,
      materializeSubjectCapabilities: (subjectType: string) =>
        subjectType === "agent" ? [{ permission: "use", objectType: "tool", objectId: "*" }] : [],
    });
    expect(leaking.checks.find((check) => check.id === "permissions.chat_only_ceiling")?.status).toBe("fail");
    expect(leaking.findings.find((finding) => finding.id === "permissions.chat_only_ceiling")?.summary).toContain(
      "still materialize tool or exec authority",
    );

    const honest = inspectDoctor({
      ...deps,
      dbListAgents: () =>
        [
          {
            id: "reception",
            cwd: "/agents/reception",
            provider: "claude",
            defaults: { runtimePermissions: { profile: "chat-only" } },
          },
        ] as any,
      materializeSubjectCapabilities: () => [],
    });
    expect(honest.checks.find((check) => check.id === "permissions.chat_only_ceiling")?.status).toBe("pass");
    expect(honest.findings.find((finding) => finding.id === "permissions.chat_only_ceiling")?.summary).toContain(
      "1 chat-only agent",
    );
  });

  it("fails provider-runtime boundaries only inside a Ravi source tree", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor({
      ...deps,
      cwd: () => "/repo",
      exists: (path: string) =>
        path === "/repo/src/cli/commands/doctor.ts" ||
        path === "/repo/src/cli/commands/pages.ts" ||
        path === deps.getRaviStateDir() ||
        path === deps.getRaviDbPath(),
    });

    expect(report.checks.find((check) => check.id === "permissions.provider_runtime_boundaries")?.status).toBe("fail");
  });
});

function omniDbReport(overrides: Partial<OmniDbAuthReport> = {}): OmniDbAuthReport {
  return {
    status: "requires_credentials",
    databaseUrl: "postgresql://omni:***@127.0.0.1:5432/omni",
    host: "127.0.0.1",
    port: 5432,
    user: "omni",
    database: "omni",
    passwordlessAddresses: [],
    addresses: [{ address: "127.0.0.1", state: "password_required" }],
    message: 'Omni\'s database asks user "omni" for a password',
    remediation: [],
    ...overrides,
  };
}

const PASSWORDLESS_OMNI_DB: OmniDbAuthReport = omniDbReport({
  status: "no_password_login",
  databaseUrl: "postgresql://root@localhost:5432/omni",
  user: "root",
  passwordlessAddresses: ["127.0.0.1", "::1"],
  addresses: [
    { address: "127.0.0.1", state: "accepts_without_password" },
    { address: "::1", state: "accepts_without_password" },
  ],
  message: 'Omni\'s database lets user "root" log in to "omni" without a password on 127.0.0.1, ::1',
  remediation: ["replace the `trust` lines for Omni's database in pg_hba.conf with `scram-sha-256`"],
});

describe("doctor Omni database authentication check", () => {
  it("passes when Omni's database asks for a password", () => {
    const report = inspectDoctor(makeHealthyDeps(), { omniDbAuth: omniDbReport() });
    const check = report.checks.find((item) => item.id === "runtime.omni_db_auth");
    expect(check?.status).toBe("pass");
    expect(check?.domain).toBe("runtime");
    expect(report.summary.warnings).toBe(0);
  });

  it("warns when Omni's database lets its user in without a password, with remediation", () => {
    const report = inspectDoctor(makeHealthyDeps(), { omniDbAuth: PASSWORDLESS_OMNI_DB });
    const check = report.checks.find((item) => item.id === "runtime.omni_db_auth");
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("warn");
    expect(report.summary.warnings).toBe(1);
    const finding = report.findings.find((item) => item.id === "runtime.omni_db_auth");
    expect(finding?.fixHint).toContain("scram-sha-256");
    const labels = finding?.evidence.map((evidence) => evidence.label) ?? [];
    expect(labels).toContain("address ::1: accepts_without_password (plaintext probe, no TLS)");
    expect(finding?.data).toMatchObject({ status: "no_password_login", passwordlessAddresses: ["127.0.0.1", "::1"] });
  });

  it("skips when not probed, not configured, remote or unknown", () => {
    expect(inspectDoctor(makeHealthyDeps()).checks.find((item) => item.id === "runtime.omni_db_auth")?.status).toBe(
      "skip",
    );
    for (const status of ["not_configured", "remote", "unknown"] as const) {
      const report = inspectDoctor(makeHealthyDeps(), { omniDbAuth: omniDbReport({ status }) });
      expect(report.checks.find((item) => item.id === "runtime.omni_db_auth")?.status).toBe("skip");
      expect(report.summary.warnings).toBe(0);
    }
  });

  it("runs the async probe in runDoctor, only for the runtime domain, and survives a throwing probe", async () => {
    const deps = makeHealthyDeps();
    let probes = 0;
    const originalLog = console.log;
    console.log = () => {};
    try {
      const warned = await runDoctor(
        { json: true },
        {
          ...deps,
          probeOmniDatabaseAuth: async () => {
            probes++;
            return PASSWORDLESS_OMNI_DB;
          },
        },
      );
      expect(warned.checks.find((item) => item.id === "runtime.omni_db_auth")?.status).toBe("fail");
      await runDoctor(
        { json: true, domain: "apps" },
        {
          ...deps,
          probeOmniDatabaseAuth: async () => {
            probes++;
            return PASSWORDLESS_OMNI_DB;
          },
        },
      );
      const thrown = await runDoctor(
        { json: true },
        {
          ...deps,
          probeOmniDatabaseAuth: async () => {
            throw new Error("probe exploded");
          },
        },
      );
      expect(thrown.checks.find((item) => item.id === "runtime.omni_db_auth")?.status).toBe("skip");
    } finally {
      console.log = originalLog;
    }
    expect(probes).toBe(1);
  });
});

describe("doctor security checks", () => {
  it("passes NATS exposure and state dir permissions when private", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor(deps, { natsExposure: natsReport() });

    expect(report.summary.warnings).toBe(0);
    const nats = report.checks.find((check) => check.id === "runtime.nats_exposure");
    expect(nats?.status).toBe("pass");
    expect(nats?.domain).toBe("runtime");
    expect(report.checks.find((check) => check.id === "substrate.state-dir-permissions")?.status).toBe("pass");
  });

  it("skips the NATS exposure check when it was not probed", () => {
    const report = inspectDoctor(makeHealthyDeps());
    expect(report.checks.find((check) => check.id === "runtime.nats_exposure")?.status).toBe("skip");
  });

  it("warns when NATS is exposed to the network, with evidence and remediation", () => {
    const report = inspectDoctor(makeHealthyDeps(), { natsExposure: EXPOSED_NATS });

    const check = report.checks.find((item) => item.id === "runtime.nats_exposure");
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("warn");
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(1);

    const finding = report.findings.find((item) => item.id === "runtime.nats_exposure");
    const labels = finding?.evidence.map((evidence) => evidence.label) ?? [];
    expect(labels).toContain("status: exposed");
    expect(labels).toContain("reachable: 192.168.1.10:4222");
    expect(labels).toContain("host firewall: off");
    expect(labels.some((label) => label.includes("-a 127.0.0.1"))).toBe(true);
    expect(finding?.fixHint).toContain("-a 127.0.0.1");
    expect(finding?.data).toMatchObject({ status: "exposed", firewall: "off" });
  });

  it("warns when NATS is remote over plaintext", () => {
    const report = inspectDoctor(makeHealthyDeps(), {
      natsExposure: natsReport({ status: "remote_plaintext", message: "NATS is remote over plaintext" }),
    });
    const check = report.checks.find((item) => item.id === "runtime.nats_exposure");
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("warn");
  });

  it("does not warn when NATS is reachable but requires auth, or remote over TLS", () => {
    for (const status of ["exposed_auth_required", "remote"] as const) {
      const report = inspectDoctor(makeHealthyDeps(), { natsExposure: natsReport({ status }) });
      expect(report.checks.find((item) => item.id === "runtime.nats_exposure")?.status).toBe("pass");
      expect(report.summary.warnings).toBe(0);
    }
  });

  it("warns when the state dir has group/other permission bits", () => {
    const deps = makeHealthyDeps();
    const stateDir = deps.getRaviStateDir();
    const report = inspectDoctor({
      ...deps,
      inspectStateDirPermissions: (path: string) =>
        stateDirPermissions(path, { mode: 0o755, modeOctal: "0755", groupOrOtherAccess: true }),
    });

    const check = report.checks.find((item) => item.id === "substrate.state-dir-permissions");
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("warn");
    const finding = report.findings.find((item) => item.id === "substrate.state-dir-permissions");
    expect(finding?.evidence.map((evidence) => evidence.label)).toEqual([`path: ${stateDir}`, "mode: 0755"]);
    expect(finding?.fixHint).toContain(`chmod 700 ${stateDir}`);
    expect(finding?.data).toMatchObject({ path: stateDir, mode: "0755" });
  });

  it("skips state dir permissions when unsupported or missing", () => {
    const deps = makeHealthyDeps();
    for (const overrides of [{ supported: false }, { exists: false, mode: null, modeOctal: null }]) {
      const report = inspectDoctor({
        ...deps,
        inspectStateDirPermissions: (path: string) => stateDirPermissions(path, overrides),
      });
      expect(report.checks.find((item) => item.id === "substrate.state-dir-permissions")?.status).toBe("skip");
    }
  });
});

describe("runDoctor", () => {
  it("runs the async NATS probe and reports exposure", async () => {
    const deps = makeHealthyDeps();
    const originalLog = console.log;
    console.log = () => {};
    let report: Awaited<ReturnType<typeof runDoctor>>;
    try {
      report = await runDoctor({ json: true }, { ...deps, probeNatsExposure: async () => EXPOSED_NATS });
    } finally {
      console.log = originalLog;
    }
    expect(report.checks.find((item) => item.id === "runtime.nats_exposure")?.status).toBe("fail");
  });

  it("skips the NATS probe for unrelated domains and survives probe failures", async () => {
    const deps = makeHealthyDeps();
    let probes = 0;
    const originalLog = console.log;
    console.log = () => {};
    try {
      await runDoctor(
        { json: true, domain: "apps" },
        {
          ...deps,
          probeNatsExposure: async () => {
            probes++;
            return EXPOSED_NATS;
          },
        },
      );
      const report = await runDoctor(
        { json: true },
        {
          ...deps,
          probeNatsExposure: async () => {
            throw new Error("probe exploded");
          },
        },
      );
      expect(report.checks.find((item) => item.id === "runtime.nats_exposure")?.status).toBe("skip");
    } finally {
      console.log = originalLog;
    }
    expect(probes).toBe(0);
  });

  it("prints JSON output when requested", async () => {
    const deps = makeHealthyDeps();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      await runDoctor({ json: true }, deps);
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

  describe("knowledge checks", () => {
    function knowledgeChecks(report: ReturnType<typeof inspectDoctor>) {
      return {
        exposure: report.checks.find((check) => check.id === "permissions.knowledge_exposure"),
        f2: report.checks.find((check) => check.id === "knowledge.f2_setup"),
        f2Finding: report.findings.find((finding) => finding.id === "knowledge.f2_setup"),
      };
    }

    it("passes both checks with healthy deps", () => {
      const { exposure, f2 } = knowledgeChecks(inspectDoctor(makeHealthyDeps()));
      expect(exposure?.status).toBe("pass");
      expect(f2?.status).toBe("pass");
    });

    it("passes the F2 check when contact memory is configured", () => {
      const { f2 } = knowledgeChecks(
        inspectDoctor({
          ...makeHealthyDeps(),
          knowledgeSettings: () =>
            knowledgeSettingsFixture({ contactMemoryAgents: ["main"], project: "acme", curatorAgent: "main" }),
        } as any),
      );
      expect(f2?.status).toBe("pass");
    });

    it("fails the exposure check with an offender", () => {
      const report = inspectDoctor({
        ...makeHealthyDeps(),
        inspectKnowledgeExposure: () => ({
          ok: false,
          checkedAgents: 2,
          offenders: [
            { agentId: "main", profile: "bootstrap", reasons: ["instance main admits open DMs", "profile bootstrap"] },
          ],
        }),
      } as any);
      const { exposure } = knowledgeChecks(report);
      expect(exposure?.status).toBe("fail");
      expect(exposure?.severity).toBe("error");
      const finding = report.findings.find((item) => item.id === "permissions.knowledge_exposure");
      expect(finding?.fixHint).toContain("chat-only");
      expect(JSON.stringify(finding?.evidence)).toContain("agent:main");
      expect(report.ok).toBe(false);
    });

    it("warns when a shell automation runs code from an agent workspace", () => {
      const report = inspectDoctor({
        ...makeHealthyDeps(),
        dbListAgents: () => [{ id: "workflows", cwd: "/srv/agents/workflows" }],
        listShellAutomations: () => [
          { kind: "trigger", id: "t1", enabled: true, shellCommand: "cd /srv/agents/workflows && bun run.ts" },
        ],
      } as any);
      const check = report.checks.find((item) => item.id === "permissions.shell_automation_in_agent_workspace");
      // A legacy "warn" check reports as fail with warn severity.
      expect(check?.status).toBe("fail");
      expect(check?.severity).toBe("warn");
      expect(JSON.stringify(check?.data)).toContain('"agentId":"workflows"');
      const finding = report.findings.find((item) => item.id === "permissions.shell_automation_in_agent_workspace");
      expect(JSON.stringify(finding?.evidence)).toContain("agent:workflows");
    });

    it("passes the shell automation check when no command touches an agent workspace", () => {
      const report = inspectDoctor({
        ...makeHealthyDeps(),
        dbListAgents: () => [{ id: "workflows", cwd: "/srv/agents/workflows" }],
        listShellAutomations: () => [{ kind: "cron", id: "c1", enabled: true, shellCommand: "/opt/tools/run.sh" }],
      } as any);
      const check = report.checks.find((item) => item.id === "permissions.shell_automation_in_agent_workspace");
      expect(check?.status).toBe("pass");
    });

    it("warns on F2 misconfigurations without failing", () => {
      const report = inspectDoctor({
        ...makeHealthyDeps(),
        knowledgeSettings: () => knowledgeSettingsFixture({ contactMemoryAgents: ["codex-dev"], curatorAgent: "main" }),
        dbGetAgent: (id: string) => ({ id, provider: id === "codex-dev" ? "codex" : "claude" }) as any,
        resolveOwnerDirectTarget: () => null,
        agentHasNoExec: () => false,
        codexKnowledgeParityHolds: () => false,
        listInboxSubscriptions: () => [],
      } as any);
      const { f2, f2Finding } = knowledgeChecks(report);
      expect(f2?.status).toBe("fail");
      expect(f2?.severity).toBe("warn");
      const text = JSON.stringify(f2Finding);
      expect(text).toContain("knowledge.project");
      expect(text).toContain("owner contact");
      expect(text).toContain("curator agent main");
      expect(text).toContain("codex parity fixture fails for codex-dev");
      expect(text).toContain("inbox subscription");
    });
  });
});

describe("channels.native_runtime", () => {
  const ready = {
    name: "slack-a",
    provider: "slack",
    transport: "broker" as const,
    credentialConnection: "slack-a",
    issue: null,
    backend: "vault" as const,
    missingPrerequisites: [],
  };

  it("passes when there are no enabled native channels", () => {
    const check = buildNativeChannelRuntimeCheck({ channels: [], runnerStatus: null });
    expect(check).toMatchObject({ id: "channels.native_runtime", status: "ok" });
  });

  it("passes when every channel can start and the runner is online", () => {
    const check = buildNativeChannelRuntimeCheck({ channels: [ready], runnerStatus: "online" });
    expect(check.status).toBe("ok");
    expect(check.details).toContain("slack-a: connection slack-a active (vault backend)");
  });

  it("warns when a channel's broker connection does not exist", () => {
    const check = buildNativeChannelRuntimeCheck({
      channels: [{ ...ready, issue: "connection_not_found", backend: undefined }],
      runnerStatus: "online",
    });
    expect(check.status).toBe("warn");
    expect(check.summary).toContain("1 native channel(s) cannot start: slack-a");
    expect(check.details).toContain("slack-a: connection slack-a connection not found");
    expect(check.fixHint).toContain("ravi credentials add");
  });

  it("warns when the backend is missing a prerequisite, naming it without its value", () => {
    const check = buildNativeChannelRuntimeCheck({
      channels: [{ ...ready, missingPrerequisites: ["VAULT_TOKEN"] }],
      runnerStatus: "online",
    });
    expect(check.status).toBe("warn");
    expect(check.details).toContain(
      "slack-a: vault backend is missing VAULT_TOKEN in this CLI's environment (the runner's PM2 environment may differ)",
    );
  });

  it("does not pass when the runner's state cannot be checked", () => {
    const check = buildNativeChannelRuntimeCheck({ channels: [ready], runnerStatus: null });
    expect(check).toMatchObject({ status: "skip", severity: "warn" });
    expect(check.summary).toContain("could not be checked");
  });

  it("warns when the runner is not online, and exempts the hub gateway transport", () => {
    const check = buildNativeChannelRuntimeCheck({
      channels: [
        { name: "slack-hub", provider: "slack", transport: "hub_gateway_v1", issue: null, missingPrerequisites: [] },
      ],
      runnerStatus: "stopped",
    });
    expect(check.status).toBe("warn");
    expect(check.summary).toContain("ravi-channels is not online");
    expect(check.fixHint).toContain("ravi channels start");
  });

  it("is reported in the channels domain of the doctor report", () => {
    const report = inspectDoctor(
      {
        ...makeHealthyDeps(),
        inspectNativeChannelRuntime: () => ({
          channels: [{ ...ready, issue: "connection_not_found" }],
          runnerStatus: "online",
        }),
      },
      { domain: "channels" },
    );
    const check = report.checks.find((entry) => entry.id === "channels.native_runtime");
    expect(check).toMatchObject({ domain: "channels", status: "fail", severity: "warn" });
  });
});

describe("channels.runner_release", () => {
  function member(overrides: Partial<ManagedRuntimeMemberIdentity> = {}): ManagedRuntimeMemberIdentity {
    return {
      name: "ravi",
      managed: true,
      online: true,
      status: "online",
      pid: 100,
      bundlePath: "/pkg/dist/bundle/index.js",
      cwd: "/pkg",
      runningVersion: "3.261119.9",
      diskVersion: "3.261119.9",
      startedAt: 1_000,
      stale: false,
      codeStale: false,
      envStale: false,
      identityVerified: true,
      warnings: [],
      matchesCli: true,
      ...overrides,
    };
  }
  const runtime = (
    daemon: Partial<ManagedRuntimeMemberIdentity> = {},
    channels: Partial<ManagedRuntimeMemberIdentity> = {},
  ) => ({ daemon: member(daemon), channels: member({ name: "ravi-channels", pid: 200, ...channels }) });

  it("passes when the runner and the daemon run the same release", () => {
    const check = buildChannelRunnerReleaseCheck({ runtime: runtime(), adapters: [] });
    expect(check).toMatchObject({
      id: "channels.runner_release",
      status: "ok",
      summary: "ravi-channels and the daemon run 3.261119.9",
      data: { state: "aligned", runnerVersion: "3.261119.9", daemonVersion: "3.261119.9" },
    });
  });

  it("fails on a runner left on the previous release, naming both releases and the restart", () => {
    // 2026-11-19: PM2 online, Slack socket connected, replies queued behind the state guard for ~51 minutes.
    const check = buildChannelRunnerReleaseCheck({
      runtime: runtime({}, { runningVersion: "3.261119.6", diskVersion: "3.261119.9" }),
      adapters: [],
    });
    expect(check).toMatchObject({
      status: "fail",
      summary:
        "ravi-channels runs 3.261119.6 but the daemon runs 3.261119.9: the state guard refuses a runner on another release, so replies stay queued while PM2 still reports it online",
      fixHint: "ravi channels restart",
      details: ["ravi-channels: 3.261119.6", "daemon: 3.261119.9"],
      data: { state: "drift", runnerVersion: "3.261119.6", daemonVersion: "3.261119.9" },
    });
    expect(check.severity).toBeUndefined();
  });

  it("warns, not fails, when only the runner says its guard refuses it on matching releases", () => {
    const check = buildChannelRunnerReleaseCheck({ runtime: runtime(), adapters: [runnerReleaseGuardAdapter()] });
    expect(check).toMatchObject({
      status: "warn",
      fixHint: PREPARE_STATE_COMMAND,
      data: { state: "refused" },
    });
    expect(check.summary).toContain(
      "ravi-channels is refused by its state guard (runner 3.261119.9, daemon 3.261119.9)",
    );
  });

  it("treats the runner's own report of a refused guard as evidence on its own, whatever the releases are", () => {
    // Unknown runner release, and a daemon that is down: still a warning, never a skip.
    const unknownRelease = buildChannelRunnerReleaseCheck({
      runtime: runtime({}, { runningVersion: null }),
      adapters: [runnerReleaseGuardAdapter()],
    });
    expect(unknownRelease).toMatchObject({
      status: "warn",
      data: { state: "refused" },
      fixHint: PREPARE_STATE_COMMAND,
    });

    const daemonDown = buildChannelRunnerReleaseCheck({
      runtime: runtime({ online: false, status: "stopped", runningVersion: null }),
      adapters: [runnerReleaseGuardAdapter()],
    });
    expect(daemonDown).toMatchObject({ status: "warn", data: { state: "refused" }, fixHint: "ravi daemon start" });
  });

  it("skips what it cannot verify instead of calling it drift", () => {
    expect(buildChannelRunnerReleaseCheck({ runtime: null, adapters: null })).toMatchObject({
      status: "skip",
      data: { state: "unverified", why: "pm2_unavailable" },
    });
    expect(
      buildChannelRunnerReleaseCheck({
        runtime: runtime({}, { online: false, status: "stopped", runningVersion: null }),
        adapters: null,
      }),
    ).toMatchObject({ status: "skip", data: { why: "runner_not_online" } });
    expect(
      buildChannelRunnerReleaseCheck({ runtime: runtime({ online: false, status: "stopped" }), adapters: null }),
    ).toMatchObject({ status: "skip", data: { why: "daemon_not_online" } });

    const unverified = buildChannelRunnerReleaseCheck({
      runtime: runtime({}, { runningVersion: null }),
      adapters: null,
    });
    expect(unverified).toMatchObject({ status: "skip", severity: "warn", data: { why: "version_unknown" } });
    expect(unverified.fixHint).toContain("records its release");
  });

  it("is reported in the channels domain of the doctor report, as an error when the releases differ", () => {
    const report = inspectDoctor(
      {
        ...makeHealthyDeps(),
        inspectManagedRuntime: () => runtime({}, { runningVersion: "3.261119.6" }),
      },
      { domain: "channels" },
    );
    expect(report.checks.find((entry) => entry.id === "channels.runner_release")).toMatchObject({
      domain: "channels",
      status: "fail",
      severity: "error",
    });
  });

  it("uses what the runner reported over NATS, handed over by runDoctor", () => {
    const report = inspectDoctor(
      { ...makeHealthyDeps(), inspectManagedRuntime: () => runtime() },
      { domain: "channels", runnerAdapters: [runnerReleaseGuardAdapter()] },
    );
    expect(report.checks.find((entry) => entry.id === "channels.runner_release")).toMatchObject({
      status: "fail",
      severity: "warn",
    });
  });

  it("uses the PM2 read runDoctor already made instead of reading it again", () => {
    const report = inspectDoctor(
      {
        ...makeHealthyDeps(),
        inspectManagedRuntime: () => {
          throw new Error("PM2 must not be read a second time");
        },
      },
      { domain: "channels", managedRuntime: runtime({}, { runningVersion: "3.261119.6" }) },
    );
    expect(report.checks.find((entry) => entry.id === "channels.runner_release")).toMatchObject({
      status: "fail",
      severity: "error",
    });
  });

  it("runDoctor probes the runner by its PM2 PID for the channels domain only, and survives a probe that fails", async () => {
    const deps = makeHealthyDeps();
    const probed: number[] = [];
    const originalLog = console.log;
    console.log = () => {};
    try {
      const report = await runDoctor(
        { json: true, domain: "channels" },
        {
          ...deps,
          inspectManagedRuntime: () => runtime(),
          probeChannelRunnerAdapters: async (pid) => {
            probed.push(pid);
            return [runnerReleaseGuardAdapter()];
          },
        },
      );
      expect(report.checks.find((entry) => entry.id === "channels.runner_release")?.status).toBe("fail");

      await runDoctor(
        { json: true, domain: "apps" },
        {
          ...deps,
          probeChannelRunnerAdapters: async (pid) => {
            probed.push(pid);
            return [];
          },
        },
      );
      // A runner that is not online has nothing to ask.
      await runDoctor(
        { json: true, domain: "channels" },
        {
          ...deps,
          inspectManagedRuntime: () => runtime({}, { online: false, status: "stopped", pid: null }),
          probeChannelRunnerAdapters: async (pid) => {
            probed.push(pid);
            return [];
          },
        },
      );
      const failed = await runDoctor(
        { json: true, domain: "channels" },
        {
          ...deps,
          inspectManagedRuntime: () => runtime(),
          probeChannelRunnerAdapters: async () => {
            throw new Error("probe exploded");
          },
        },
      );
      expect(failed.checks.find((entry) => entry.id === "channels.runner_release")?.status).toBe("pass");
    } finally {
      console.log = originalLog;
    }
    expect(probed).toEqual([200]);
  });

  it("reports a PM2 read that throws as an unverified check in the channels domain instead of dropping it", async () => {
    const deps = makeHealthyDeps();
    const originalLog = console.log;
    console.log = () => {};
    try {
      // `--domain channels` filters out addCheck's own fallback (runtime domain), so the check reports it itself.
      const report = await runDoctor(
        { json: true, domain: "channels" },
        {
          ...deps,
          inspectManagedRuntime: () => {
            throw new Error("pm2 jlist failed");
          },
        },
      );
      const check = report.checks.find((entry) => entry.id === "channels.runner_release");
      expect(check).toMatchObject({ domain: "channels", status: "skip", severity: "warn" });
      const finding = report.findings.find((entry) => entry.id === "channels.runner_release");
      expect(finding?.summary).toContain("PM2 could not be read");
      expect(finding?.summary).toContain("pm2 jlist failed");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("probeDoctorRunnerAdapters", () => {
  const onlineRunner = { online: true, pid: 200 };

  it("does not let a runner or NATS that never answers hold the doctor", async () => {
    const started = Date.now();
    const adapters = await probeDoctorRunnerAdapters(() => new Promise(() => {}), onlineRunner, undefined, 20);
    expect(adapters).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("asks the runner by PID and returns what it reported when it answers in time", async () => {
    const reported = [runnerReleaseGuardAdapter()];
    const pids: number[] = [];
    const adapters = await probeDoctorRunnerAdapters(
      async (pid) => {
        pids.push(pid);
        return reported;
      },
      onlineRunner,
      null,
    );
    expect(adapters).toEqual(reported);
    expect(pids).toEqual([200]);
  });

  it("has nothing to ask a runner that is not online or has no PID, or outside the channels domain", async () => {
    let probes = 0;
    const probe = async () => {
      probes++;
      return [];
    };
    expect(await probeDoctorRunnerAdapters(probe, null, undefined)).toBeNull();
    expect(await probeDoctorRunnerAdapters(probe, { online: false, pid: 200 }, undefined)).toBeNull();
    expect(await probeDoctorRunnerAdapters(probe, { online: true, pid: null }, undefined)).toBeNull();
    expect(await probeDoctorRunnerAdapters(probe, { online: true, pid: 0 }, undefined)).toBeNull();
    expect(await probeDoctorRunnerAdapters(probe, onlineRunner, "runtime")).toBeNull();
    expect(probes).toBe(0);
  });
});
