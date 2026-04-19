import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inspectAgentInstructionFiles, type AgentInstructionState } from "../../runtime/agent-instructions.js";
import { getRuntimeCompatibilityIssues, listRegisteredRuntimeProviderIds } from "../../runtime/provider-registry.js";
import type { RuntimeCompatibilityIssue, RuntimeProviderId } from "../../runtime/types.js";
import { dbListAgents, dbListInstances, getRaviDbPath } from "../../router/router-db.js";
import { listTaskAutomations } from "../../tasks/index.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { inspectCliRuntimeTarget, type CliRuntimeTargetSummary } from "../runtime-target.js";

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  summary: string;
  details?: string[];
  fixHint?: string;
  data?: Record<string, unknown>;
}

export interface DoctorReport {
  generatedAt: string;
  summary: {
    ok: number;
    warn: number;
    fail: number;
    total: number;
  };
  checks: DoctorCheck[];
}

type DoctorDeps = {
  inspectCliRuntimeTarget: (instanceName?: string | null) => CliRuntimeTargetSummary;
  getRaviStateDir: () => string;
  getRaviDbPath: () => string;
  dbListAgents: typeof dbListAgents;
  dbListInstances: typeof dbListInstances;
  inspectAgentInstructionFiles: typeof inspectAgentInstructionFiles;
  listTaskAutomations: typeof listTaskAutomations;
  getRuntimeCompatibilityIssues: (
    provider: RuntimeProviderId,
    request: {
      toolAccessMode?: "restricted" | "unrestricted";
      requiresMcpServers?: boolean;
      requiresRemoteSpawn?: boolean;
    },
  ) => RuntimeCompatibilityIssue[];
  listRegisteredRuntimeProviderIds: typeof listRegisteredRuntimeProviderIds;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  homeDir: () => string;
};

const DEFAULT_DEPS: DoctorDeps = {
  inspectCliRuntimeTarget,
  getRaviStateDir,
  getRaviDbPath,
  dbListAgents,
  dbListInstances,
  inspectAgentInstructionFiles,
  listTaskAutomations,
  getRuntimeCompatibilityIssues,
  listRegisteredRuntimeProviderIds,
  exists: existsSync,
  readFile: (path: string) => readFileSync(path, "utf8"),
  homeDir: homedir,
};

const STATUS_LABEL: Record<DoctorCheckStatus, string> = {
  ok: "OK",
  warn: "WARN",
  fail: "FAIL",
};

const INSTRUCTION_STATE_SEVERITY: Record<AgentInstructionState, DoctorCheckStatus> = {
  "agents-canonical": "ok",
  "agents-only": "warn",
  "claude-only": "fail",
  "legacy-claude-canonical": "warn",
  "duplicated-custom": "warn",
  "divergent-custom-both": "fail",
  "missing-both": "fail",
  "agents-bridge-only": "fail",
  "claude-bridge-only": "fail",
  "double-bridge": "fail",
};

