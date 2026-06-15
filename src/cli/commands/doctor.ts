import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SQLQueryBindings } from "bun:sqlite";
import { checkAppManifests, discoverAppManifests } from "../../apps/service.js";
import {
  getConfiguredCapabilityMaterializers,
  getConfiguredPermissionProviders,
} from "../../permissions/provider-registry.js";
import {
  authorizePermission,
  localOperatorCan,
  materializeSubjectCapabilities,
} from "../../permissions/provider-runtime.js";
import { inspectAgentInstructionFiles, type AgentInstructionState } from "../../runtime/agent-instructions.js";
import { getRuntimeCompatibilityIssues, listRegisteredRuntimeProviderIds } from "../../runtime/provider-registry.js";
import type { RuntimeCompatibilityIssue, RuntimeProviderId } from "../../runtime/types.js";
import { dbListAgents, dbListInstances, dbListRoutes, getDb, getRaviDbPath } from "../../router/router-db.js";
import {
  currentCliOnlyCommands,
  currentWeakPublicReturnCommands,
} from "../../sdk/client-codegen/return-schema-quality.js";
import { listTaskAutomations } from "../../tasks/index.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { getRegistry, type RegistrySnapshot } from "../registry-snapshot.js";
import { inspectCliRuntimeTarget, type CliRuntimeTargetSummary } from "../runtime-target.js";

export type DoctorSeverity = "error" | "warn" | "info";
export type DoctorCheckStatus = "pass" | "fail" | "skip";

export interface DoctorEvidence {
  label: string;
  value?: string | number | boolean | null;
  entity?: {
    type: string;
    id?: string;
    name?: string;
  };
  source?: string;
}

export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  domain: string;
  title: string;
  summary: string;
  evidence: DoctorEvidence[];
  fixHint?: string;
  data?: Record<string, unknown>;
}

export interface DoctorCheck {
  id: string;
  domain: string;
  title: string;
  status: DoctorCheckStatus;
  severity: DoctorSeverity;
  findings: string[];
  durationMs: number;
  data?: Record<string, unknown>;
}

export interface DoctorRuntimeSnapshot {
  version?: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
  cwd?: string;
  daemon?: {
    online?: boolean;
    version?: string;
    pid?: number;
    memoryMb?: number;
    cpuPercent?: number;
  };
  database?: {
    path?: string;
    schemaVersion?: string;
    migrationsKnown?: boolean;
  };
}

export interface DoctorReport {
  generatedAt: string;
  ok: boolean;
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    checks: {
      total: number;
      passed: number;
      failed: number;
      skipped: number;
    };
    domains: Record<
      string,
      {
        errors: number;
        warnings: number;
        infos: number;
        totalChecks: number;
        failedChecks: number;
        skippedChecks: number;
      }
    >;
  };
  runtime: DoctorRuntimeSnapshot;
  findings: DoctorFinding[];
  checks: DoctorCheck[];
}

type LegacyDoctorCheckStatus = "ok" | "warn" | "fail" | "skip";

interface LegacyDoctorCheck {
  id: string;
  title: string;
  status: LegacyDoctorCheckStatus;
  summary: string;
  domain?: string;
  severity?: DoctorSeverity;
  details?: string[];
  fixHint?: string;
  data?: Record<string, unknown>;
  durationMs?: number;
}

type GitInfo = {
  branch?: string;
  commit?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
};

type QueryRows = <T extends Record<string, unknown>>(sql: string, params?: SQLQueryBindings[]) => T[];

type DoctorDeps = {
  inspectCliRuntimeTarget: (instanceName?: string | null) => CliRuntimeTargetSummary;
  getRaviStateDir: () => string;
  getRaviDbPath: () => string;
  dbListAgents: typeof dbListAgents;
  dbListInstances: typeof dbListInstances;
  dbListRoutes: typeof dbListRoutes;
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
  getConfiguredPermissionProviders: typeof getConfiguredPermissionProviders;
  getConfiguredCapabilityMaterializers: typeof getConfiguredCapabilityMaterializers;
  authorizePermission: typeof authorizePermission;
  localOperatorCan: typeof localOperatorCan;
  materializeSubjectCapabilities: typeof materializeSubjectCapabilities;
  checkAppManifests: typeof checkAppManifests;
  discoverAppManifests: typeof discoverAppManifests;
  getRegistry: typeof getRegistry;
  currentWeakPublicReturnCommands: typeof currentWeakPublicReturnCommands;
  currentCliOnlyCommands: typeof currentCliOnlyCommands;
  queryRows: QueryRows;
  listSpecFiles: () => string[];
  listSkillFiles: () => string[];
  getGitInfo: () => GitInfo;
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  readDir: (path: string) => Dirent[];
  homeDir: () => string;
  cwd: () => string;
  now: () => Date;
};

export interface InspectDoctorOptions {
  domain?: string | null;
}

export interface RunDoctorOptions extends InspectDoctorOptions {
  json?: boolean;
  full?: boolean;
  strict?: boolean;
  setExitCode?: boolean;
}

const DEFAULT_DEPS: DoctorDeps = {
  inspectCliRuntimeTarget,
  getRaviStateDir,
  getRaviDbPath,
  dbListAgents,
  dbListInstances,
  dbListRoutes,
  inspectAgentInstructionFiles,
  listTaskAutomations,
  getRuntimeCompatibilityIssues,
  listRegisteredRuntimeProviderIds,
  getConfiguredPermissionProviders,
  getConfiguredCapabilityMaterializers,
  authorizePermission,
  localOperatorCan,
  materializeSubjectCapabilities,
  checkAppManifests,
  discoverAppManifests,
  getRegistry,
  currentWeakPublicReturnCommands,
  currentCliOnlyCommands,
  queryRows: <T extends Record<string, unknown>>(sql: string, params: SQLQueryBindings[] = []) =>
    getDb()
      .prepare(sql)
      .all(...params) as T[],
  listSpecFiles: () => listFilesUnder(join(process.cwd(), ".ravi", "specs"), "SPEC.md"),
  listSkillFiles: () => [
    ...listFilesUnder(join(process.cwd(), "src", "plugins", "internal"), "SKILL.md"),
    ...listFilesUnder(join(process.cwd(), "src", "skills"), "SKILL.md"),
  ],
  getGitInfo: () => readGitInfo(process.cwd()),
  exists: existsSync,
  readFile: (path: string) => readFileSync(path, "utf8"),
  readDir: (path: string) => readdirSync(path, { withFileTypes: true }),
  homeDir: homedir,
  cwd: () => process.cwd(),
  now: () => new Date(),
};

const SEVERITY_LABEL: Record<DoctorSeverity, string> = {
  error: "ERROR",
  warn: "WARN",
  info: "INFO",
};

