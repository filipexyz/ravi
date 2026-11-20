import { errorDiagnostic } from "../../utils/error-diagnostic.js";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildManagedRuntimeIdentity,
  findRaviPackageRoot,
  managedRuntimeBundlePath,
  managedRuntimeMatchesTarget,
  managedRuntimeWarnings,
  normalizeRuntimePath,
  readRaviVersion,
  resolveManagedRuntimeTargetFromPackageRoot,
  type ManagedRuntimeTarget,
} from "../../managed-runtime.js";
import { managedRuntimeSnapshot, runManagedRuntimeRebindSupervisor } from "../../managed-runtime-rebind.js";
import {
  globalInstallMethodOf,
  planOperatorRollback,
  isRaviRelease,
  UPDATE_ROLLBACK_UNAVAILABLE,
  UpdateRollbackUnavailableError,
  type OperatorRollbackPlan,
} from "../../update-rollback.js";
import { updateSnapshotsDir } from "../../update-snapshot.js";
import { CHANNELS_PM2_PROCESS_NAME, getPm2Processes, PM2_PROCESS_NAME, type Pm2Process } from "../../pm2.js";
import type { ChannelConfig } from "../../router/router-db.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { CONTRACT_EXIT_USAGE, contractDryRun, contractFail } from "../agent-contract.js";
import {
  type DaemonTreePosition,
  locateInDaemonProcessTree,
  waitUntilOutsideDaemonProcessTree,
} from "../daemon-process-tree.js";
import { dispatchRemote, resolveContextKeyForRemote, resolveRemoteGatewayConfig } from "../remote-gateway.js";
import {
  buildDetachedUpdateEnv,
  createUpdateRunId,
  decideUpdateExecution,
  prepareUpdateRunDir,
  resolveDetachedUpdateStateDir,
  spawnDetachedUpdateProcess,
  UPDATE_HANDOFF_ENV,
  UPDATE_HANDOFF_WORKER_ENV,
  UPDATE_RUN_ID_ENV,
  updateRunPaths,
  writeUpdateRunFile,
  type DetachedSpawn,
} from "../update-run.js";

export type UpdateChannel = "latest" | "next";
export type InstallationType = "source" | "bun" | "npm" | "unknown";
export type GlobalInstallMethod = "bun" | "npm";

export interface RaviUpdateOptions {
  next?: boolean;
  stable?: boolean;
  version?: string;
  expectedIntegrity?: string;
  json?: boolean;
  /** Back to the release before the last update, with its state (preview unless `execute`). */
  rollback?: boolean;
  execute?: boolean;
  /**
   * The release the running daemon was started with, when it wrote no boot record (before 3.261104.2): lets the
   * update take the waypoint with a rollback to it. Checked against PM2's record when that one is usable.
   */
  runningRelease?: string;
}

/** A global `ravi.bot` package installed through bun or npm. */
export interface RaviInstallSnapshot {
  method: GlobalInstallMethod;
  version: string | null;
  packageRoot: string | null;
}

/** What `ravi` on PATH resolves to. */
export interface PathCliSnapshot {
  path: string;
  packageRoot: string | null;
  version: string | null;
}

export interface UpdatedPathCli extends PathCliSnapshot {
  /** Whether `ravi` on PATH now runs the code this update produced. */
  updated: boolean;
}

export type UpdatedTarget =
  | { kind: "source"; sourceRoot: string; branch: string }
  | { kind: "global"; methods: GlobalInstallMethod[] };

/** Where the PM2-managed daemon and channel runner are bound after the update. */
export interface ManagedRuntimeState {
  managed: boolean;
  rebound: boolean;
  bundlePath: string | null;
  cwd: string | null;
  version: string | null;
}

export interface RaviUpdateResult {
  success: true;
  package: typeof PACKAGE_NAME;
  requested: string;
  channel: UpdateChannel | null;
  previousVersion: string | null;
  currentVersion: string | null;
  installMethod: Exclude<InstallationType, "unknown">;
  restarted: boolean;
  integrityVerified: boolean;
  updated: UpdatedTarget;
  cliUpdated: boolean;
  pathCli: UpdatedPathCli | null;
  staleInstalls: RaviInstallSnapshot[];
  runtime: ManagedRuntimeState;
  warnings: string[];
}

/** Returned to a caller inside the daemon tree: the update runs in a detached worker. */
export interface RaviUpdateHandoff {
  success: true;
  mode: "handoff";
  package: typeof PACKAGE_NAME;
  requested: string;
  runId: string;
  logPath: string;
  resultPath: string;
  message: string;
}

export interface UpdateExecutionDeps {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
  cwd?: string;
  now?: () => Date;
  insideDaemonTree?: () => boolean;
  /** cwd of the running daemon, read with `insideDaemonTree` (test seam; the default reads PM2 once for both). */
  daemonCwd?: string | null;
  waitUntilDetached?: () => Promise<boolean>;
  spawnDetached?: DetachedSpawn;
  exit?: (code: number) => never;
  /** `ravi update --rollback` (tests): the PM2 reads and the rollback itself. */
  rollbackRuntime?: {
    getProcesses: () => Pm2Process[];
    /** The detached supervisor that runs the rollback (`runManagedRuntimeRebindSupervisor`). */
    supervise?: typeof runManagedRuntimeRebindSupervisor;
  };
}

export interface RaviUpdateRollbackResult {
  success: true;
  mode: "rollback";
  package: string;
  from: string;
  to: string;
  snapshotAt: string;
  restoredAt: string | null;
  candidateDir: string | null;
  message: string;
}

export interface SourceUpdateOutcomeInput {
  sourceRoot: string;
  channel: UpdateChannel;
  pathCli: PathCliSnapshot | null;
  globalInstalls: RaviInstallSnapshot[];
}

export interface SourceUpdateOutcome {
  cliUpdated: boolean;
  pathCli: UpdatedPathCli | null;
  staleInstalls: RaviInstallSnapshot[];
  warnings: string[];
}

type RaviUpdateConfig = {
  updateChannel?: UpdateChannel;
  installMethod?: InstallationType;
};

type RunResult = {
  success: boolean;
  output: string;
};

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stream?: boolean;
}

interface UpdateReporter {
  readonly json: boolean;
  line(message?: string): void;
  log(message: string): void;
  ok(message: string): void;
  warn(message: string): void;
}

const PACKAGE_NAME = "ravi.bot";
const LOCAL_BIN = join(homedir(), ".local", "bin");
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SRI_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