export function inspectDoctor(overrides: Partial<DoctorDeps> = {}): DoctorReport {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const checks: DoctorCheck[] = [];

  const runtimeTarget = deps.inspectCliRuntimeTarget();
  const stateDir = deps.getRaviStateDir();
  const raviDbPath = deps.getRaviDbPath();
  const insightsDbPath = join(stateDir, "insights.db");
  const codexHooksPath = join(deps.homeDir(), ".codex", "hooks.json");

  checks.push(buildDaemonCheck(runtimeTarget));
  checks.push(buildRuntimeMatchCheck(runtimeTarget));
  checks.push(buildDaemonCwdCheck(runtimeTarget));
  checks.push(buildStateDirCheck(stateDir, deps));
  checks.push(buildRaviDbCheck(raviDbPath, deps));
  checks.push(buildInsightsDbCheck(insightsDbPath, deps));
  checks.push(buildProviderCompatibilityCheck(deps));

  const raviDbExists = deps.exists(raviDbPath);
  if (!raviDbExists) {
    checks.push({
      id: "instances.main",
      title: "Main instance",
      status: "fail",
      summary: "cannot inspect instances because ravi.db is missing",
      details: [raviDbPath],
      fixHint: "restore or initialize ~/.ravi/ravi.db before relying on runtime routing",
      data: { dbPath: raviDbPath },
    });
    checks.push({
      id: "agents.registered",
      title: "Registered agents",
      status: "fail",
      summary: "cannot inspect agents because ravi.db is missing",
      details: [raviDbPath],
      fixHint: "restore or initialize ~/.ravi/ravi.db before inspecting workspace health",
      data: { dbPath: raviDbPath },
    });
    checks.push({
      id: "agents.instructions",
      title: "AGENTS-first workspaces",
      status: "fail",
      summary: "cannot inspect workspace instructions because ravi.db is missing",
      details: [raviDbPath],
      fixHint: "restore or initialize ~/.ravi/ravi.db, then run `ravi agents sync-instructions --all` if needed",
      data: { dbPath: raviDbPath },
    });
    checks.push({
      id: "tasks.automations",
      title: "Task automations substrate",
      status: "fail",
      summary: "cannot inspect task automations because ravi.db is missing",
      details: [raviDbPath],
      fixHint: "restore or initialize ~/.ravi/ravi.db before relying on task automations",
      data: { dbPath: raviDbPath },
    });
  } else {
    let agents: ReturnType<typeof dbListAgents> | null = null;
    let instances: ReturnType<typeof dbListInstances> | null = null;

    try {
      instances = deps.dbListInstances();
      checks.push(buildMainInstanceCheck(instances));
    } catch (error) {
      checks.push(buildUnexpectedFailureCheck("instances.main", "Main instance", error));
    }

    try {
      agents = deps.dbListAgents();
      checks.push(buildRegisteredAgentsCheck(agents));
    } catch (error) {
      checks.push(buildUnexpectedFailureCheck("agents.registered", "Registered agents", error));
      agents = null;
    }

    if (agents) {
      try {
        checks.push(buildAgentInstructionCheck(agents, deps));
      } catch (error) {
        checks.push(buildUnexpectedFailureCheck("agents.instructions", "AGENTS-first workspaces", error));
      }
    }

    try {
      checks.push(buildTaskAutomationsCheck(deps));
    } catch (error) {
      checks.push(buildUnexpectedFailureCheck("tasks.automations", "Task automations substrate", error));
    }
  }

  checks.push(buildCodexHookCheck(codexHooksPath, deps));

  const summary = summarizeChecks(checks);
  return {
    generatedAt: new Date().toISOString(),
    summary,
    checks,
  };
}

export function runDoctor(options: { json?: boolean } = {}, overrides: Partial<DoctorDeps> = {}): DoctorReport {
  const report = inspectDoctor(overrides);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  printDoctorReport(report);
  return report;
}

function buildDaemonCheck(summary: CliRuntimeTargetSummary): DoctorCheck {
  if (summary.daemon.online) {
    return {
      id: "runtime.daemon",
      title: "Live daemon",
      status: "ok",
      summary: "live daemon is online",
      details: [`daemon bundle: ${summary.daemon.execPath ?? "-"}`, `daemon cwd: ${summary.daemon.cwd ?? "-"}`],
      data: {
        online: true,
        bundle: summary.daemon.execPath,
        cwd: summary.daemon.cwd,
      },
    };
  }

  return {
    id: "runtime.daemon",
    title: "Live daemon",
    status: "fail",
    summary: "live daemon is offline or unreadable",
    details: [`cli bundle: ${summary.cliBundlePath ?? "-"}`],
    fixHint: "bring the live daemon back before trusting runtime-facing mutations",
    data: {
      online: false,
      cliBundle: summary.cliBundlePath,
    },
  };
}