const INSTRUCTION_STATE_SEVERITY: Record<AgentInstructionState, LegacyDoctorCheckStatus> = {
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

const MUTATING_VERBS = new Set([
  "add",
  "approve",
  "archive",
  "assign",
  "attach",
  "block",
  "clear",
  "comment",
  "create",
  "cleanup",
  "delete",
  "demote",
  "deny",
  "detach",
  "disable",
  "dispatch",
  "done",
  "enable",
  "execute",
  "fail",
  "grant",
  "import",
  "init",
  "link",
  "merge",
  "mute",
  "push",
  "promote",
  "prune",
  "refresh",
  "recompute",
  "reject",
  "remove",
  "rename",
  "reply",
  "reset",
  "resume",
  "restart",
  "revoke",
  "run",
  "seed",
  "send",
  "set",
  "start",
  "stop",
  "sync",
  "tag",
  "trigger",
  "unlink",
  "unmute",
  "unarchive",
  "untag",
  "update",
  "upsert",
  "write",
]);

const READ_COMMAND_ACCESS_MUTATION_ALLOWLIST = new Set([
  // This command only renders the plan for a policy materialization and never writes.
  "permissions.policies.dry-run",
]);

export function inspectDoctor(overrides: Partial<DoctorDeps> = {}, options: InspectDoctorOptions = {}): DoctorReport {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const checks: LegacyDoctorCheck[] = [];

  const runtimeTarget = deps.inspectCliRuntimeTarget();
  const stateDir = deps.getRaviStateDir();
  const raviDbPath = deps.getRaviDbPath();
  const insightsDbPath = join(stateDir, "insights.db");
  const codexHooksPath = join(deps.homeDir(), ".codex", "hooks.json");

  addCheck(checks, () => buildDaemonCheck(runtimeTarget));
  addCheck(checks, () => buildRuntimeMatchCheck(runtimeTarget));
  addCheck(checks, () => buildDaemonCwdCheck(runtimeTarget));
  addCheck(checks, () => buildStateDirCheck(stateDir, deps));
  addCheck(checks, () => buildRaviDbCheck(raviDbPath, deps));
  addCheck(checks, () => buildInsightsDbCheck(insightsDbPath, deps));
  addCheck(checks, () => buildProviderCompatibilityCheck(deps));
  addCheck(checks, () => buildGitRuntimeCheck(deps));

  const raviDbExists = deps.exists(raviDbPath);
  if (!raviDbExists) {
    addStaticChecks(checks, [
      {
        id: "instances.main",
        title: "Main instance",
        status: "fail",
        summary: "cannot inspect instances because ravi.db is missing",
        details: [raviDbPath],
        fixHint: "restore or initialize ~/.ravi/ravi.db before relying on runtime routing",
        data: { dbPath: raviDbPath },
      },
      {
        id: "runtime.schema_missing",
        domain: "runtime",
        title: "Runtime schema",
        status: "fail",
        summary: "cannot inspect runtime schema because ravi.db is missing",
        details: [raviDbPath],
        fixHint: "restore or initialize ~/.ravi/ravi.db before relying on runtime health checks",
        data: { dbPath: raviDbPath },
      },
      {
        id: "runtime.migration_unverifiable",
        domain: "runtime",
        title: "Runtime migration state",
        status: "fail",
        severity: "warn",
        summary: "cannot verify migration state because ravi.db is missing",
        details: [raviDbPath],
        fixHint: "restore or initialize ~/.ravi/ravi.db, then rerun `ravi doctor`",
        data: { dbPath: raviDbPath },
      },
      {
        id: "agents.registered",
        title: "Registered agents",
        status: "fail",
        summary: "cannot inspect agents because ravi.db is missing",
        details: [raviDbPath],
        fixHint: "restore or initialize ~/.ravi/ravi.db before inspecting workspace health",
        data: { dbPath: raviDbPath },
      },
      {
        id: "agents.instructions",
        title: "AGENTS-first workspaces",
        status: "fail",
        summary: "cannot inspect workspace instructions because ravi.db is missing",
        details: [raviDbPath],
        fixHint: "restore or initialize ~/.ravi/ravi.db, then run `ravi agents sync-instructions --all` if needed",
        data: { dbPath: raviDbPath },
      },
      {
        id: "tasks.automations",
        title: "Task automations substrate",
        status: "fail",
        summary: "cannot inspect task automations because ravi.db is missing",
        details: [raviDbPath],
        fixHint: "restore or initialize ~/.ravi/ravi.db before relying on task automations",
        data: { dbPath: raviDbPath },
      },
    ]);
  } else {
    let agents: ReturnType<typeof dbListAgents> | null = null;
    let instances: ReturnType<typeof dbListInstances> | null = null;
    let routes: ReturnType<typeof dbListRoutes> | null = null;

    addCheck(checks, () => {
      instances = deps.dbListInstances();
      return buildMainInstanceCheck(instances);
    });

    addCheck(checks, () => {
      agents = deps.dbListAgents();
      return buildRegisteredAgentsCheck(agents);
    });

    addCheck(checks, () => {
      if (!agents) {
        agents = deps.dbListAgents();
      }
      return buildAgentInstructionCheck(agents, deps);
    });

    addCheck(checks, () => buildTaskAutomationsCheck(deps));
    addCheck(checks, () => buildRuntimeSchemaCheck(deps));
    addCheck(checks, () => buildRuntimeMigrationCheck(deps));
    addCheck(checks, () => {
      if (!agents) agents = deps.dbListAgents();
      if (!instances) instances = deps.dbListInstances();
      routes = deps.dbListRoutes();
      return buildRouteIntegrityCheck(routes, agents, instances);
    });
    addCheck(checks, () => buildSessionIntegrityCheck(deps));
    addCheck(checks, () => buildChatRouteCoverageCheck(deps));
    addCheck(checks, () => {
      if (!instances) instances = deps.dbListInstances();
      return buildInstanceHealthMetadataCheck(instances);
    });
    addCheck(checks, () => buildInboundIdentityResolutionCheck(deps));
    addCheck(checks, () => buildCostPricingCoverageCheck(deps));
    addCheck(checks, () => buildCostCompletenessCheck(deps));
  }

  addCheck(checks, () => buildCodexHookCheck(codexHooksPath, deps));
  addCheck(checks, () => buildAppManifestCheck(deps));
  addCheck(checks, () => buildAppRegistryCheck(deps));
  addCheck(checks, () => buildDraftSpecProductionCheck(deps));
  addCheck(checks, () => buildSkillSpecReferenceCheck(deps));
  addCheck(checks, () => buildSdkReturnCoverageCheck(deps));
  addCheck(checks, () => buildCliCommandAccessCoverageCheck(deps));
  addCheck(checks, () => buildCliMutationMetadataCheck(deps));
  addCheck(checks, () => buildPermissionProviderRuntimeChainCheck(deps));
  addCheck(checks, () => buildPermissionProviderRuntimeBoundaryCheck(deps));
  addCheck(checks, () => buildPermissionLocalOperatorExplicitCheck(deps));
  addCheck(checks, () => buildPermissionBootstrapScopeCheck(deps));
  const filtered = filterChecksByDomain(checks, options.domain);
  return buildReport(filtered, {
    generatedAt: deps.now().toISOString(),
    runtimeTarget,
    git: deps.getGitInfo(),
    dbPath: raviDbPath,
    cwd: deps.cwd(),
  });
}

export function runDoctor(options: RunDoctorOptions = {}, overrides: Partial<DoctorDeps> = {}): DoctorReport {
  const report = inspectDoctor(overrides, { domain: options.domain });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printDoctorReport(report, { full: options.full === true });
  }

  if (options.setExitCode) {
    process.exitCode = doctorExitCode(report, options.strict === true);
  }
  return report;
}