export { findRaviPackageRoot as findPackageRoot };

class UpdateFailure extends Error {
  constructor(
    message: string,
    readonly code = "UPDATE_FAILED",
    readonly exitCode = 1,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpdateFailure";
  }
}

function createReporter(json: boolean): UpdateReporter {
  return {
    json,
    line(message = "") {
      if (!json) console.log(message);
    },
    log(message) {
      if (!json) console.log(`> ${message}`);
    },
    ok(message) {
      if (!json) console.log(`✓ ${message}`);
    },
    warn(message) {
      if (!json) console.warn(message);
    },
  };
}

function fail(message: string, code = "UPDATE_FAILED", exitCode = 1): never {
  throw new UpdateFailure(message, code, exitCode);
}

function updateConfigPath(stateDir: string = getRaviStateDir()): string {
  return join(stateDir, "update.json");
}

function readUpdateConfig(stateDir: string = getRaviStateDir()): RaviUpdateConfig {
  try {
    const raw = readFileSync(updateConfigPath(stateDir), "utf8");
    return JSON.parse(raw) as RaviUpdateConfig;
  } catch {
    return {};
  }
}

function writeUpdateConfig(config: RaviUpdateConfig): void {
  const path = updateConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const output: string[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...(options.env ?? process.env), FORCE_COLOR: options.stream === false ? "0" : "1" },
    });

    child.stdout?.on("data", (data) => {
      const text = data.toString();
      output.push(text);
      if (options.stream !== false) process.stdout.write(text);
    });

    child.stderr?.on("data", (data) => {
      const text = data.toString();
      output.push(text);
      if (options.stream !== false) process.stderr.write(text);
    });

    child.on("close", (code) => {
      resolve({ success: code === 0, output: output.join("") });
    });

    child.on("error", (error) => {
      resolve({ success: false, output: error.message });
    });
  });
}