function buildRuntimeMatchCheck(summary: CliRuntimeTargetSummary): DoctorCheck {
  if (!summary.daemon.online) {
    return {
      id: "runtime.bundle-match",
      title: "CLI/runtime match",
      status: "warn",
      summary: "skipped because the live daemon is offline",
      details: [`cli bundle: ${summary.cliBundlePath ?? "-"}`],
      data: {
        cliBundle: summary.cliBundlePath,
        daemonBundle: summary.daemon.execPath,
        matches: summary.daemon.matchesCli,
      },
    };
  }

  if (summary.daemon.matchesCli === true) {
    return {
      id: "runtime.bundle-match",
      title: "CLI/runtime match",
      status: "ok",
      summary: "current CLI bundle matches the live daemon bundle",
      details: [`cli bundle: ${summary.cliBundlePath ?? "-"}`, `daemon bundle: ${summary.daemon.execPath ?? "-"}`],
      data: {
        cliBundle: summary.cliBundlePath,
        daemonBundle: summary.daemon.execPath,
        matches: true,
      },
    };
  }

  if (summary.daemon.matchesCli === false) {
    return {
      id: "runtime.bundle-match",
      title: "CLI/runtime match",
      status: "fail",
      summary: "current CLI bundle does not match the live daemon bundle",
      details: [`cli bundle: ${summary.cliBundlePath ?? "-"}`, `daemon bundle: ${summary.daemon.execPath ?? "-"}`],
      fixHint: "run the repo wrapper that matches the live daemon before trusting mutations",
      data: {
        cliBundle: summary.cliBundlePath,
        daemonBundle: summary.daemon.execPath,
        matches: false,
      },
    };
  }

  return {
    id: "runtime.bundle-match",
    title: "CLI/runtime match",
    status: "warn",
    summary: "could not prove whether the current CLI matches the live daemon",
    details: [`cli bundle: ${summary.cliBundlePath ?? "-"}`, `daemon bundle: ${summary.daemon.execPath ?? "-"}`],
    data: {
      cliBundle: summary.cliBundlePath,
      daemonBundle: summary.daemon.execPath,
      matches: null,
    },
  };
}

function buildDaemonCwdCheck(summary: CliRuntimeTargetSummary): DoctorCheck {
  if (!summary.daemon.online) {
    return {
      id: "runtime.daemon-cwd",
      title: "Daemon cwd trust",
      status: "warn",
      summary: "skipped because the live daemon is offline",
      details: [`daemon cwd: ${summary.daemon.cwd ?? "-"}`],
      data: {
        daemonCwd: summary.daemon.cwd,
        expectedProjectRoot: inferProjectRootFromBundlePath(summary.cliBundlePath),
      },
    };
  }

  const expectedProjectRoot = inferProjectRootFromBundlePath(summary.cliBundlePath);
  if (!expectedProjectRoot || !summary.daemon.cwd) {
    return {
      id: "runtime.daemon-cwd",
      title: "Daemon cwd trust",
      status: "warn",
      summary: "could not verify whether the daemon cwd points at the expected repo root",
      details: [`expected project root: ${expectedProjectRoot ?? "-"}`, `daemon cwd: ${summary.daemon.cwd ?? "-"}`],
      data: {
        daemonCwd: summary.daemon.cwd,
        expectedProjectRoot,
      },
    };
  }

  if (summary.daemon.cwd === expectedProjectRoot) {
    return {
      id: "runtime.daemon-cwd",
      title: "Daemon cwd trust",
      status: "ok",
      summary: "daemon cwd points at the expected Ravi repo root",
      details: [`expected project root: ${expectedProjectRoot}`, `daemon cwd: ${summary.daemon.cwd}`],
      data: {
        daemonCwd: summary.daemon.cwd,
        expectedProjectRoot,
      },
    };
  }

  return {
    id: "runtime.daemon-cwd",
    title: "Daemon cwd trust",
    status: "fail",
    summary: "daemon cwd does not point at the expected Ravi repo root",
    details: [`expected project root: ${expectedProjectRoot}`, `daemon cwd: ${summary.daemon.cwd}`],
    fixHint: "restart the daemon from the Ravi repo wrapper so relative paths resolve against the right project root",
    data: {
      daemonCwd: summary.daemon.cwd,
      expectedProjectRoot,
    },
  };
}

function buildStateDirCheck(stateDir: string, deps: DoctorDeps): DoctorCheck {
  if (deps.exists(stateDir)) {
    return {
      id: "substrate.state-dir",
      title: "Ravi state dir",
      status: "ok",
      summary: "state directory is present",
      details: [stateDir],
      data: { path: stateDir },
    };
  }

  return {
    id: "substrate.state-dir",
    title: "Ravi state dir",
    status: "fail",
    summary: "state directory is missing",
    details: [stateDir],
    fixHint: "initialize ~/.ravi before relying on the local runtime substrate",
    data: { path: stateDir },
  };
}