function addCheck(checks: LegacyDoctorCheck[], build: () => LegacyDoctorCheck): void {
  const started = Date.now();
  try {
    const check = build();
    checks.push({ ...check, durationMs: Date.now() - started });
  } catch (error) {
    checks.push({
      ...buildUnexpectedFailureCheck("doctor.check", "Doctor check", error),
      durationMs: Date.now() - started,
    });
  }
}

function addStaticChecks(checks: LegacyDoctorCheck[], next: LegacyDoctorCheck[]): void {
  for (const check of next) {
    checks.push({ ...check, durationMs: 0 });
  }
}

function buildReport(
  legacyChecks: LegacyDoctorCheck[],
  input: {
    generatedAt: string;
    runtimeTarget: CliRuntimeTargetSummary;
    git: GitInfo;
    dbPath: string;
    cwd: string;
  },
): DoctorReport {
  const findings: DoctorFinding[] = [];
  const checks: DoctorCheck[] = [];

  for (const legacy of legacyChecks) {
    const domain = legacy.domain ?? inferDomain(legacy.id);
    const severity = legacy.severity ?? legacySeverity(legacy.status);
    const status = legacyStatus(legacy.status);
    const finding: DoctorFinding = {
      id: legacy.id,
      severity,
      domain,
      title: legacy.title,
      summary: legacy.summary,
      evidence: detailsToEvidence(legacy.details),
      ...(legacy.fixHint ? { fixHint: legacy.fixHint } : {}),
      ...(legacy.data ? { data: legacy.data } : {}),
    };
    findings.push(finding);
    checks.push({
      id: legacy.id,
      domain,
      title: legacy.title,
      status,
      severity,
      findings: [legacy.id],
      durationMs: legacy.durationMs ?? 0,
      data: legacy.data,
    });
  }

  const summary = summarizeReport(checks, findings);
  const schemaCheck = checks.find((check) => check.id === "runtime.schema_missing");
  const migrationCheck = checks.find((check) => check.id === "runtime.migration_unverifiable");
  const schemaVersion =
    typeof schemaCheck?.data?.userVersion === "number" ? String(schemaCheck.data.userVersion) : undefined;
  const migrationsKnown = migrationCheck ? migrationCheck.status === "pass" : undefined;
  return {
    generatedAt: input.generatedAt,
    ok: summary.errors === 0,
    summary,
    runtime: {
      version: readPackageVersion(),
      branch: input.git.branch,
      commit: input.git.commit,
      dirty: input.git.dirty,
      cwd: input.cwd,
      daemon: {
        online: input.runtimeTarget.daemon.online,
      },
      database: {
        path: input.dbPath,
        ...(schemaVersion ? { schemaVersion } : {}),
        ...(migrationsKnown !== undefined ? { migrationsKnown } : {}),
      },
    },
    findings,
    checks,
  };
}

function summarizeReport(checks: DoctorCheck[], findings: DoctorFinding[]): DoctorReport["summary"] {
  const domains: DoctorReport["summary"]["domains"] = {};
  const summary: DoctorReport["summary"] = {
    errors: 0,
    warnings: 0,
    infos: 0,
    checks: {
      total: checks.length,
      passed: 0,
      failed: 0,
      skipped: 0,
    },
    domains,
  };

  for (const finding of findings) {
    if (finding.severity === "error") summary.errors++;
    if (finding.severity === "warn") summary.warnings++;
    if (finding.severity === "info") summary.infos++;
    const domain = (domains[finding.domain] ??= {
      errors: 0,
      warnings: 0,
      infos: 0,
      totalChecks: 0,
      failedChecks: 0,
      skippedChecks: 0,
    });
    if (finding.severity === "error") domain.errors++;
    if (finding.severity === "warn") domain.warnings++;
    if (finding.severity === "info") domain.infos++;
  }

  for (const check of checks) {
    if (check.status === "pass") summary.checks.passed++;
    if (check.status === "fail") summary.checks.failed++;
    if (check.status === "skip") summary.checks.skipped++;
    const domain = (domains[check.domain] ??= {
      errors: 0,
      warnings: 0,
      infos: 0,
      totalChecks: 0,
      failedChecks: 0,
      skippedChecks: 0,
    });
    domain.totalChecks++;
    if (check.status === "fail") domain.failedChecks++;
    if (check.status === "skip") domain.skippedChecks++;
  }

  return summary;
}

function doctorExitCode(report: DoctorReport, strict: boolean): number {
  if (report.summary.errors > 0) return 1;
  if (strict && report.summary.warnings > 0) return 3;
  return 0;
}

function filterChecksByDomain(checks: LegacyDoctorCheck[], domain: string | null | undefined): LegacyDoctorCheck[] {
  const normalized = domain?.trim();
  if (!normalized) return checks;
  return checks.filter((check) => (check.domain ?? inferDomain(check.id)) === normalized);
}

function legacySeverity(status: LegacyDoctorCheckStatus): DoctorSeverity {
  if (status === "fail") return "error";
  if (status === "warn") return "warn";
  return "info";
}

function legacyStatus(status: LegacyDoctorCheckStatus): DoctorCheckStatus {
  if (status === "ok") return "pass";
  if (status === "skip") return "skip";
  return "fail";
}

function detailsToEvidence(details: string[] | undefined): DoctorEvidence[] {
  return (details ?? []).slice(0, 12).map((detail) => ({ label: detail }));
}

function inferDomain(id: string): string {
  if (id.startsWith("apps.") || id.startsWith("specs.") || id.startsWith("skills.") || id.startsWith("sdk.")) {
    return "apps";
  }
  if (id.startsWith("permissions.")) return "permissions";
  if (id.startsWith("costs.")) return "costs";
  if (id.startsWith("routes.") || id.startsWith("sessions.") || id.startsWith("chats.")) return "sessions";
  if (id.startsWith("channels.") || id.startsWith("instances.")) return "channels";
  return "runtime";
}