function runCommandSilent(command: string, args: string[], cwd?: string, timeoutMs = 4000): RunResult {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    return { success: true, output };
  } catch (error) {
    return {
      success: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveUpdateChannel(
  options: { next?: boolean; stable?: boolean },
  config = readUpdateConfig(),
): UpdateChannel {
  if (options.next) return "next";
  if (options.stable) return "latest";
  return config.updateChannel ?? "latest";
}

export function persistUpdateChannel(channel: UpdateChannel): void {
  writeUpdateConfig({ ...readUpdateConfig(), updateChannel: channel });
}

export function detectFromBinaryPath(binaryPath: string): InstallationType | null {
  const normalized = binaryPath.toLowerCase();
  if (normalized.includes("/.bun/")) return "bun";
  if (normalized.includes("/node_modules/")) return "npm";
  if (binaryPath === join(LOCAL_BIN, "ravi")) return "source";
  return null;
}

function sourceRootFromPackageRoot(packageRoot: string | null): string | null {
  if (!packageRoot) return null;
  return existsSync(join(packageRoot, ".git")) ? packageRoot : null;
}

function resolveSourceRoot(): string | null {
  const configured = process.env.RAVI_REPO?.trim();
  const configuredRoot = findRaviPackageRoot(configured);
  if (configuredRoot && existsSync(join(configuredRoot, ".git"))) {
    return safeRealpath(configuredRoot);
  }
  return sourceRootFromPackageRoot(findRaviPackageRoot(process.argv[1]));
}

export function detectInstallationType(config = readUpdateConfig()): InstallationType {
  if (config.installMethod && config.installMethod !== "unknown") return config.installMethod;

  if (resolveSourceRoot()) return "source";

  const which = runCommandSilent("which", ["ravi"]);
  if (which.success) {
    const binaryPath = which.output.trim();
    const detected = detectFromBinaryPath(binaryPath) ?? detectFromBinaryPath(safeRealpath(binaryPath));
    if (detected) return detected;
  }

  const hasBun = runCommandSilent("which", ["bun"]).success;
  return hasBun ? "bun" : "npm";
}

export function packageTagForChannel(channel: UpdateChannel): string {
  return `${PACKAGE_NAME}@${channel}`;
}

export function normalizeExactVersion(value: string): string {
  const version = value.trim().replace(/^v/, "");
  if (!EXACT_VERSION_PATTERN.test(version)) {
    fail("Use an exact version such as 3.260811.2.", "USAGE_ERROR", CONTRACT_EXIT_USAGE);
  }
  return version;
}

export function packageTagForVersion(version: string): string {
  return `${PACKAGE_NAME}@${normalizeExactVersion(version)}`;
}

export function validateExpectedIntegrity(value: string): string {
  const integrity = value.trim();
  const digest = integrity.slice("sha512-".length);
  if (!SRI_PATTERN.test(integrity) || Buffer.from(digest, "base64").byteLength !== 64) {
    fail("Expected integrity must be a valid sha512 SRI.", "USAGE_ERROR", CONTRACT_EXIT_USAGE);
  }
  return integrity;
}

function whichRavi(): string | null {
  const which = runCommandSilent("which", ["ravi"]);
  if (!which.success) return null;
  return which.output.trim() || null;
}

export function detectInstalledVersion(): string | null {
  const fromPath = readRaviVersion(findRaviPackageRoot(whichRavi()));
  if (fromPath) return fromPath;
  return readRaviVersion(findRaviPackageRoot(process.argv[1]));
}

export function describePathCli(binaryPath: string | null | undefined): PathCliSnapshot | null {
  const path = binaryPath?.trim();
  if (!path) return null;
  const packageRoot = findRaviPackageRoot(path);
  return { path, packageRoot, version: readRaviVersion(packageRoot) };
}

/**
 * Reads one `bun pm ls -g` / `npm list -g ravi.bot --depth=0` listing. Both print
 * the global directory first and the installed entry as `ravi.bot@<version>`.
 */
export function parseGlobalInstallListing(method: GlobalInstallMethod, output: string): RaviInstallSnapshot | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const marker = `${PACKAGE_NAME}@`;
  const entry = lines.find((line) => line.includes(marker));
  if (!entry) return null;

  const version = entry.slice(entry.indexOf(marker) + marker.length).split(/\s+/)[0] || null;
  const header = lines.find((line) => line.startsWith("/")) ?? "";
  const baseDir =
    method === "bun" ? header.replace(/\s+node_modules\s+\(\d+\)$/, "") : (header.split(/\s+->\s+/)[0] ?? "");
  const packageRoot = baseDir.startsWith("/") ? join(baseDir, "node_modules", PACKAGE_NAME) : null;
  return { method, version, packageRoot };
}

function refineGlobalInstall(install: RaviInstallSnapshot): RaviInstallSnapshot {
  const candidate = install.packageRoot;
  const packageRoot = candidate && existsSync(join(candidate, "package.json")) ? findRaviPackageRoot(candidate) : null;
  return { method: install.method, packageRoot, version: readRaviVersion(packageRoot) ?? install.version };
}

export function describeGlobalInstalls(): RaviInstallSnapshot[] {
  const listings: Array<[GlobalInstallMethod, RunResult]> = [
    ["npm", runCommandSilent("npm", ["list", "-g", PACKAGE_NAME, "--depth=0"])],
    ["bun", runCommandSilent("bun", ["pm", "ls", "-g"])],
  ];
  const installs: RaviInstallSnapshot[] = [];
  for (const [method, result] of listings) {
    if (!result.success) continue;
    const parsed = parseGlobalInstallListing(method, result.output);
    if (parsed) installs.push(refineGlobalInstall(parsed));
  }
  return installs;
}

function sameRuntimePath(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeRuntimePath(left);
  return normalizedLeft !== null && normalizedLeft === normalizeRuntimePath(right);
}

function globalInstallCommand(method: GlobalInstallMethod, packageTag: string): string {
  return method === "bun" ? `bun install -g ${packageTag}` : `npm install -g ${packageTag}`;
}

function channelFlag(channel: UpdateChannel): string {
  return channel === "next" ? "--next" : "--stable";
}

/**
 * A source update only rewrites the checkout. `ravi` on PATH and any bun/npm
 * global install are separate copies unless they resolve into that checkout
 * (for example through `bun link`), so anything else is reported as stale.
 */
export function buildSourceUpdateOutcome(input: SourceUpdateOutcomeInput): SourceUpdateOutcome {
  const pathCli: UpdatedPathCli | null = input.pathCli
    ? { ...input.pathCli, updated: sameRuntimePath(input.pathCli.packageRoot, input.sourceRoot) }
    : null;
  const staleInstalls = input.globalInstalls.filter(
    (install) => !sameRuntimePath(install.packageRoot, input.sourceRoot),
  );

  const packageTag = packageTagForChannel(input.channel);
  const warnings: string[] = [];
  if (pathCli && !pathCli.updated) {
    const install = staleInstalls.find((candidate) => sameRuntimePath(candidate.packageRoot, pathCli.packageRoot));
    const version = pathCli.version ? ` at ${pathCli.version}` : "";
    const location = install
      ? `a ${install.method} global install`
      : `a separate install (${pathCli.packageRoot ?? pathCli.path})`;
    const alternative = install ? `  (or: ${globalInstallCommand(install.method, packageTag)})` : "";
    warnings.push(
      `ravi on PATH (${pathCli.path}) is ${location}${version}, not this checkout; it was not updated. ` +
        `Fix: ravi update ${channelFlag(input.channel)}${alternative}`,
    );
  }
  for (const install of staleInstalls) {
    if (pathCli && sameRuntimePath(install.packageRoot, pathCli.packageRoot)) continue;
    const version = install.version ? ` at ${install.version}` : "";
    const location = install.packageRoot ? ` (${install.packageRoot})` : "";
    warnings.push(
      `${install.method} global install${version}${location} was not updated. Fix: ${globalInstallCommand(install.method, packageTag)}`,
    );
  }

  return { cliUpdated: pathCli?.updated ?? false, pathCli, staleInstalls, warnings };
}

function describeManagedRuntime(processes: Pm2Process[]): Omit<ManagedRuntimeState, "rebound"> {
  const managed = managedRuntimeSnapshot(processes).length > 0;
  const member =
    processes.find((process) => process.name === PM2_PROCESS_NAME) ??
    processes.find((process) => process.name === CHANNELS_PM2_PROCESS_NAME);
  const bundlePath = managedRuntimeBundlePath(member);
  const identity = buildManagedRuntimeIdentity(processes, bundlePath);
  const runtime = member?.name === PM2_PROCESS_NAME ? identity.daemon : identity.channels;
  return { managed, bundlePath, cwd: runtime.cwd, version: runtime.runningVersion };
}

function readManagedProcesses(): Pm2Process[] {
  try {
    return getPm2Processes({ strict: true });
  } catch (cause) {
    throw new UpdateFailure(
      "Could not read PM2 runtime status, so Ravi cannot verify runtime reconciliation. Check `pm2 jlist` and retry.",
      "UPDATE_FAILED",
      1,
      { cause },
    );
  }
}

async function verifyRegistryIntegrity(version: string, expectedIntegrity: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/${encodeURIComponent(version)}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("The requested version could not be verified with the npm registry.", "REGISTRY_UNAVAILABLE");
  }
  if (!response.ok) {
    fail(
      response.status === 404
        ? `Version ${version} does not exist in the npm registry.`
        : "The requested version could not be verified with the npm registry.",
      response.status === 404 ? "VERSION_NOT_FOUND" : "REGISTRY_UNAVAILABLE",
    );
  }
  const metadata = (await response.json()) as { dist?: { integrity?: unknown } };
  if (metadata.dist?.integrity !== expectedIntegrity) {
    fail("Published integrity does not match the authorized release.", "INTEGRITY_MISMATCH");
  }
}

export function resolveUpdatedManagedRuntimeTarget(preferredPackageRoot?: string | null): ManagedRuntimeTarget | null {
  const which = runCommandSilent("which", ["ravi"]);
  const candidates = [
    preferredPackageRoot,
    which.success ? findRaviPackageRoot(which.output.trim()) : null,
    findRaviPackageRoot(process.argv[1]),
  ];
  for (const candidate of candidates) {
    const target = resolveManagedRuntimeTargetFromPackageRoot(candidate);
    if (target) return target;
  }
  return null;
}

/**
 * The rebind restarts `ravi-channels` only when it was already online, so an
 * update never starts it. Native channels (Slack) queue every reply for that
 * runner: when any is enabled and the runner was not online, say so.
 */
export function nativeChannelRunnerUpdateWarning(
  previousProcesses: Pm2Process[],
  listChannels: () => Pick<ChannelConfig, "enabled">[],
): string | null {
  let enabled: number;
  try {
    enabled = listChannels().filter((channel) => channel.enabled !== false).length;
  } catch {
    return null;
  }
  if (enabled === 0) return null;
  const runner = previousProcesses.find((process) => process.name === CHANNELS_PM2_PROCESS_NAME);
  if (runner?.status === "online") return null;
  return `${enabled} native channel(s) are enabled but ${CHANNELS_PM2_PROCESS_NAME} is not running, so their replies stay queued; start it with \`ravi channels start\` and check \`ravi doctor --domain channels\`.`;
}