function buildRaviDbCheck(dbPath: string, deps: DoctorDeps): DoctorCheck {
  if (deps.exists(dbPath)) {
    return {
      id: "substrate.ravi-db",
      title: "ravi.db",
      status: "ok",
      summary: "primary runtime database is present",
      details: [dbPath],
      data: { path: dbPath },
    };
  }

  return {
    id: "substrate.ravi-db",
    title: "ravi.db",
    status: "fail",
    summary: "primary runtime database is missing",
    details: [dbPath],
    fixHint: "restore or initialize ~/.ravi/ravi.db before operating the runtime",
    data: { path: dbPath },
  };
}

function buildInsightsDbCheck(dbPath: string, deps: DoctorDeps): DoctorCheck {
  if (deps.exists(dbPath)) {
    return {
      id: "substrate.insights-db",
      title: "insights.db",
      status: "ok",
      summary: "insights substrate is initialized",
      details: [dbPath],
      data: { path: dbPath, initialized: true },
    };
  }

  return {
    id: "substrate.insights-db",
    title: "insights.db",
    status: "warn",
    summary: "insights substrate is not initialized yet",
    details: [dbPath],
    fixHint: "the file is created on first real insight write; this is okay until the feature is used",
    data: { path: dbPath, initialized: false },
  };
}

function buildMainInstanceCheck(instances: ReturnType<typeof dbListInstances>): DoctorCheck {
  if (instances.length === 0) {
    return {
      id: "instances.main",
      title: "Main instance",
      status: "fail",
      summary: "no instances are configured in ravi.db",
      fixHint: "configure the main instance before relying on chat routing",
      data: { total: 0 },
    };
  }

  const enabled = instances.filter((instance) => instance.enabled !== false);
  const main = instances.find((instance) => instance.name === "main");

  if (!main) {
    return {
      id: "instances.main",
      title: "Main instance",
      status: "fail",
      summary: "main instance is missing",
      details: [`configured instances: ${instances.length}`],
      fixHint: "create or restore the `main` instance before operating the primary channel",
      data: { total: instances.length, enabled: enabled.length, hasMain: false },
    };
  }

  if (main.enabled === false) {
    return {
      id: "instances.main",
      title: "Main instance",
      status: "fail",
      summary: "main instance exists but is disabled",
      details: [`channel: ${main.channel}`, `instance id: ${main.instanceId ?? "-"}`],
      fixHint: "re-enable the main instance before relying on live channel traffic",
      data: {
        total: instances.length,
        enabled: enabled.length,
        hasMain: true,
        mainEnabled: false,
      },
    };
  }

  return {
    id: "instances.main",
    title: "Main instance",
    status: "ok",
    summary: `main instance is enabled (${enabled.length}/${instances.length} instances enabled)`,
    details: [`channel: ${main.channel}`, `instance id: ${main.instanceId ?? "-"}`],
    data: {
      total: instances.length,
      enabled: enabled.length,
      hasMain: true,
      mainEnabled: true,
      channel: main.channel,
    },
  };
}