function buildDaemonCheck(summary: CliRuntimeTargetSummary): LegacyDoctorCheck {
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

function buildRuntimeMatchCheck(summary: CliRuntimeTargetSummary): LegacyDoctorCheck {
  if (!summary.daemon.online) {
    return {
      id: "runtime.bundle-match",
      title: "CLI/runtime match",
      status: "skip",
      severity: "warn",
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

function buildDaemonCwdCheck(summary: CliRuntimeTargetSummary): LegacyDoctorCheck {
  if (!summary.daemon.online) {
    return {
      id: "runtime.daemon-cwd",
      title: "Daemon cwd trust",
      status: "skip",
      severity: "warn",
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

function buildGitRuntimeCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const git = deps.getGitInfo();
  const details = [
    `branch: ${git.branch ?? "-"}`,
    `commit: ${git.commit ?? "-"}`,
    `dirty: ${git.dirty === true ? "yes" : "no"}`,
  ];
  if (typeof git.behind === "number" && git.behind > 0) details.push(`behind: ${git.behind}`);
  if (typeof git.ahead === "number" && git.ahead > 0) details.push(`ahead: ${git.ahead}`);

  if ((git.behind ?? 0) > 0) {
    return {
      id: "runtime.branch_drift",
      title: "Git branch drift",
      status: "warn",
      summary: `current branch is behind upstream by ${git.behind} commit(s)`,
      details,
      fixHint: "pull/rebase before release or deploy work",
      data: git,
    };
  }

  return {
    id: "runtime.branch_drift",
    title: "Git branch drift",
    status: "ok",
    summary: git.dirty ? "git branch is current, with local dirty worktree context" : "git branch appears current",
    details,
    data: git,
  };
}

function buildStateDirCheck(stateDir: string, deps: DoctorDeps): LegacyDoctorCheck {
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

function buildRaviDbCheck(dbPath: string, deps: DoctorDeps): LegacyDoctorCheck {
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

function buildInsightsDbCheck(dbPath: string, deps: DoctorDeps): LegacyDoctorCheck {
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

function buildMainInstanceCheck(instances: ReturnType<typeof dbListInstances>): LegacyDoctorCheck {
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

function buildRegisteredAgentsCheck(agents: ReturnType<typeof dbListAgents>): LegacyDoctorCheck {
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

function buildAgentInstructionCheck(agents: ReturnType<typeof dbListAgents>, deps: DoctorDeps): LegacyDoctorCheck {
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

function buildTaskAutomationsCheck(deps: DoctorDeps): LegacyDoctorCheck {
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

function buildRuntimeSchemaCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const requiredTables = [
    "agents",
    "instances",
    "routes",
    "chats",
    "relations",
    "message_metadata",
    "cost_events",
    "session_turns",
  ];
  const rows = deps.queryRows<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
  const existing = new Set(rows.map((row) => row.name).filter(Boolean));
  const missing = requiredTables.filter((table) => !existing.has(table));
  const userVersionRows = deps.queryRows<{ user_version?: number }>("PRAGMA user_version");
  const userVersion = Number(userVersionRows[0]?.user_version ?? 0);

  if (missing.length > 0) {
    return {
      id: "runtime.schema_missing",
      domain: "runtime",
      title: "Runtime schema",
      status: "fail",
      summary: `${missing.length} required runtime table(s) are missing`,
      details: missing,
      fixHint:
        "run the runtime database initialization/migration path before trusting router, sessions, costs or permissions",
      data: {
        userVersion,
        requiredTables,
        missingTables: missing,
      },
    };
  }

  return {
    id: "runtime.schema_missing",
    domain: "runtime",
    title: "Runtime schema",
    status: "ok",
    summary: `${requiredTables.length} required runtime table(s) are present`,
    data: {
      userVersion,
      requiredTables,
      missingTables: [],
    },
  };
}

function buildRuntimeMigrationCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const knownLedgerTables = ["schema_migrations", "migrations", "migration_ledger", "db_migrations"];
  const rows = deps.queryRows<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
  const existing = new Set(rows.map((row) => row.name).filter(Boolean));
  const ledgers = knownLedgerTables.filter((table) => existing.has(table));

  if (ledgers.length === 0) {
    return {
      id: "runtime.migration_unverifiable",
      domain: "runtime",
      title: "Runtime migration state",
      status: "warn",
      summary: "runtime schema is present but migration state has no verifiable ledger",
      details: ["no schema_migrations/migrations/migration_ledger/db_migrations table found"],
      fixHint: "introduce a migration ledger or explicit schema version check before using doctor as a release gate",
      data: {
        knownLedgerTables,
        foundLedgerTables: [],
      },
    };
  }

  return {
    id: "runtime.migration_unverifiable",
    domain: "runtime",
    title: "Runtime migration state",
    status: "ok",
    summary: `migration ledger available: ${ledgers.join(", ")}`,
    data: {
      knownLedgerTables,
      foundLedgerTables: ledgers,
    },
  };
}

function buildRouteIntegrityCheck(
  routes: ReturnType<typeof dbListRoutes>,
  agents: ReturnType<typeof dbListAgents>,
  instances: ReturnType<typeof dbListInstances>,
): LegacyDoctorCheck {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const instanceNames = new Set(instances.map((instance) => instance.name));
  const missingAgents = routes.filter((route) => !agentIds.has(route.agent));
  const missingInstances = routes.filter((route) => !instanceNames.has(route.accountId));
  const duplicateKeys = duplicateRouteKeys(routes);

  const details = [
    ...limitIssueDetails(
      missingAgents.map((route) => `${route.id ?? "-"} ${route.accountId}/${route.pattern} -> ${route.agent}`),
      "missing-agent",
    ),
    ...limitIssueDetails(
      missingInstances.map((route) => `${route.id ?? "-"} ${route.accountId}/${route.pattern}`),
      "missing-instance",
    ),
    ...limitIssueDetails(duplicateKeys, "duplicate"),
  ];

  if (missingAgents.length > 0) {
    return {
      id: "routes.agent_missing",
      domain: "sessions",
      title: "Route agent integrity",
      status: "fail",
      summary: `${missingAgents.length} active route(s) point to missing agents`,
      details,
      fixHint: "recreate the missing agent or update/delete the affected route",
      data: {
        missingAgents: missingAgents.length,
        missingInstances: missingInstances.length,
        duplicateEffectiveRoutes: duplicateKeys.length,
      },
    };
  }

  if (missingInstances.length > 0) {
    return {
      id: "routes.instance_missing",
      domain: "sessions",
      title: "Route instance integrity",
      status: "fail",
      summary: `${missingInstances.length} active route(s) point to missing instances`,
      details,
      fixHint: "restore the instance or update/delete the affected route",
      data: {
        missingAgents: missingAgents.length,
        missingInstances: missingInstances.length,
        duplicateEffectiveRoutes: duplicateKeys.length,
      },
    };
  }

  if (duplicateKeys.length > 0) {
    return {
      id: "routes.duplicate_effective_route",
      domain: "sessions",
      title: "Route uniqueness",
      status: "warn",
      summary: `${duplicateKeys.length} duplicate effective route key(s) found`,
      details,
      fixHint: "dedupe route rows with the same effective channel/account/pattern",
      data: { duplicateEffectiveRoutes: duplicateKeys },
    };
  }

  return {
    id: "routes.integrity",
    domain: "sessions",
    title: "Route integrity",
    status: "ok",
    summary: `${routes.length} active route(s) have valid agents and instances`,
    data: { total: routes.length },
  };
}

function duplicateRouteKeys(routes: ReturnType<typeof dbListRoutes>): string[] {
  const counts = new Map<string, number>();
  for (const route of routes) {
    const key = `${route.channel ?? ""}:${route.accountId}:${route.pattern}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key, count]) => `${key} (${count})`)
    .sort((a, b) => a.localeCompare(b));
}

function buildSessionIntegrityCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const orphanSessions = deps.queryRows<{ session_key: string; name: string | null; agent_id: string }>(
    `SELECT s.session_key, s.name, s.agent_id
       FROM sessions s
       LEFT JOIN agents a ON a.id = s.agent_id
      WHERE a.id IS NULL
      ORDER BY s.updated_at DESC
      LIMIT 25`,
  );
  const aborted =
    deps.queryRows<{ total: number }>(
      "SELECT COUNT(*) AS total FROM sessions WHERE COALESCE(aborted_last_run, 0) = 1",
    )[0]?.total ?? 0;
  const noProvider =
    deps.queryRows<{ total: number }>(
      "SELECT COUNT(*) AS total FROM sessions WHERE runtime_provider IS NULL OR runtime_provider = ''",
    )[0]?.total ?? 0;

  if (orphanSessions.length > 0) {
    return {
      id: "sessions.agent_missing",
      domain: "sessions",
      title: "Session agent integrity",
      status: "fail",
      summary: `${orphanSessions.length} sampled session(s) point to missing agents`,
      details: orphanSessions.map((row) => `${row.name ?? row.session_key} -> ${row.agent_id}`),
      fixHint: "restore the agent or reassign/delete the affected session",
      data: { sampled: orphanSessions, aborted, noProvider },
    };
  }

  if (aborted > 0) {
    return {
      id: "sessions.aborted_last_run",
      domain: "sessions",
      title: "Aborted session runs",
      status: "warn",
      summary: `${aborted} session(s) have aborted_last_run set`,
      fixHint: "inspect session traces before assuming the agent is healthy",
      data: { aborted, noProvider },
    };
  }

  return {
    id: "sessions.integrity",
    domain: "sessions",
    title: "Session integrity",
    status: "ok",
    summary:
      noProvider > 0
        ? `sessions are linked to agents; ${noProvider} have no runtime provider`
        : "sessions are linked to agents",
    data: { orphanSessions: 0, aborted, noProvider },
  };
}

function buildChatRouteCoverageCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const rows = deps.queryRows<{ total: number }>(
    `SELECT COUNT(*) AS total
       FROM chats c
      WHERE c.chat_type IN ('group', 'dm')
        AND NOT EXISTS (
          SELECT 1 FROM routes r
           WHERE r.deleted_at IS NULL
             AND r.account_id = c.instance_id
             AND (
               r.pattern = c.normalized_chat_id
               OR r.pattern = c.platform_chat_id
               OR r.pattern = ('group:' || c.normalized_chat_id)
               OR r.pattern = ('dm:' || c.normalized_chat_id)
             )
        )`,
  );
  const total = rows[0]?.total ?? 0;
  if (total > 0) {
    return {
      id: "chats.eligible_without_route",
      domain: "sessions",
      title: "Chat route coverage",
      status: "ok",
      severity: "info",
      summary: `${total} group/dm chat(s) do not have a direct route`,
      fixHint: "treat as drift only for chats expected to be actively routed",
      data: { total },
    };
  }
  return {
    id: "chats.eligible_without_route",
    domain: "sessions",
    title: "Chat route coverage",
    status: "ok",
    summary: "all eligible group/dm chats have direct routes",
    data: { total: 0 },
  };
}

function buildInstanceHealthMetadataCheck(instances: ReturnType<typeof dbListInstances>): LegacyDoctorCheck {
  const enabled = instances.filter((instance) => instance.enabled !== false);
  const missingInstanceId = enabled.filter((instance) => !instance.instanceId);
  if (missingInstanceId.length > 0) {
    return {
      id: "channels.instance_health_missing",
      domain: "channels",
      title: "Instance health metadata",
      status: "warn",
      summary: `${missingInstanceId.length} enabled instance(s) have no provider instance id`,
      details: missingInstanceId.map((instance) => `${instance.name} (${instance.channel})`),
      fixHint: "configure provider instance ids or mark non-live instances disabled",
      data: { enabled: enabled.length, missingInstanceId: missingInstanceId.length },
    };
  }

  return {
    id: "channels.instance_health_missing",
    domain: "channels",
    title: "Instance health metadata",
    status: "ok",
    summary: `${enabled.length} enabled instance(s) expose provider instance ids`,
    data: { enabled: enabled.length },
  };
}

function buildInboundIdentityResolutionCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const since = deps.now().getTime() - 24 * 60 * 60 * 1000;
  const rows = deps.queryRows<{
    total: number;
    unresolved_actor: number;
    unresolved_owner: number;
  }>(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN actor_type IS NULL OR actor_type = '' OR actor_type = 'unknown' THEN 1 ELSE 0 END) AS unresolved_actor,
       SUM(CASE WHEN contact_id IS NULL AND agent_id IS NULL THEN 1 ELSE 0 END) AS unresolved_owner
     FROM message_metadata
     WHERE created_at >= ?`,
    [since],
  );
  const row = rows[0] ?? { total: 0, unresolved_actor: 0, unresolved_owner: 0 };
  const unresolvedActor = Number(row.unresolved_actor ?? 0);
  const unresolvedOwner = Number(row.unresolved_owner ?? 0);

  if (unresolvedActor > 0) {
    return {
      id: "channels.inbound_actor_unresolved",
      domain: "channels",
      title: "Inbound actor resolution",
      status: "fail",
      summary: `${unresolvedActor} recent inbound metadata row(s) lack actor resolution`,
      fixHint: "fix platform identity to actor resolution before routing/policy debugging",
      data: row,
    };
  }
  if (unresolvedOwner > 0) {
    return {
      id: "channels.inbound_contact_unresolved",
      domain: "channels",
      title: "Inbound owner resolution",
      status: "fail",
      summary: `${unresolvedOwner} recent inbound metadata row(s) lack contact/agent resolution`,
      fixHint: "fix platform identity to contact/agent resolution before routing/policy debugging",
      data: row,
    };
  }
  return {
    id: "channels.inbound_actor_unresolved",
    domain: "channels",
    title: "Inbound identity resolution",
    status: "ok",
    summary: `${row.total ?? 0} recent inbound metadata row(s) have actor and owner resolution`,
    data: row,
  };
}

function buildCostPricingCoverageCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const since = deps.now().getTime() - 7 * 24 * 60 * 60 * 1000;
  const rows = deps.queryRows<{
    model: string;
    pricing_status: string;
    events: number;
    tokens: number;
    total_cost: number;
  }>(
    `SELECT
       model,
       pricing_status,
       COUNT(*) AS events,
       SUM(input_tokens + output_tokens + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)) AS tokens,
       SUM(total_cost_usd) AS total_cost
     FROM cost_events
     WHERE created_at >= ?
     GROUP BY model, pricing_status
     ORDER BY events DESC
     LIMIT 50`,
    [since],
  );
  const unpriced = rows.filter((row) => row.pricing_status !== "priced" && Number(row.tokens ?? 0) > 0);
  if (unpriced.length > 0) {
    return {
      id: "costs.pricing_unpriced_usage",
      domain: "costs",
      title: "Cost pricing coverage",
      status: "warn",
      summary: `${unpriced.length} recent provider/model pricing bucket(s) have token usage without pricing`,
      details: unpriced.slice(0, 8).map((row) => `${row.model}: ${row.events} events, ${row.tokens} tokens`),
      fixHint: "add pricing aliases/catalog coverage, then recompute pricing metadata explicitly",
      data: { unpriced, sampledBuckets: rows.length },
    };
  }
  return {
    id: "costs.pricing_unpriced_usage",
    domain: "costs",
    title: "Cost pricing coverage",
    status: "ok",
    summary: `${rows.length} recent pricing bucket(s) checked`,
    data: { buckets: rows.length },
  };
}

function buildCostCompletenessCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const since = deps.now().getTime() - 7 * 24 * 60 * 60 * 1000;
  const row = deps.queryRows<{ total: number }>(
    `SELECT COUNT(*) AS total
       FROM cost_events
      WHERE created_at >= ?
        AND input_tokens = 0
        AND output_tokens = 0
        AND COALESCE(cache_read_tokens, 0) = 0
        AND COALESCE(cache_creation_tokens, 0) = 0`,
    [since],
  )[0];
  const total = Number(row?.total ?? 0);
  if (total > 0) {
    return {
      id: "costs.event_incomplete_usage",
      domain: "costs",
      title: "Cost event completeness",
      status: "warn",
      summary: `${total} recent cost event(s) have zero token usage`,
      fixHint: "verify provider usage extraction before trusting cost rollups",
      data: { total },
    };
  }
  return {
    id: "costs.event_incomplete_usage",
    domain: "costs",
    title: "Cost event completeness",
    status: "ok",
    summary: "recent cost events include token usage",
    data: { total: 0 },
  };
}

function buildAppManifestCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const results = deps.checkAppManifests(undefined, { cwd: deps.cwd() });
  const invalid = results.filter((result) => !result.ok);
  if (invalid.length > 0) {
    return {
      id: "apps.manifest.invalid",
      domain: "apps",
      title: "App manifests",
      status: "fail",
      summary: `${invalid.length} app manifest(s) are invalid`,
      details: invalid.flatMap((app) => [`${app.id}: ${app.path}`, ...app.errors.slice(0, 3)]),
      fixHint: "run `ravi apps check --json` and fix the manifest errors",
      data: { checked: results.length, invalid },
    };
  }
  const warnings = results.filter((result) => result.warnings.length > 0);
  if (warnings.length > 0) {
    return {
      id: "apps.manifest.invalid",
      domain: "apps",
      title: "App manifests",
      status: "warn",
      summary: `${warnings.length} app manifest(s) have warnings`,
      details: warnings.flatMap((app) => [`${app.id}: ${app.path}`, ...app.warnings.slice(0, 3)]),
      fixHint: "run `ravi apps check --json` and review manifest warnings",
      data: { checked: results.length, warnings },
    };
  }
  return {
    id: "apps.manifest.invalid",
    domain: "apps",
    title: "App manifests",
    status: "ok",
    summary: `${results.length} app manifest(s) are valid`,
    data: { checked: results.length },
  };
}

function buildAppRegistryCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const records = deps.discoverAppManifests({ cwd: deps.cwd() });
  const repo = records
    .filter((record) => record.source === "repo")
    .map((record) => record.id)
    .sort();
  const state = records
    .filter((record) => record.source === "state")
    .map((record) => record.id)
    .sort();
  if (repo.length === 1 && repo[0] === "apps" && state.length > 0) {
    return {
      id: "apps.registry.meta_only",
      domain: "apps",
      title: "App registry source coverage",
      status: "warn",
      summary: `repo registry only exposes meta-app while state has ${state.length} app(s)`,
      details: [`repo: ${repo.join(", ")}`, `state: ${state.join(", ")}`],
      fixHint: "decide whether state apps should be source-controlled or explicitly local-only",
      data: { repo, state },
    };
  }
  return {
    id: "apps.registry.meta_only",
    domain: "apps",
    title: "App registry source coverage",
    status: "ok",
    summary: `${records.length} app manifest(s) discovered across sources`,
    data: { repo, state, total: records.length },
  };
}

function buildDraftSpecProductionCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const draftProduction = deps
    .listSpecFiles()
    .map((path) => ({ path, content: safeRead(path, deps) }))
    .filter((entry) => /^status:\s*draft\s*$/m.test(entry.content))
    .filter((entry) => specAppliesToProduction(entry.content))
    .map((entry) => normalizeRelative(deps.cwd(), entry.path))
    .sort();

  if (draftProduction.length > 0) {
    return {
      id: "specs.draft_applies_to_production",
      domain: "apps",
      title: "Draft specs on production code",
      status: "warn",
      summary: `${draftProduction.length} draft spec(s) apply to production code`,
      details: limitStrings(draftProduction, 12),
      fixHint: "promote stable specs or keep draft status intentional for experimental production surfaces",
      data: { total: draftProduction.length, examples: draftProduction.slice(0, 20) },
    };
  }
  return {
    id: "specs.draft_applies_to_production",
    domain: "apps",
    title: "Draft specs on production code",
    status: "ok",
    summary: "no draft specs apply to production code",
    data: { total: 0 },
  };
}

function buildSkillSpecReferenceCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const missing: string[] = [];
  for (const path of deps.listSkillFiles()) {
    const content = safeRead(path, deps);
    for (const specId of extractSpecReferences(content)) {
      const specPath = join(deps.cwd(), ".ravi", "specs", specId, "SPEC.md");
      if (!deps.exists(specPath)) {
        missing.push(`${normalizeRelative(deps.cwd(), path)} -> ${specId}`);
      }
    }
  }

  if (missing.length > 0) {
    return {
      id: "skills.spec_reference_missing",
      domain: "apps",
      title: "Skill spec references",
      status: "warn",
      summary: `${missing.length} skill spec reference(s) point to missing specs`,
      details: limitStrings(missing, 12),
      fixHint: "fix the skill reference or create the missing spec before relying on that skill",
      data: { total: missing.length, examples: missing.slice(0, 20) },
    };
  }
  return {
    id: "skills.spec_reference_missing",
    domain: "apps",
    title: "Skill spec references",
    status: "ok",
    summary: "skill spec references resolve",
    data: { total: 0 },
  };
}

function buildSdkReturnCoverageCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const registry = deps.getRegistry();
  const publicCommands = registry.commands.filter((command) => !command.cliOnly);
  const missing = publicCommands
    .filter((command) => !command.binary && !command.returns)
    .map((command) => command.fullName)
    .sort();
  const weak = deps.currentWeakPublicReturnCommands(registry);
  const cliOnly = deps.currentCliOnlyCommands(registry);

  if (missing.length > 0) {
    return {
      id: "sdk.returns.missing_public",
      domain: "apps",
      title: "SDK return coverage",
      status: "fail",
      summary: `${missing.length} public command(s) lack @Returns`,
      details: limitStrings(missing, 12),
      fixHint: "add @Returns or @Returns.binary before exposing the command to SDK/OpenAPI",
      data: { publicCommands: publicCommands.length, missing, weak, cliOnly },
    };
  }
  if (weak.length > 0) {
    return {
      id: "sdk.returns.weak_public_new",
      domain: "apps",
      title: "SDK return coverage",
      status: "warn",
      summary: `${weak.length} public command(s) have weak return schemas`,
      details: limitStrings(weak, 12),
      fixHint: "tighten weak return schemas and run `ravi sdk returns validate --json`",
      data: { publicCommands: publicCommands.length, missing, weak, cliOnly },
    };
  }
  return {
    id: "sdk.returns.missing_public",
    domain: "apps",
    title: "SDK return coverage",
    status: "ok",
    summary: `${publicCommands.length} public command(s) have typed returns`,
    data: { publicCommands: publicCommands.length, missing: 0, weak: 0, cliOnly: cliOnly.length },
  };
}

function buildCliMutationMetadataCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const registry = deps.getRegistry();
  const missing = openMutatingCandidates(registry);
  const readMutating = readAccessMutatingCandidates(registry);
  if (missing.length > 0 || readMutating.length > 0) {
    const details = [
      ...missing.map((command) => `missing @CommandAccess: ${command}`),
      ...readMutating.map((command) => `read access on mutating action: ${command}`),
    ];
    return {
      id: "permissions.command_mutation_unclassified",
      domain: "permissions",
      title: "CLI mutation metadata",
      status: "fail",
      severity: "error",
      summary: `${missing.length + readMutating.length} command access metadata issue(s) need review`,
      details: limitStrings(details, 12),
      fixHint:
        'declare mutating commands as @CommandAccess({ kind: "mutate", ... }) or add an explicit allowlist entry for true read-only verbs',
      data: {
        total: missing.length + readMutating.length,
        missing,
        readMutating,
        examples: details.slice(0, 20),
      },
    };
  }
  return {
    id: "permissions.command_mutation_unclassified",
    domain: "permissions",
    title: "CLI mutation metadata",
    status: "ok",
    summary: "no open-scope mutating candidates found by heuristic",
    data: { total: 0 },
  };
}

function buildCliCommandAccessCoverageCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const registry = deps.getRegistry();
  const publicCommands = registry.commands.filter((command) => !command.cliOnly);
  const missing = publicCommands
    .filter((command) => !command.access)
    .map((command) => command.fullName)
    .sort((a, b) => a.localeCompare(b));
  const annotated = publicCommands.length - missing.length;

  if (missing.length > 0) {
    return {
      id: "permissions.command_access.coverage",
      domain: "permissions",
      title: "CLI command access coverage",
      status: "fail",
      summary: `${missing.length} public command(s) lack @CommandAccess`,
      details: limitStrings(missing, 12),
      fixHint: "add @CommandAccess to every public non-CLI-only command before treating CLI authorization as complete",
      data: {
        publicCommands: publicCommands.length,
        annotated,
        missing: missing.length,
        examples: missing.slice(0, 20),
      },
    };
  }

  return {
    id: "permissions.command_access.coverage",
    domain: "permissions",
    title: "CLI command access coverage",
    status: "ok",
    summary: `${annotated}/${publicCommands.length} public command(s) declare @CommandAccess`,
    data: {
      publicCommands: publicCommands.length,
      annotated,
      missing: 0,
      examples: [],
    },
  };
}

function openMutatingCandidates(registry: RegistrySnapshot): string[] {
  return registry.commands
    .filter((command) => !command.cliOnly)
    .filter((command) => command.scope === "open")
    .filter((command) => !command.access)
    .filter((command) => isLikelyMutatingCommand(command.fullName))
    .map((command) => command.fullName)
    .sort((a, b) => a.localeCompare(b));
}

function readAccessMutatingCandidates(registry: RegistrySnapshot): string[] {
  return registry.commands
    .filter((command) => !command.cliOnly)
    .filter((command) => command.access?.kind === "read")
    .filter((command) => !READ_COMMAND_ACCESS_MUTATION_ALLOWLIST.has(command.fullName))
    .filter((command) => isLikelyMutatingCommand(command.access?.action ?? command.fullName))
    .map((command) => command.fullName)
    .sort((a, b) => a.localeCompare(b));
}

function isLikelyMutatingCommand(fullName: string): boolean {
  const parts = fullName.split(/[^a-zA-Z0-9]+/);
  return parts.some((part) => MUTATING_VERBS.has(part));
}

function buildPermissionProviderRuntimeChainCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const authorizationProviders = deps.getConfiguredPermissionProviders().map((provider) => provider.id);
  const capabilityMaterializers = deps.getConfiguredCapabilityMaterializers().map((provider) => provider.id);
  const expectedAuthorization = ["local-operator", "context-capabilities"];
  const expectedMaterializers = ["runtime-bootstrap"];
  const authOk = sameStringList(authorizationProviders, expectedAuthorization);
  const materializersOk = sameStringList(capabilityMaterializers, expectedMaterializers);

  if (!authOk || !materializersOk) {
    return {
      id: "permissions.provider_runtime_default_chain",
      domain: "permissions",
      title: "Permission provider runtime default chain",
      status: "fail",
      severity: "error",
      summary: "default permission provider chain drifted from the provider-runtime contract",
      details: [
        `authorization: ${authorizationProviders.join(", ") || "(none)"}`,
        `materializers: ${capabilityMaterializers.join(", ") || "(none)"}`,
      ],
      fixHint: "restore provider-registry defaults or document the explicit production provider configuration",
      data: {
        authorizationProviders,
        capabilityMaterializers,
        expectedAuthorization,
        expectedMaterializers,
      },
    };
  }

  return {
    id: "permissions.provider_runtime_default_chain",
    domain: "permissions",
    title: "Permission provider runtime default chain",
    status: "ok",
    summary: "default authorization and capability materializer chains match the provider-runtime contract",
    data: {
      authorizationProviders,
      capabilityMaterializers,
    },
  };
}

function buildPermissionProviderRuntimeBoundaryCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const providerRuntimePath = join(deps.cwd(), "src", "permissions", "provider-runtime.ts");
  const enginePath = join(deps.cwd(), "src", "permissions", "engine.ts");
  const providerRuntimeSource = deps.exists(providerRuntimePath) ? deps.readFile(providerRuntimePath) : "";
  const forbiddenImportPattern =
    /from\s+["']\.\/(?:engine|capability-context|relations|local-grants-provider)(?:\.js)?["']/;
  const failures: string[] = [];

  if (deps.exists(enginePath)) {
    failures.push("src/permissions/engine.ts still exists");
  }
  if (!providerRuntimeSource) {
    failures.push("src/permissions/provider-runtime.ts is missing or unreadable");
  } else if (forbiddenImportPattern.test(providerRuntimeSource)) {
    failures.push("provider-runtime imports a legacy grant evaluator/store directly");
  }

  if (failures.length > 0) {
    return {
      id: "permissions.provider_runtime_boundaries",
      domain: "permissions",
      title: "Permission provider runtime boundaries",
      status: "fail",
      severity: "error",
      summary: "provider-runtime boundary checks failed",
      details: failures,
      fixHint: "keep legacy grant stores behind explicit providers and keep deleted native engines out of source",
      data: { failures },
    };
  }

  return {
    id: "permissions.provider_runtime_boundaries",
    domain: "permissions",
    title: "Permission provider runtime boundaries",
    status: "ok",
    summary: "provider-runtime facade is isolated from native engines and legacy grant stores",
    data: { enginePresent: false },
  };
}

function buildPermissionLocalOperatorExplicitCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const implicit = deps.authorizePermission({
    permission: "admin",
    objectType: "system",
    objectId: "*",
  });
  const explicitAllowed = deps.localOperatorCan("admin", "system", "*");

  if (implicit.allowed || !explicitAllowed) {
    return {
      id: "permissions.local_operator_explicit",
      domain: "permissions",
      title: "Explicit local operator authorization",
      status: "fail",
      severity: "error",
      summary: "local operator authorization is not explicit and fail-closed",
      details: [
        `implicit no-subject decision: ${implicit.allowed ? "allowed" : "denied"} (${implicit.reasonCode})`,
        `explicit local operator decision: ${explicitAllowed ? "allowed" : "denied"}`,
      ],
      fixHint: "missing subject/context requests must deny; direct local CLI must opt into localOperator explicitly",
      data: {
        implicitAllowed: implicit.allowed,
        implicitReasonCode: implicit.reasonCode,
        explicitAllowed,
      },
    };
  }

  return {
    id: "permissions.local_operator_explicit",
    domain: "permissions",
    title: "Explicit local operator authorization",
    status: "ok",
    summary: "missing subject/context denies unless the caller explicitly requests local operator mode",
    data: {
      implicitAllowed: false,
      explicitAllowed: true,
    },
  };
}