export async function readNativeChannelRunnerUpdateWarning(previousProcesses: Pm2Process[]): Promise<string | null> {
  if (previousProcesses.some((process) => process.name === CHANNELS_PM2_PROCESS_NAME && process.status === "online"))
    return null;
  try {
    const contextKey = resolveContextKeyForRemote();
    if (!contextKey) return null;
    const config = await resolveRemoteGatewayConfig(process.env, "update", { installedOperator: true });
    if (!config) return null;
    const deadline = Date.now() + 2_000;
    let offset = 0;
    while (Date.now() < deadline) {
      const response = await dispatchRemote({
        config,
        contextKey,
        groupSegments: ["channels"],
        command: "list",
        body: { json: true, limit: "500", offset: String(offset), fields: "enabled" },
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      if (!response.ok) return null;
      const payload: unknown = JSON.parse(response.body);
      if (!payload || typeof payload !== "object" || !("items" in payload) || !Array.isArray(payload.items))
        return null;
      if (
        payload.items.some(
          (item: unknown) => item && typeof item === "object" && (!("enabled" in item) || item.enabled !== false),
        )
      )
        return `Native channels are enabled but ${CHANNELS_PM2_PROCESS_NAME} is not running, so their replies stay queued; start it with \`ravi channels start\` and check \`ravi doctor --domain channels\`.`;
      const pagination = "pagination" in payload ? payload.pagination : null;
      if (
        !pagination ||
        typeof pagination !== "object" ||
        !("nextOffset" in pagination) ||
        typeof pagination.nextOffset !== "number" ||
        !Number.isSafeInteger(pagination.nextOffset) ||
        pagination.nextOffset <= offset
      )
        return null;
      offset = pagination.nextOffset;
    }
    return null;
  } catch {
    // no-cause: Optional intake warning must not initialize local state or fail a completed update when the gateway is unavailable.
    return null;
  }
}

/** A recorded refusal keeps its code when it looks like one; anything else is a plain update failure. */
export function supervisorRefusalCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : "UPDATE_FAILED";
}

async function reconcileManagedRuntime(
  previousProcesses: Pm2Process[],
  target: ManagedRuntimeTarget,
  reporter: UpdateReporter,
  declaredRunningRelease: string | null = null,
): Promise<{ restarted: boolean; runtime: ManagedRuntimeState }> {
  const current = describeManagedRuntime(previousProcesses);
  reporter.line();

  if (!current.managed) {
    reporter.line("No managed Ravi processes in PM2; nothing to rebind.");
    return { restarted: false, runtime: { ...current, rebound: false } };
  }

  reporter.log(`Rebinding managed runtime to Ravi ${target.version} (${target.cwd})`);
  const supervisor = await runManagedRuntimeRebindSupervisor(target, previousProcesses, undefined, {
    declaredRunningRelease,
  });
  // The supervisor refused before stopping anything: its reason is the result.
  if (supervisor.refusal) fail(supervisor.refusal.message, supervisorRefusalCode(supervisor.refusal.code));
  // The target did not converge and the supervisor rolled back (or tried): that is the result.
  const result = supervisor.converged ? null : supervisor.result;
  if (result?.outcome === "rolled-back") fail(result.message, "UPDATE_ROLLED_BACK");
  if (result?.outcome === "rollback-failed") {
    fail(
      `${result.message}${result.commands.length ? ` Next: ${result.commands.join(" ; ")}` : ""}` +
        (supervisor.logPath ? ` Supervisor log: ${supervisor.logPath}.` : ""),
      "UPDATE_ROLLBACK_FAILED",
    );
  }
  // A successfully exited bundle may not implement this supervisor protocol.
  // Independently verify the live successors before claiming convergence.
  const currentProcesses = readManagedProcesses();
  if (
    !supervisor.converged ||
    !managedRuntimeMatchesTarget(managedRuntimeSnapshot(previousProcesses), currentProcesses, target)
  ) {
    const warnings = managedRuntimeWarnings(buildManagedRuntimeIdentity(currentProcesses, target.bundlePath));
    fail(
      "Ravi updated, but PM2 did not converge on the updated runtime. " +
        "Deployment remains blocked. Inspect preparation/interlock evidence and both process identities; " +
        "do not bypass this result with independent daemon/channels restarts." +
        (supervisor.logPath ? ` Supervisor log: ${supervisor.logPath}.` : "") +
        (warnings.length ? ` ${warnings.join(" ")}` : ""),
    );
  }
  reporter.ok(`Managed runtime reconciled to Ravi ${target.version} from ${target.cwd}; PM2 startup state saved`);
  return {
    restarted: managedRuntimeSnapshot(previousProcesses).some((process) => process.status === "online"),
    runtime: { managed: true, rebound: true, bundlePath: target.bundlePath, cwd: target.cwd, version: target.version },
  };
}

function reportManagedRuntimeWarnings(target: ManagedRuntimeTarget, reporter: UpdateReporter): string[] {
  const warnings = managedRuntimeWarnings(buildManagedRuntimeIdentity(readManagedProcesses(), target.bundlePath));
  for (const warning of warnings) reporter.warn(`Warning: ${warning}`);
  return warnings;
}

async function updateViaBun(packageTag: string, label: string, reporter: UpdateReporter): Promise<boolean> {
  try {
    unlinkSync(join(homedir(), ".bun", "install", "global", "bun.lock"));
  } catch {
    // Lockfile may not exist.
  }

  reporter.log(`Updating via bun (${packageTag})`);
  const result = await runCommand("bun", ["install", "-g", "--force", "--no-cache", packageTag], {
    stream: !reporter.json,
  });
  if (!result.success) return false;
  reporter.ok(`Updated via bun (${label})`);
  return true;
}

async function updateViaNpm(packageTag: string, label: string, reporter: UpdateReporter): Promise<boolean> {
  reporter.log(`Updating via npm (${packageTag})`);
  const result = await runCommand("npm", ["install", "-g", packageTag], { stream: !reporter.json });
  if (!result.success) return false;
  reporter.ok(`Updated via npm (${label})`);
  return true;
}

export function detectGlobalInstalls(): Set<GlobalInstallMethod> {
  return new Set(describeGlobalInstalls().map((install) => install.method));
}

async function updateSource(sourceRoot: string, channel: UpdateChannel, reporter: UpdateReporter): Promise<string> {
  const targetBranch = channel === "next" ? "dev" : "main";
  const status = runCommandSilent("git", ["status", "--porcelain"], sourceRoot);
  if (status.success && status.output.trim()) {
    fail(`Source checkout is dirty: ${sourceRoot}. Commit or stash before running update.`);
  }

  reporter.log(`Updating source checkout ${sourceRoot} from origin/${targetBranch}`);

  for (const step of [
    ["git", ["fetch", "origin", targetBranch]],
    ["git", ["switch", targetBranch]],
    ["git", ["pull", "--ff-only", "origin", targetBranch]],
    ["bun", ["install"]],
    ["bun", ["run", "build"]],
  ] as Array<[string, string[]]>) {
    const result = await runCommand(step[0], step[1], { cwd: sourceRoot, stream: !reporter.json });
    if (!result.success) fail(`Source update failed at: ${step[0]} ${step[1].join(" ")}`);
  }

  return targetBranch;
}

function reportSourceUpdate(
  outcome: SourceUpdateOutcome,
  target: ManagedRuntimeTarget,
  branch: string,
  previousVersion: string | null,
  reporter: UpdateReporter,
): void {
  const transition =
    previousVersion && previousVersion !== target.version ? `${previousVersion} → ${target.version}` : target.version;
  reporter.line();
  reporter.ok(`Source checkout updated from ${branch}: Ravi ${transition} (${target.cwd})`);
  if (!outcome.pathCli) {
    reporter.line(`  ravi is not on PATH; this checkout runs as ${join(target.cwd, "bin", "ravi")}`);
  } else if (outcome.pathCli.updated) {
    reporter.line(`  ravi on PATH (${outcome.pathCli.path}) runs this checkout`);
  }
  if (outcome.warnings.length > 0) {
    reporter.warn("Not updated by this run:");
    for (const warning of outcome.warnings) reporter.warn(`  - ${warning}`);
  }
}

function assertUpdateSelectors(options: RaviUpdateOptions): void {
  if (options.rollback && (options.next || options.stable || options.version || options.expectedIntegrity)) {
    fail(
      "--rollback goes back to the release before the last update; it takes no release selector.",
      "USAGE_ERROR",
      CONTRACT_EXIT_USAGE,
    );
  }
  if (options.execute && !options.rollback) {
    fail("--execute applies only to --rollback.", "USAGE_ERROR", CONTRACT_EXIT_USAGE);
  }
  if (options.runningRelease !== undefined) {
    if (options.rollback) {
      fail("--running-release applies to an update, not to --rollback.", "USAGE_ERROR", CONTRACT_EXIT_USAGE);
    }
    if (!isRaviRelease(options.runningRelease)) {
      fail(
        `--running-release takes a Ravi release such as 3.261101.3, not ${JSON.stringify(options.runningRelease)}.`,
        "USAGE_ERROR",
        CONTRACT_EXIT_USAGE,
      );
    }
  }
  const selectorCount =
    Number(Boolean(options.next)) + Number(Boolean(options.stable)) + Number(Boolean(options.version));
  if (selectorCount > 1) {
    fail("Use only one update selector: --version, --next, or --stable.", "USAGE_ERROR", CONTRACT_EXIT_USAGE);
  }
  if (options.expectedIntegrity && !options.version) {
    fail("--expected-integrity requires --version.", "USAGE_ERROR", CONTRACT_EXIT_USAGE);
  }
  if (options.version) normalizeExactVersion(options.version);
  if (options.expectedIntegrity) validateExpectedIntegrity(options.expectedIntegrity);
}

/** The same request, for the detached worker. Always JSON: the worker's output is the run log. */
export function updateCommandArgs(options: RaviUpdateOptions): string[] {
  const args = ["update"];
  if (options.version) args.push("--version", options.version);
  if (options.expectedIntegrity) args.push("--expected-integrity", options.expectedIntegrity);
  if (options.next) args.push("--next");
  if (options.stable) args.push("--stable");
  if (options.runningRelease) args.push("--running-release", options.runningRelease);
  args.push("--json");
  return args;
}

/** `stateDir` is the directory the run will use: the saved channel is read from there, not from the caller's cwd. */
function describeRequested(options: RaviUpdateOptions, stateDir?: string): string {
  if (options.version) return normalizeExactVersion(options.version);
  return resolveUpdateChannel(options, readUpdateConfig(stateDir));
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) record[key] = value;
  return record;
}