function buildRegisteredAgentsCheck(agents: ReturnType<typeof dbListAgents>): DoctorCheck {
  if (agents.length === 0) {
    return {
      id: "agents.registered",
      title: "Registered agents",
      status: "fail",
      summary: "no agents are registered in ravi.db",
      fixHint: "create at least one agent before relying on task dispatch or routing",
      data: { total: 0 },
    };
  }

  const providers = agents.reduce<Record<string, number>>((acc, agent) => {
    const key = agent.provider ?? "claude";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return {
    id: "agents.registered",
    title: "Registered agents",
    status: "ok",
    summary: `${agents.length} agents registered`,
    details: Object.entries(providers).map(([provider, count]) => `${provider}: ${count}`),
    data: {
      total: agents.length,
      providers,
    },
  };
}

function buildAgentInstructionCheck(agents: ReturnType<typeof dbListAgents>, deps: DoctorDeps): DoctorCheck {
  if (agents.length === 0) {
    return {
      id: "agents.instructions",
      title: "AGENTS-first workspaces",
      status: "fail",
      summary: "no agents available to inspect workspace instructions",
      fixHint: "create agents first, then run `ravi agents sync-instructions --all`",
      data: { total: 0, byState: {} },
    };
  }

  const byState: Record<string, number> = {};
  const failing: string[] = [];
  const warning: string[] = [];

  for (const agent of agents) {
    const inspection = deps.inspectAgentInstructionFiles(agent.cwd);
    byState[inspection.state] = (byState[inspection.state] ?? 0) + 1;
    const severity = INSTRUCTION_STATE_SEVERITY[inspection.state];
    if (severity === "fail") {
      failing.push(`${agent.id}: ${inspection.state}`);
    } else if (severity === "warn") {
      warning.push(`${agent.id}: ${inspection.state}`);
    }
  }

  const details = [
    ...Object.entries(byState).map(([state, count]) => `${state}: ${count}`),
    ...limitIssueDetails(failing, "failing"),
    ...limitIssueDetails(warning, "warning"),
  ];

  if (failing.length > 0) {
    return {
      id: "agents.instructions",
      title: "AGENTS-first workspaces",
      status: "fail",
      summary: `${failing.length} agent workspaces are not healthy under AGENTS-first`,
      details,
      fixHint: "run `ravi agents sync-instructions --all` and inspect divergent workspaces manually",
      data: {
        total: agents.length,
        byState,
        failing,
        warning,
      },
    };
  }

  if (warning.length > 0) {
    return {
      id: "agents.instructions",
      title: "AGENTS-first workspaces",
      status: "warn",
      summary: `${warning.length} agent workspaces still need instruction cleanup`,
      details,
      fixHint: "run `ravi agents sync-instructions --all` to finish the AGENTS-first migration",
      data: {
        total: agents.length,
        byState,
        failing,
        warning,
      },
    };
  }

  return {
    id: "agents.instructions",
    title: "AGENTS-first workspaces",
    status: "ok",
    summary: `all ${agents.length} agent workspaces are AGENTS-first healthy`,
    details,
    data: {
      total: agents.length,
      byState,
      failing,
      warning,
    },
  };
}

function buildTaskAutomationsCheck(deps: DoctorDeps): DoctorCheck {
  const automations = deps.listTaskAutomations();
  const enabled = automations.filter((automation) => automation.enabled).length;
  return {
    id: "tasks.automations",
    title: "Task automations substrate",
    status: "ok",
    summary: `${automations.length} task automations loaded`,
    details: [`enabled: ${enabled}`, `disabled: ${automations.length - enabled}`],
    data: {
      total: automations.length,
      enabled,
      disabled: automations.length - enabled,
    },
  };
}

function buildUnexpectedFailureCheck(id: string, title: string, error: unknown): DoctorCheck {
  return {
    id,
    title,
    status: "fail",
    summary: "inspection crashed before this surface could be evaluated",
    details: [error instanceof Error ? error.message : String(error)],
    fixHint: "fix the underlying runtime error before trusting this slice of the doctor report",
    data: {
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function buildProviderCompatibilityCheck(deps: DoctorDeps): DoctorCheck {
  const providers = deps.listRegisteredRuntimeProviderIds();
  const results = providers.map((provider) => ({
    provider,
    issues: deps.getRuntimeCompatibilityIssues(provider, { toolAccessMode: "restricted" }),
  }));
  const failing = results.filter((entry) => entry.issues.length > 0);

  if (failing.length > 0) {
    return {
      id: "runtime.providers",
      title: "Restricted provider compatibility",
      status: "fail",
      summary: `${failing.length} runtime providers do not support restricted tool access`,
      details: failing.flatMap((entry) => entry.issues.map((issue) => `${entry.provider}: ${issue.message}`)),
      fixHint: "bring provider capabilities back in sync before relying on restricted sessions",
      data: {
        failing: failing.map((entry) => ({
          provider: entry.provider,
          issues: entry.issues.map((issue) => issue.code),
        })),
      },
    };
  }

  return {
    id: "runtime.providers",
    title: "Restricted provider compatibility",
    status: "ok",
    summary: "registered runtime providers support restricted tool access",
    details: results.map((entry) => `${entry.provider}: restricted tool access supported`),
    data: {
      providers: results.map((entry) => entry.provider),
    },
  };
}

function buildCodexHookCheck(hooksPath: string, deps: DoctorDeps): DoctorCheck {
  if (!deps.exists(hooksPath)) {
    return {
      id: "codex.bash-hook",
      title: "Global Codex bash hook",
      status: "fail",
      summary: "global Codex hooks file is missing",
      details: [hooksPath],
      fixHint: "materialize ~/.codex/hooks.json through the Codex provider or restart the daemon",
      data: { path: hooksPath, exists: false, valid: false },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readFile(hooksPath));
  } catch (error) {
    return {
      id: "codex.bash-hook",
      title: "Global Codex bash hook",
      status: "fail",
      summary: "global Codex hooks file is not valid JSON",
      details: [hooksPath, error instanceof Error ? error.message : String(error)],
      fixHint: "rewrite ~/.codex/hooks.json with the Ravi bash hook group",
      data: { path: hooksPath, exists: true, valid: false },
    };
  }

  const valid = hasRaviCodexBashHook(parsed);
  if (!valid) {
    return {
      id: "codex.bash-hook",
      title: "Global Codex bash hook",
      status: "fail",
      summary: "global Codex hooks file exists but Ravi bash governance is missing",
      details: [hooksPath],
      fixHint: "rewrite ~/.codex/hooks.json so `PreToolUse` for `^Bash$` points at `ravi context codex-bash-hook`",
      data: { path: hooksPath, exists: true, valid: false },
    };
  }

  return {
    id: "codex.bash-hook",
    title: "Global Codex bash hook",
    status: "ok",
    summary: "Ravi Codex bash governance is present in ~/.codex/hooks.json",
    details: [hooksPath],
    data: { path: hooksPath, exists: true, valid: true },
  };
}

function hasRaviCodexBashHook(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const hooks = (value as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return false;
  }

  const preToolUse = (hooks as Record<string, unknown>).PreToolUse;
  if (!Array.isArray(preToolUse)) {
    return false;
  }

  return preToolUse.some((group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      return false;
    }
    const matcher = (group as Record<string, unknown>).matcher;
    const handlers = (group as Record<string, unknown>).hooks;
    if (matcher !== "^Bash$" || !Array.isArray(handlers)) {
      return false;
    }
    return handlers.some((handler) => {
      if (!handler || typeof handler !== "object" || Array.isArray(handler)) {
        return false;
      }
      const record = handler as Record<string, unknown>;
      return (
        record.type === "command" &&
        record.statusMessage === "ravi codex bash permission gate" &&
        typeof record.command === "string" &&
        record.command.includes("codex-bash-hook")
      );
    });
  });
}

function summarizeChecks(checks: DoctorCheck[]): DoctorReport["summary"] {
  const summary = { ok: 0, warn: 0, fail: 0, total: checks.length };
  for (const check of checks) {
    summary[check.status] += 1;
  }
  return summary;
}

function printDoctorReport(report: DoctorReport): void {
  console.log("\nRavi doctor\n");
  console.log(
    `Summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail (${report.summary.total} checks)`,
  );

  for (const check of report.checks) {
    console.log(`\n[${STATUS_LABEL[check.status]}] ${check.title}`);
    console.log(`  ${check.summary}`);
    for (const detail of check.details ?? []) {
      console.log(`  - ${detail}`);
    }
    if (check.fixHint) {
      console.log(`  fix: ${check.fixHint}`);
    }
  }

  console.log("");
}

function limitIssueDetails(entries: string[], label: string): string[] {
  if (entries.length === 0) {
    return [];
  }

  const limit = 8;
  const selected = entries.slice(0, limit).map((entry) => `${label}: ${entry}`);
  if (entries.length > limit) {
    selected.push(`${label}: +${entries.length - limit} more`);
  }
  return selected;
}

function inferProjectRootFromBundlePath(bundlePath: string | null | undefined): string | null {
  if (!bundlePath) return null;
  const normalized = bundlePath.replace(/\\/g, "/");
  if (normalized.endsWith("/dist/bundle/index.js")) {
    return dirname(dirname(dirname(bundlePath)));
  }
  if (normalized.endsWith("/src/cli/index.ts")) {
    return dirname(dirname(dirname(bundlePath)));
  }
  return null;
}
