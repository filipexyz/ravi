import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  findRaviPackageRoot,
  readRaviVersion,
  resolveManagedRuntimeTargetFromPackageRoot,
  type ManagedRuntimeTarget,
} from "../../managed-runtime.js";
import { managedRuntimeSnapshot, runManagedRuntimeRebindSupervisor } from "../../managed-runtime-rebind.js";
import { getPm2Processes, type Pm2Process } from "../../pm2.js";
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

export function detectInstalledVersion(): string | null {
  const which = runCommandSilent("which", ["ravi"]);
  if (which.success) {
    const fromPath = readRaviVersion(findRaviPackageRoot(which.output.trim()));
    if (fromPath) return fromPath;
  }
  return readRaviVersion(findRaviPackageRoot(process.argv[1]));
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

async function finishUpdate(
  restart: boolean,
  previousProcesses: Pm2Process[],
  target: ManagedRuntimeTarget,
  reporter: UpdateReporter,
): Promise<boolean> {
  reporter.line();
  reporter.ok("Ravi CLI updated");

  if (!restart) {
    reporter.line("Managed runtime reconciliation skipped; running processes were left unchanged.");
    return false;
  }

  const snapshot = managedRuntimeSnapshot(previousProcesses);
  if (snapshot.length === 0) return false;
  reporter.log(`Rebinding managed runtime to Ravi ${target.version}`);
  const reconciled = await runManagedRuntimeRebindSupervisor(target, previousProcesses);
  if (!reconciled) {
    fail(
      "Ravi updated, but PM2 did not converge on the updated runtime. Run `ravi daemon status` before resuming traffic.",
    );
  }
  reporter.ok(`Managed runtime reconciled to Ravi ${target.version}; PM2 startup state saved`);
  return snapshot.some((process) => process.status === "online");
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

async function updateSource(channel: UpdateChannel, reporter: UpdateReporter): Promise<string> {
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
  return sourceRoot;
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
    const sourceRoot = await updateSource(channel as UpdateChannel, reporter);
    const target = resolveUpdatedManagedRuntimeTarget(sourceRoot);
    if (!target) fail("Ravi updated, but its runnable bundle could not be resolved.");
    const restarted = await finishUpdate(options.restart !== false, previousProcesses, target, reporter);
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
  const target = resolveUpdatedManagedRuntimeTarget();
  if (!target) fail("Ravi updated, but its runnable bundle could not be resolved.");
  if (currentVersion && target.version !== currentVersion) {
    fail(`The updated CLI reports ${currentVersion}, but its runtime bundle reports ${target.version}.`);
  }
  const restarted = await finishUpdate(options.restart !== false, previousProcesses, target, reporter);
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