/**
 * Caller inside the daemon tree: nothing is installed or stopped here. A
 * detached child takes the request; if it cannot be started, the update is
 * refused, never run inline.
 */
async function handOffUpdate(
  options: RaviUpdateOptions,
  deps: UpdateExecutionDeps,
  daemonCwd: string | null,
): Promise<RaviUpdateHandoff> {
  assertUpdateSelectors(options);
  const env = deps.env ?? process.env;
  let stateDir: string | undefined;
  try {
    stateDir = resolveDetachedUpdateStateDir(env, daemonCwd);
  } catch (cause) {
    throw new UpdateFailure(
      "ravi update was started inside the daemon's process tree with a relative RAVI_STATE_DIR, and the daemon's " +
        "working directory could not be read, so nothing was installed or stopped. Set RAVI_STATE_DIR to an " +
        "absolute path or run ravi update from a terminal.",
      "UPDATE_DETACH_FAILED",
      1,
      { cause },
    );
  }
  const runStateDir = stateDir ?? getRaviStateDir(env);
  // The saved channel lives in the daemon's state directory, which a relative RAVI_STATE_DIR only names from the
  // daemon's cwd: read it there, not from the caller's cwd.
  const requested = describeRequested(options, runStateDir);
  // The worker installs what the caller was told: a channel resolved here is passed on, not resolved again.
  const request: RaviUpdateOptions = options.version
    ? options
    : { ...options, next: requested === "next", stable: requested === "latest" };
  const runId = createUpdateRunId(deps.now?.());
  const paths = updateRunPaths(runId, runStateDir);
  try {
    const script = (deps.argv ?? process.argv)[1];
    if (!script) throw new Error("the CLI entry point is unknown");
    prepareUpdateRunDir(paths);
    writeUpdateRunFile(paths.request, {
      runId,
      requested,
      args: updateCommandArgs(request),
      reason: "daemon-process-tree",
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
    });
    await spawnDetachedUpdateProcess(
      {
        command: deps.execPath ?? process.execPath,
        args: [script, ...updateCommandArgs(request)],
        env: buildDetachedUpdateEnv(env, runId, stateDir),
        cwd: deps.cwd ?? process.cwd(),
        logPath: paths.log,
      },
      deps.spawnDetached,
    );
  } catch (cause) {
    throw new UpdateFailure(
      "ravi update was started inside the daemon's process tree and could not detach from it, so nothing was " +
        "installed or stopped. Stopping the daemon would kill this process before the new runtime starts. " +
        "Run ravi update from a terminal.",
      "UPDATE_DETACH_FAILED",
      1,
      { cause },
    );
  }
  return {
    success: true,
    mode: "handoff",
    package: PACKAGE_NAME,
    requested,
    runId,
    logPath: paths.log,
    resultPath: paths.result,
    message:
      "Update handed off to a worker outside the daemon's process tree. This session may be interrupted when the " +
      `daemon restarts; the outcome is written to ${paths.result}.`,
  };
}