function buildPermissionBootstrapScopeCheck(deps: DoctorDeps): LegacyDoctorCheck {
  const contactCapabilities = deps.materializeSubjectCapabilities("contact", "doctor-contact");
  const chatCapabilities = deps.materializeSubjectCapabilities("chat", "doctor-chat");
  const agentCapabilities = deps.materializeSubjectCapabilities("agent", "doctor-agent");
  const automationCapabilities = deps.materializeSubjectCapabilities("automation", "doctor-automation");
  const privilegedBootstrap = [...agentCapabilities, ...automationCapabilities].filter(
    (capability) =>
      capability.permission === "admin" ||
      (capability.objectType === "toolgroup" && capability.permission === "admin") ||
      (capability.objectType === "group" && capability.permission === "admin"),
  );
  const failures: string[] = [];

  if (contactCapabilities.length > 0)
    failures.push(`contact bootstrap grants ${contactCapabilities.length} capability`);
  if (chatCapabilities.length > 0) failures.push(`chat bootstrap grants ${chatCapabilities.length} capability`);
  if (privilegedBootstrap.length > 0) {
    failures.push(`bootstrap grants ${privilegedBootstrap.length} admin capability`);
  }

  if (failures.length > 0) {
    return {
      id: "permissions.runtime_bootstrap_scope",
      domain: "permissions",
      title: "Runtime bootstrap scope",
      status: "fail",
      severity: "error",
      summary: "runtime bootstrap still grants actor/surface or admin authority",
      details: failures,
      fixHint:
        "bootstrap may bridge executor operation only; actor/surface and admin authority must come from real providers",
      data: {
        contactCapabilities: contactCapabilities.length,
        chatCapabilities: chatCapabilities.length,
        privilegedBootstrap: privilegedBootstrap.length,
      },
    };
  }

  return {
    id: "permissions.runtime_bootstrap_scope",
    domain: "permissions",
    title: "Runtime bootstrap scope",
    status: "ok",
    summary: "runtime bootstrap does not grant actor/surface or admin authority",
    data: {
      contactCapabilities: 0,
      chatCapabilities: 0,
      privilegedBootstrap: 0,
    },
  };
}

