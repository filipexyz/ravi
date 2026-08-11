import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildPm2Env, CHANNELS_PM2_PROCESS_NAME, getPm2Processes, PM2_PROCESS_NAME } from "../../pm2.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { CONTRACT_EXIT_USAGE, contractFail } from "../agent-contract.js";

export type UpdateChannel = "latest" | "next";
export type InstallationType = "source" | "bun" | "npm" | "unknown";

export interface RaviUpdateOptions {
  next?: boolean;
  stable?: boolean;
  version?: string;
  expectedIntegrity?: string;
  restart?: boolean;
  json?: boolean;
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

export type ManagedRuntimeRestartStep = {
  action: "stop" | "restart";
  processName: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME;
};

const PACKAGE_NAME = "ravi.bot";
const LOCAL_BIN = join(homedir(), ".local", "bin");
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SRI_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

class UpdateFailure extends Error {
  constructor(
    message: string,
    readonly code = "UPDATE_FAILED",
    readonly exitCode = 1,
  ) {
    super(message);
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

function updateConfigPath(): string {
  return join(getRaviStateDir(), "update.json");
}

function readUpdateConfig(): RaviUpdateConfig {
  try {
    const raw = readFileSync(updateConfigPath(), "utf8");
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

function isRaviPackageRoot(dir: string): boolean {
  const packagePath = join(dir, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
    return pkg.name === PACKAGE_NAME || pkg.name === "@filipelabs/ravi";
  } catch {
    return false;
  }
}

export function findPackageRoot(startPath: string | null | undefined): string | null {
  const trimmed = startPath?.trim();
  if (!trimmed) return null;

  let dir = trimmed;
  try {
    const realPath = realpathSync(trimmed);
    dir = statSync(realPath).isDirectory() ? realPath : dirname(realPath);
  } catch {
    dir = dirname(trimmed);
  }

  while (dir) {
    if (isRaviPackageRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function sourceRootFromPackageRoot(packageRoot: string | null): string | null {
  if (!packageRoot) return null;
  return existsSync(join(packageRoot, ".git")) ? packageRoot : null;
}

function resolveSourceRoot(): string | null {
  const configured = process.env.RAVI_REPO?.trim();
  if (configured && isRaviPackageRoot(configured) && existsSync(join(configured, ".git"))) {
    return safeRealpath(configured);
  }
  return sourceRootFromPackageRoot(findPackageRoot(process.argv[1]));
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

function packageVersionAt(packageRoot: string | null): string | null {
  if (!packageRoot) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function detectInstalledVersion(): string | null {
  const which = runCommandSilent("which", ["ravi"]);
  if (which.success) {
    const fromPath = packageVersionAt(findPackageRoot(which.output.trim()));
    if (fromPath) return fromPath;
  }
  return packageVersionAt(findPackageRoot(process.argv[1]));
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

export function planManagedRuntimeRestart(
  processes: Array<{ name: string; status: string }>,
): ManagedRuntimeRestartStep[] {
  const online = new Set(processes.filter((process) => process.status === "online").map((process) => process.name));
  const daemonWasRunning = online.has(PM2_PROCESS_NAME);
  const channelsWereRunning = online.has(CHANNELS_PM2_PROCESS_NAME);
  const plan: ManagedRuntimeRestartStep[] = [];

  // Stop channel intake before changing the daemon bundle. This prevents an
  // old channel runner from reading a schema migrated by a newer process.
  if (channelsWereRunning) {
    plan.push({ action: "stop", processName: CHANNELS_PM2_PROCESS_NAME });
  }
  if (daemonWasRunning) {
    plan.push({ action: "restart", processName: PM2_PROCESS_NAME });
  }
  if (channelsWereRunning) {
    plan.push({ action: "restart", processName: CHANNELS_PM2_PROCESS_NAME });
  }

  return plan;
}

export function managedRuntimeMatchesSnapshot(
  previousProcesses: Array<{ name: string; status: string }>,
  currentProcesses: Array<{ name: string; status: string }>,
): boolean {
  const expectedOnline = previousProcesses
    .filter(
      (process) =>
        process.status === "online" &&
        (process.name === PM2_PROCESS_NAME || process.name === CHANNELS_PM2_PROCESS_NAME),
    )
    .map((process) => process.name);
  const currentOnline = new Set(
    currentProcesses.filter((process) => process.status === "online").map((process) => process.name),
  );
  return expectedOnline.every((processName) => currentOnline.has(processName));
}

async function waitForManagedRuntime(
  previousProcesses: Array<{ name: string; status: string }>,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (managedRuntimeMatchesSnapshot(previousProcesses, getPm2Processes())) return true;
    await delay(250);
  }
  return managedRuntimeMatchesSnapshot(previousProcesses, getPm2Processes());
}

async function restartManagedRuntimeProcesses(
  processes: Array<{ name: string; status: string }>,
  reporter: UpdateReporter,
): Promise<boolean> {
  const plan = planManagedRuntimeRestart(processes);
  if (plan.length === 0) return true;

  reporter.log("Restarting managed Ravi runtime with the updated bundle");
  let channelsStopped = false;
  for (const step of plan) {
    const result = await runCommand("pm2", [step.action, step.processName], {
      env: buildPm2Env(),
      stream: !reporter.json,
    });
    if (result.success) {
      if (step.action === "stop" && step.processName === CHANNELS_PM2_PROCESS_NAME) {
        channelsStopped = true;
      }
      if (step.action === "restart" && step.processName === CHANNELS_PM2_PROCESS_NAME) {
        channelsStopped = false;
      }
      continue;
    }

    // Do not leave channel intake stopped if a later daemon transition fails.
    if (channelsStopped && step.processName !== CHANNELS_PM2_PROCESS_NAME) {
      await runCommand("pm2", ["restart", CHANNELS_PM2_PROCESS_NAME], {
        env: buildPm2Env(),
        stream: !reporter.json,
      });
    }
    return false;
  }

  if (!(await waitForManagedRuntime(processes))) return false;
  reporter.ok("Managed Ravi runtime restarted");
  return true;
}

async function finishUpdate(
  restart: boolean,
  previousProcesses: Array<{ name: string; status: string }>,
  reporter: UpdateReporter,
): Promise<boolean> {
  reporter.line();
  reporter.ok("Ravi CLI updated");

  if (!restart) {
    reporter.line("Managed runtime restart skipped by request.");
    reporter.line("Before handling new channel traffic, run:");
    const online = new Set(
      previousProcesses.filter((process) => process.status === "online").map((process) => process.name),
    );
    if (online.has(CHANNELS_PM2_PROCESS_NAME)) reporter.line("  ravi channels stop");
    if (online.has(PM2_PROCESS_NAME)) reporter.line('  ravi daemon restart -m "load Ravi update"');
    if (online.has(CHANNELS_PM2_PROCESS_NAME)) reporter.line("  ravi channels start");
    return false;
  }

  const restarted = await restartManagedRuntimeProcesses(previousProcesses, reporter);
  if (!restarted) {
    fail("Ravi updated, but the managed runtime restart failed. Restart daemon and channels before resuming traffic.");
  }
  return true;
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

export function detectGlobalInstalls(): Set<"bun" | "npm"> {
  const found = new Set<"bun" | "npm">();
  const npmResult = runCommandSilent("npm", ["list", "-g", PACKAGE_NAME, "--depth=0"]);
  const bunResult = runCommandSilent("bun", ["pm", "ls", "-g"]);

  if (npmResult.success && npmResult.output.includes(PACKAGE_NAME) && !npmResult.output.includes("(empty)")) {
    found.add("npm");
  }
  if (bunResult.success && bunResult.output.includes(PACKAGE_NAME)) {
    found.add("bun");
  }

  return found;
}

async function updateSource(channel: UpdateChannel, reporter: UpdateReporter): Promise<void> {
  const sourceRoot = resolveSourceRoot();
  if (!sourceRoot) fail("Could not resolve Ravi source checkout. Set RAVI_REPO or use a global install.");

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

  reporter.ok(`Source checkout updated from ${targetBranch}`);
}

async function performUpdate(options: RaviUpdateOptions, reporter: UpdateReporter): Promise<RaviUpdateResult> {
  const selectorCount =
    Number(Boolean(options.next)) + Number(Boolean(options.stable)) + Number(Boolean(options.version));
  if (selectorCount > 1) {
    fail("Use only one update selector: --version, --next, or --stable.", "USAGE_ERROR", CONTRACT_EXIT_USAGE);
  }
  if (options.expectedIntegrity && !options.version) {
    fail("--expected-integrity requires --version.", "USAGE_ERROR", CONTRACT_EXIT_USAGE);
  }

  const exactVersion = options.version ? normalizeExactVersion(options.version) : null;
  const expectedIntegrity = options.expectedIntegrity ? validateExpectedIntegrity(options.expectedIntegrity) : null;
  const channel = exactVersion ? null : resolveUpdateChannel(options);
  const requested = exactVersion ?? (channel as UpdateChannel);
  const packageTag = exactVersion ? packageTagForVersion(exactVersion) : packageTagForChannel(channel as UpdateChannel);
  const label = exactVersion ?? (channel as UpdateChannel);

  if (!exactVersion && (options.next || options.stable)) persistUpdateChannel(channel as UpdateChannel);
  if (exactVersion && expectedIntegrity) await verifyRegistryIntegrity(exactVersion, expectedIntegrity);

  const previousProcesses = getPm2Processes();
  const previousVersion = detectInstalledVersion();

  reporter.line("\nRavi update");
  reporter.line("-----------");
  reporter.line(
    exactVersion
      ? `Version: ${exactVersion}${expectedIntegrity ? " (integrity verified)" : ""}`
      : `Channel: ${channel}${channel === "next" ? " (dev builds)" : " (stable)"}`,
  );

  const installType = detectInstallationType();
  reporter.line(`Install: ${installType}\n`);

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
    await updateSource(channel as UpdateChannel, reporter);
    const restarted = await finishUpdate(options.restart !== false, previousProcesses, reporter);
    return {
      success: true,
      package: PACKAGE_NAME,
      requested,
      channel,
      previousVersion,
      currentVersion: detectInstalledVersion(),
      installMethod: installType,
      restarted,
      integrityVerified: false,
    };
  }

  const primary = installType as "bun" | "npm";
  const updated =
    primary === "bun"
      ? await updateViaBun(packageTag, label, reporter)
      : await updateViaNpm(packageTag, label, reporter);
  if (!updated) fail(`Failed to update via ${primary}`);

  const secondary = primary === "bun" ? "npm" : "bun";
  if (detectGlobalInstalls().has(secondary)) {
    reporter.line();
    reporter.log(`Also updating ${secondary} global install`);
    const secondaryUpdated =
      secondary === "bun"
        ? await updateViaBun(packageTag, label, reporter)
        : await updateViaNpm(packageTag, label, reporter);
    if (!secondaryUpdated) reporter.warn(`Warning: secondary ${secondary} update failed`);
  }

  const currentVersion = detectInstalledVersion();
  if (exactVersion && currentVersion !== exactVersion) {
    fail(`The installation resolved to ${currentVersion ?? "an unknown version"}, not ${exactVersion}.`);
  }
  const restarted = await finishUpdate(options.restart !== false, previousProcesses, reporter);
  return {
    success: true,
    package: PACKAGE_NAME,
    requested,
    channel,
    previousVersion,
    currentVersion,
    installMethod: primary,
    restarted,
    integrityVerified: Boolean(expectedIntegrity),
  };
}

export async function runUpdate(options: RaviUpdateOptions = {}): Promise<RaviUpdateResult> {
  const reporter = createReporter(options.json === true);
  try {
    const result = await performUpdate(options, reporter);
    if (reporter.json) console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    if (!(error instanceof UpdateFailure)) throw error;
    contractFail("ravi update", error.code, error.message, {
      asJson: options.json,
      exitCode: error.exitCode,
      details: {
        retryable: error.code === "REGISTRY_UNAVAILABLE" || error.code === "UPDATE_FAILED",
        suggestedAction: "Verify the requested release and retry.",
      },
    });
  }
}