/** The detached child: start the worker and exit, so the worker leaves the daemon tree. */
async function reparentUpdate(deps: UpdateExecutionDeps): Promise<never> {
  const env = deps.env ?? process.env;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const paths = updateRunPaths(env[UPDATE_RUN_ID_ENV] ?? "", getRaviStateDir(env));
  prepareUpdateRunDir(paths);
  try {
    await spawnDetachedUpdateProcess(
      {
        command: deps.execPath ?? process.execPath,
        args: (deps.argv ?? process.argv).slice(1),
        env: { ...envRecord(env), [UPDATE_HANDOFF_WORKER_ENV]: "1" },
        cwd: deps.cwd ?? process.cwd(),
        logPath: paths.log,
      },
      deps.spawnDetached,
    );
  } catch (cause) {
    writeUpdateRunFile(paths.result, {
      runId: env[UPDATE_RUN_ID_ENV],
      status: "failed",
      code: "UPDATE_DETACH_FAILED",
      message: `The update worker could not be started: ${errorDiagnostic(cause, { operation: "ravi update" }).cause}`,
      finishedAt: new Date().toISOString(),
    });
    return exit(1);
  }
  return exit(0);
}

async function performUpdate(options: RaviUpdateOptions, reporter: UpdateReporter): Promise<RaviUpdateResult> {
  assertUpdateSelectors(options);

  const exactVersion = options.version ? normalizeExactVersion(options.version) : null;
  const expectedIntegrity = options.expectedIntegrity ? validateExpectedIntegrity(options.expectedIntegrity) : null;
  const channel = exactVersion ? null : resolveUpdateChannel(options);
  const requested = exactVersion ?? (channel as UpdateChannel);
  const packageTag = exactVersion ? packageTagForVersion(exactVersion) : packageTagForChannel(channel as UpdateChannel);
  const label = exactVersion ?? (channel as UpdateChannel);

  if (!exactVersion && (options.next || options.stable)) persistUpdateChannel(channel as UpdateChannel);
  if (exactVersion && expectedIntegrity) await verifyRegistryIntegrity(exactVersion, expectedIntegrity);

  const previousProcesses = readManagedProcesses();
  const installType = detectInstallationType();
  const sourceRoot = installType === "source" ? resolveSourceRoot() : null;
  // A source update rewrites the checkout, so "previous" must be the checkout's
  // own version rather than whatever `ravi` on PATH happens to report.
  const previousVersion = sourceRoot ? readRaviVersion(sourceRoot) : detectInstalledVersion();

  reporter.line("\nRavi update");
  reporter.line("-----------");
  reporter.line(
    exactVersion
      ? `Version: ${exactVersion}${expectedIntegrity ? " (integrity verified)" : ""}`
      : `Channel: ${channel}${channel === "next" ? " (dev builds)" : " (stable)"}`,
  );
  reporter.line(`Install: ${installType}${sourceRoot ? ` (${sourceRoot})` : ""}\n`);

  if (installType === "unknown") {
    fail(`No Ravi installation found. Install with: bun install -g ${packageTag}`);
  }

  if (installType === "source") {
    if (exactVersion) {
      fail(
        "Source checkout updates do not accept --version; use --next or --stable.",
        "USAGE_ERROR",
        CONTRACT_EXIT_USAGE,
      );
    }
    if (!sourceRoot) fail("Could not resolve Ravi source checkout. Set RAVI_REPO or use a global install.");

    const branch = await updateSource(sourceRoot, channel as UpdateChannel, reporter);
    const target = resolveUpdatedManagedRuntimeTarget(sourceRoot);
    if (!target) fail("Source checkout updated, but its runnable bundle could not be resolved.");

    const outcome = buildSourceUpdateOutcome({
      sourceRoot: target.cwd,
      channel: channel as UpdateChannel,
      pathCli: describePathCli(whichRavi()),
      globalInstalls: describeGlobalInstalls(),
    });
    reportSourceUpdate(outcome, target, branch, previousVersion, reporter);

    const { restarted, runtime } = await reconcileManagedRuntime(
      previousProcesses,
      target,
      reporter,
      options.runningRelease ?? null,
    );
    if (runtime.rebound && outcome.pathCli && !outcome.pathCli.updated) {
      reporter.line("  The daemon now runs from this checkout; `ravi daemon status` from the PATH install reports");
      reporter.line("  drift until that install is updated too.");
    }
    outcome.warnings.push(...reportManagedRuntimeWarnings(target, reporter));
    const runnerWarning = await readNativeChannelRunnerUpdateWarning(previousProcesses);
    if (runnerWarning) {
      outcome.warnings.push(runnerWarning);
      reporter.warn(`Warning: ${runnerWarning}`);
    }
    return {
      success: true,
      package: PACKAGE_NAME,
      requested,
      channel,
      previousVersion,
      currentVersion: target.version,
      installMethod: installType,
      restarted,
      integrityVerified: false,
      updated: { kind: "source", sourceRoot: target.cwd, branch },
      cliUpdated: outcome.cliUpdated,
      pathCli: outcome.pathCli,
      staleInstalls: outcome.staleInstalls,
      runtime,
      warnings: outcome.warnings,
    };
  }

  const warnings: string[] = [];
  const primary = installType as GlobalInstallMethod;
  const updated =
    primary === "bun"
      ? await updateViaBun(packageTag, label, reporter)
      : await updateViaNpm(packageTag, label, reporter);
  if (!updated) fail(`Failed to update via ${primary}`);
  const methods: GlobalInstallMethod[] = [primary];

  const secondary = primary === "bun" ? "npm" : "bun";
  if (detectGlobalInstalls().has(secondary)) {
    reporter.line();
    reporter.log(`Also updating ${secondary} global install`);
    const secondaryUpdated =
      secondary === "bun"
        ? await updateViaBun(packageTag, label, reporter)
        : await updateViaNpm(packageTag, label, reporter);
    if (secondaryUpdated) {
      methods.push(secondary);
    } else {
      const warning = `secondary ${secondary} update failed`;
      warnings.push(warning);
      reporter.warn(`Warning: ${warning}`);
    }
  }

  const currentVersion = detectInstalledVersion();
  if (exactVersion && currentVersion !== exactVersion) {
    fail(`The installation resolved to ${currentVersion ?? "an unknown version"}, not ${exactVersion}.`);
  }
  const target = resolveUpdatedManagedRuntimeTarget();
  if (!target) fail("Ravi updated, but its runnable bundle could not be resolved.");
  if (currentVersion && target.version !== currentVersion) {
    fail(`The updated CLI reports ${currentVersion}, but its runtime bundle reports ${target.version}.`);
  }

  const pathCliSnapshot = describePathCli(whichRavi());
  const pathCli: UpdatedPathCli | null = pathCliSnapshot
    ? { ...pathCliSnapshot, updated: pathCliSnapshot.version === target.version }
    : null;
  reporter.line();
  reporter.ok(`Ravi CLI updated to ${target.version} (${primary} global install)`);
  if (pathCli && !pathCli.updated) {
    const warning = `ravi on PATH (${pathCli.path}) reports ${pathCli.version ?? "an unknown version"}, not the updated ${target.version}.`;
    warnings.push(warning);
    reporter.warn(`Warning: ${warning}`);
  }

  const { restarted, runtime } = await reconcileManagedRuntime(
    previousProcesses,
    target,
    reporter,
    options.runningRelease ?? null,
  );
  warnings.push(...reportManagedRuntimeWarnings(target, reporter));
  const runnerWarning = await readNativeChannelRunnerUpdateWarning(previousProcesses);
  if (runnerWarning) {
    warnings.push(runnerWarning);
    reporter.warn(`Warning: ${runnerWarning}`);
  }
  return {
    success: true,
    package: PACKAGE_NAME,
    requested,
    channel,
    previousVersion,
    currentVersion: target.version,
    installMethod: primary,
    restarted,
    integrityVerified: Boolean(expectedIntegrity),
    updated: { kind: "global", methods },
    cliUpdated: pathCli?.updated ?? false,
    pathCli,
    staleInstalls: [],
    runtime,
    warnings,
  };
}