function sameStringList(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => value === expected[index]);
}

function buildUnexpectedFailureCheck(id: string, title: string, error: unknown): LegacyDoctorCheck {
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

function buildProviderCompatibilityCheck(deps: DoctorDeps): LegacyDoctorCheck {
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

function buildCodexHookCheck(hooksPath: string, deps: DoctorDeps): LegacyDoctorCheck {
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
      fixHint:
        "rewrite ~/.codex/hooks.json so `PreToolUse` for `^(Bash|shell)$` points at `ravi context codex-bash-hook`",
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
    if (matcher !== "^(Bash|shell)$" || !Array.isArray(handlers)) {
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

function printDoctorReport(report: DoctorReport, options: { full?: boolean } = {}): void {
  console.log("\nRavi doctor\n");
  console.log(
    `Summary: ${report.summary.errors} error, ${report.summary.warnings} warn, ${report.summary.infos} info (${report.summary.checks.total} checks)`,
  );

  if (options.full) {
    console.log(
      `Runtime: ${report.runtime.version ?? "-"} ${report.runtime.branch ?? "-"} ${report.runtime.commit ?? "-"}`,
    );
  }

  for (const severity of ["error", "warn", "info"] as const) {
    const findings = report.findings.filter((finding) => finding.severity === severity);
    if (findings.length === 0) continue;
    if (severity === "info" && !options.full) {
      console.log(`\n[INFO] ${findings.length} informational finding(s). Use --full to show them.`);
      continue;
    }
    console.log(`\n${SEVERITY_LABEL[severity]}`);
    for (const finding of findings) {
      console.log(`- ${finding.id}: ${finding.summary}`);
      if (options.full) {
        for (const evidence of finding.evidence) {
          console.log(`  - ${evidence.label}${evidence.value !== undefined ? `: ${evidence.value}` : ""}`);
        }
        if (finding.fixHint) {
          console.log(`  fix: ${finding.fixHint}`);
        }
      }
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

function limitStrings(entries: string[], limit: number): string[] {
  const selected = entries.slice(0, limit);
  if (entries.length > limit) selected.push(`+${entries.length - limit} more`);
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

function listFilesUnder(root: string, fileName: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== "dist") {
          visit(path, depth + 1);
        }
      } else if (entry.isFile() && entry.name === fileName) {
        found.push(path);
      }
    }
  };
  visit(root, 0);
  return found.sort();
}

function safeRead(path: string, deps: DoctorDeps): string {
  try {
    return deps.readFile(path);
  } catch {
    return "";
  }
}

function specAppliesToProduction(content: string): boolean {
  const appliesToMatch = content.match(/applies_to:\n([\s\S]*?)(?:\n[a-zA-Z_]+:|\n---)/);
  const body = appliesToMatch?.[1] ?? "";
  return /-\s+(src\/|packages\/|bin\/)/.test(body);
}

function extractSpecReferences(content: string): string[] {
  const refs = new Set<string>();
  const patterns = [/ravi\s+specs\s+get\s+([a-z0-9][a-z0-9/-]*)/gi, /specs\s+get\s+([a-z0-9][a-z0-9/-]*)/gi];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) refs.add(match[1]);
    }
  }
  return Array.from(refs).sort((a, b) => a.localeCompare(b));
}

function normalizeRelative(root: string, path: string): string {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath.startsWith(normalizedRoot) ? normalizedPath.slice(normalizedRoot.length + 1) : normalizedPath;
}

function readGitInfo(cwd: string): GitInfo {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    const branchLine = execFileSync("git", ["status", "-sb"], { cwd, encoding: "utf8" }).split("\n")[0] ?? "";
    const ahead = Number(branchLine.match(/ahead (\d+)/)?.[1] ?? 0);
    const behind = Number(branchLine.match(/behind (\d+)/)?.[1] ?? 0);
    return {
      branch,
      commit,
      dirty: porcelain.trim().length > 0,
      ahead,
      behind,
    };
  } catch {
    return {};
  }
}

function readPackageVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
