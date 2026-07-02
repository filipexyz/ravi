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
    getDefaultAgentId: () => "main",
    resolveSession: () => null as any,
    deriveSourceFromSessionKey: () => null as any,
    exists: (path: string) =>
      [stateDir, join(stateDir, "ravi.db"), join(stateDir, "insights.db"), join(home, ".codex", "hooks.json")].includes(
        path,
      ),
    readFile: (path: string) => readFileSync(path, "utf8"),
    homeDir: () => home,
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

    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(report.checks.find((check) => check.id === "runtime.daemon")?.status).toBe("ok");
    expect(report.checks.find((check) => check.id === "codex.bash-hook")?.status).toBe("ok");
    expect(report.checks.find((check) => check.id === "agents.instructions")?.status).toBe("ok");
    expect(report.checks.find((check) => check.id === "tasks.automations")?.summary).toContain("2 task automations");
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
      exists: (path: string) => path === stateDir || path === join(stateDir, "ravi.db"),
      readFile: () => "",
      homeDir: () => home,
    });

    expect(report.summary.fail).toBeGreaterThan(0);
    expect(report.summary.warn).toBeGreaterThan(0);
    expect(report.checks.find((check) => check.id === "runtime.daemon")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "substrate.insights-db")?.status).toBe("warn");
    expect(report.checks.find((check) => check.id === "codex.bash-hook")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "agents.instructions")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "runtime.providers")?.status).toBe("fail");
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
    expect(cronCheck!.status).toBe("warn");
    const findings = (cronCheck!.data as any).findings;
    expect(findings[0].id).toBe("cron.routing_derived_key");
  });

  it("reports ok when all cron targets are valid", () => {
    const deps = makeHealthyDeps();
    const report = inspectDoctor(deps);
    const cronCheck = report.checks.find((check) => check.id === "cron.targets");
    expect(cronCheck).toBeDefined();
    expect(cronCheck!.status).toBe("ok");
  });

  it("reports ok when no enabled crons exist", () => {
    const deps = makeHealthyDeps();
    deps.dbListCronJobs = () => [] as any;

    const report = inspectDoctor(deps);
    const cronCheck = report.checks.find((check) => check.id === "cron.targets");
    expect(cronCheck).toBeDefined();
    expect(cronCheck!.status).toBe("ok");
    expect(cronCheck!.summary).toContain("no enabled");
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
    expect(cronCheck!.status).toBe("ok");
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
    expect(payload.summary.fail).toBe(0);
    expect(Array.isArray(payload.checks)).toBe(true);
    expect(payload.checks.some((check: { id: string }) => check.id === "codex.bash-hook")).toBe(true);
  });
});