/**
 * Clears the run markers from the environment of an inline update and returns
 * the run it records its outcome under: only the worker owns a run. Nothing
 * the update starts afterwards (installers, PM2, the supervisor, the restarted
 * services) inherits a marker, so a later update from inside the restarted
 * daemon hands off as a fresh run instead of writing over this one.
 */
function takeUpdateRun(env: NodeJS.ProcessEnv): { runId?: string; worker: boolean } {
  const worker = env[UPDATE_HANDOFF_WORKER_ENV] === "1";
  const runId = worker ? env[UPDATE_RUN_ID_ENV] : undefined;
  delete env[UPDATE_HANDOFF_ENV];
  delete env[UPDATE_HANDOFF_WORKER_ENV];
  delete env[UPDATE_RUN_ID_ENV];
  return { runId, worker };
}

function recordRunOutcome(env: NodeJS.ProcessEnv, runId: string | undefined, outcome: Record<string, unknown>): void {
  if (!runId) return;
  try {
    const paths = updateRunPaths(runId, getRaviStateDir(env));
    prepareUpdateRunDir(paths);
    writeUpdateRunFile(paths.result, {
      runId,
      ...outcome,
      finishedAt: new Date().toISOString(),
    });
  } catch (cause) {
    console.error(errorDiagnostic(cause, { operation: "ravi update: record run result" }));
  }
}

function failUpdate(options: RaviUpdateOptions, error: unknown): never {
  if (!(error instanceof UpdateFailure)) throw error;
  return contractFail("ravi update", error.code, error.message, {
    ...{
      asJson: options.json,
      exitCode: error.exitCode,
      details: {
        retryable: error.code === "REGISTRY_UNAVAILABLE" || error.code === "UPDATE_FAILED",
        suggestedAction:
          error.code === "UPDATE_DETACH_FAILED"
            ? "Run ravi update from a terminal."
            : "Verify the requested release and retry.",
      },
    },
    diagnostic: errorDiagnostic(error, { operation: "ravi update" }),
  });
}

/**
 * Only a readable "outside" lets the update run inline: a PM2 that cannot be read refuses the update instead of
 * answering "outside". Usage errors still come first, and the run markers decide without reading PM2.
 */
function readDaemonTreePosition(
  options: RaviUpdateOptions,
  deps: UpdateExecutionDeps,
  env: NodeJS.ProcessEnv,
): DaemonTreePosition {
  if (env[UPDATE_HANDOFF_ENV] === "1" || env[UPDATE_HANDOFF_WORKER_ENV] === "1") {
    return { inside: false, daemonCwd: null };
  }
  assertUpdateSelectors(options);
  try {
    if (deps.insideDaemonTree) return { inside: deps.insideDaemonTree(), daemonCwd: deps.daemonCwd ?? null };
    return locateInDaemonProcessTree();
  } catch (cause) {
    throw new UpdateFailure(
      "Could not read PM2 runtime status or the process ancestry, so Ravi cannot tell whether this update runs " +
        "inside the daemon's process tree. Nothing ran. Check `pm2 jlist` and retry.",
      "UPDATE_FAILED",
      1,
      { cause },
    );
  }
}

/**
 * `ravi update --rollback`: back to the release before the last update, with its state as of that update's snapshot,
 * through the update's own rollback (`update-rollback.ts`). A preview unless `--execute`; only from a terminal,
 * because it stops the daemon; one update at a time (`<state>/updates/update.lock`).
 */
async function runOperatorRollback(
  options: RaviUpdateOptions,
  deps: UpdateExecutionDeps,
  env: NodeJS.ProcessEnv,
  position: DaemonTreePosition,
): Promise<RaviUpdateRollbackResult> {
  assertUpdateSelectors(options);
  if (position.inside) {
    throw new UpdateFailure(
      "ravi update --rollback stops the daemon, so it runs only from a terminal, outside the daemon's process " +
        "tree. Nothing was stopped.",
      UPDATE_ROLLBACK_UNAVAILABLE,
      1,
    );
  }
  // One absolute directory for the plan, the restore, the lock and the previous release's CLI: a relative value
  // would otherwise mean the operator's cwd here and the package directory once that CLI starts.
  const stateDir = resolve(getRaviStateDir(env));
  const rollbackEnv = { ...env, RAVI_STATE_DIR: stateDir };
  const getProcesses = deps.rollbackRuntime?.getProcesses ?? readManagedProcesses;
  const ownRoot = findRaviPackageRoot(process.argv[1] ?? "");
  const installMethod = ownRoot ? globalInstallMethodOf(ownRoot) : null;
  const processes = getProcesses();
  let rollback: OperatorRollbackPlan;
  try {
    rollback = planOperatorRollback({ stateDir, processes, installMethod });
  } catch (cause) {
    if (cause instanceof UpdateRollbackUnavailableError)
      throw new UpdateFailure(cause.message, UPDATE_ROLLBACK_UNAVAILABLE, 1, { cause });
    throw cause;
  }
  const { manifest, plan } = rollback;
  const candidateDir = join(updateSnapshotsDir(stateDir), manifest.id, "candidate");
  if (!options.execute) {
    contractDryRun(
      "ravi update",
      {
        action: "rollback",
        from: rollback.runningRelease,
        to: plan.previousRelease,
        snapshotId: manifest.id,
        snapshotAt: manifest.createdAt,
        discarded:
          `What Ravi ${manifest.targetRelease} wrote since ${manifest.createdAt} leaves the live state; its files ` +
          `are kept in ${candidateDir}.`,
        install: `${plan.method} install -g ravi.bot@${plan.previousRelease}`,
        processes: rollback.previousProcesses
          .filter((process) => process.status === "online")
          .map((process) => process.name),
      },
      { asJson: options.json },
    );
  }
  // The stop, restore, reinstall and start run in the update supervisor: a detached process that holds the update
  // lock and outlives this command, so a closed terminal or a Ctrl-C does not leave the host half rolled back.
  const target = resolveManagedRuntimeTargetFromPackageRoot(plan.packageRoot);
  if (!target)
    throw new UpdateFailure(
      `The bundle of the running Ravi in ${plan.packageRoot} could not be resolved. This run stopped nothing.`,
      UPDATE_ROLLBACK_UNAVAILABLE,
      1,
    );
  const supervisor = await (deps.rollbackRuntime?.supervise ?? runManagedRuntimeRebindSupervisor)(
    target,
    processes,
    stateDir,
    { rollback: { snapshotId: manifest.id }, env: rollbackEnv },
  );
  if (supervisor.refusal) {
    throw new UpdateFailure(supervisor.refusal.message, supervisorRefusalCode(supervisor.refusal.code), 1);
  }
  const recorded = supervisor.result;
  if (!supervisor.converged || recorded?.outcome !== "rolled-back") {
    throw new UpdateFailure(
      recorded?.outcome === "rollback-failed"
        ? `${recorded.message}${recorded.commands.length ? ` Next: ${recorded.commands.join(" ; ")}` : ""}`
        : "The rollback supervisor gave no result in time; it may still be running, and it goes on without this " +
            `command. Read ${join(stateDir, "updates", "supervisor-result.json")} and \`ravi daemon status\` ` +
            `before acting${supervisor.logPath ? `; its output is in ${supervisor.logPath}` : ""}.`,
      "UPDATE_ROLLBACK_FAILED",
      1,
    );
  }
  const result: RaviUpdateRollbackResult = {
    success: true,
    mode: "rollback",
    package: PACKAGE_NAME,
    from: rollback.runningRelease,
    to: plan.previousRelease,
    snapshotAt: manifest.createdAt,
    restoredAt: recorded.restoredAt,
    candidateDir: recorded.candidateDir,
    message: recorded.message,
  };
  if (options.json) console.log(JSON.stringify(result));
  else console.log(result.message);
  return result;
}

export async function runUpdate(
  options: RaviUpdateOptions = {},
  deps: UpdateExecutionDeps = {},
): Promise<RaviUpdateResult | RaviUpdateHandoff | RaviUpdateRollbackResult> {
  const reporter = createReporter(options.json === true);
  const env = deps.env ?? process.env;
  let position: DaemonTreePosition = { inside: false, daemonCwd: null };
  try {
    position = readDaemonTreePosition(options, deps, env);
  } catch (error) {
    failUpdate(options, error);
  }
  if (options.rollback) {
    try {
      return await runOperatorRollback(options, deps, env, position);
    } catch (error) {
      failUpdate(options, error);
    }
  }
  const execution = decideUpdateExecution({
    handoffEnv: env[UPDATE_HANDOFF_ENV],
    workerEnv: env[UPDATE_HANDOFF_WORKER_ENV],
    insideDaemonTree: position.inside,
  });
  // The detached child only starts the worker; its own outcome is not the run's.
  if (execution === "reparent") return await reparentUpdate(deps);
  const run: { runId?: string; worker: boolean } = execution === "inline" ? takeUpdateRun(env) : { worker: false };
  try {
    if (execution === "handoff") {
      const handoff = await handOffUpdate(options, deps, position.daemonCwd);
      if (reporter.json) console.log(JSON.stringify(handoff));
      else reporter.ok(`${handoff.message} Log: ${handoff.logPath}`);
      return handoff;
    }
    if (run.worker && !(await (deps.waitUntilDetached ?? waitUntilOutsideDaemonProcessTree)())) {
      fail(
        "The update worker is still inside the daemon's process tree, so nothing was installed or stopped. " +
          "Run ravi update from a terminal.",
        "UPDATE_DETACH_FAILED",
      );
    }
    const result = await performUpdate(options, reporter);
    recordRunOutcome(env, run.runId, { status: "succeeded", result });
    if (reporter.json) console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    recordRunOutcome(env, run.runId, {
      status: "failed",
      code: error instanceof UpdateFailure ? error.code : "UPDATE_FAILED",
      // result.json is read by whoever started the run: the message goes through the same redaction as the CLI's.
      message: errorDiagnostic(error, { operation: "ravi update" }).cause,
    });
    failUpdate(options, error);
  }
}
