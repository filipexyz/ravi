import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildPm2Env, CHANNELS_PM2_PROCESS_NAME, getPm2Processes, PM2_PROCESS_NAME } from "../../pm2.js";
import { getRaviStateDir } from "../../utils/paths.js";

export type UpdateChannel = "latest" | "next";
export type InstallationType = "source" | "bun" | "npm" | "unknown";

type RaviUpdateConfig = {
  updateChannel?: UpdateChannel;
  installMethod?: InstallationType;
};

type RunResult = {
  success: boolean;
  output: string;
};

export type ManagedRuntimeRestartStep = {
  action: "stop" | "restart";
  processName: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME;
};

const PACKAGE_NAME = "ravi.bot";
const LOCAL_BIN = join(homedir(), ".local", "bin");

function log(message: string): void {
  console.log(`> ${message}`);
}

function ok(message: string): void {
  console.log(`✓ ${message}`);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
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

function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const output: string[] = [];
    const child = spawn(command, args, {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...env, FORCE_COLOR: "1" },
    });

    child.stdout?.on("data", (data) => {
      const text = data.toString();
      output.push(text);
      process.stdout.write(text);
    });

    child.stderr?.on("data", (data) => {
      const text = data.toString();
      output.push(text);
      process.stderr.write(text);
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

async function restartManagedRuntimeProcesses(processes: Array<{ name: string; status: string }>): Promise<boolean> {
  const plan = planManagedRuntimeRestart(processes);
  if (plan.length === 0) return true;

  log("Restarting managed Ravi runtime with the updated bundle");
  let channelsStopped = false;
  for (const step of plan) {
    const result = await runCommand("pm2", [step.action, step.processName], undefined, buildPm2Env());
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
      await runCommand("pm2", ["restart", CHANNELS_PM2_PROCESS_NAME], undefined, buildPm2Env());
    }
    return false;
  }

  if (!(await waitForManagedRuntime(processes))) return false;
  ok("Managed Ravi runtime restarted");
  return true;
}

async function finishUpdate(
  restart: boolean,
  previousProcesses: Array<{ name: string; status: string }>,
): Promise<void> {
  console.log();
  ok("Ravi CLI updated");

  if (!restart) {
    console.log("Managed runtime restart skipped by request.");
    console.log("Before handling new channel traffic, run:");
    const online = new Set(
      previousProcesses.filter((process) => process.status === "online").map((process) => process.name),
    );
    if (online.has(CHANNELS_PM2_PROCESS_NAME)) console.log("  ravi channels stop");
    if (online.has(PM2_PROCESS_NAME)) console.log('  ravi daemon restart -m "load Ravi update"');
    if (online.has(CHANNELS_PM2_PROCESS_NAME)) console.log("  ravi channels start");
    return;
  }

  const restarted = await restartManagedRuntimeProcesses(previousProcesses);
  if (!restarted) {
    fail("Ravi updated, but the managed runtime restart failed. Restart daemon and channels before resuming traffic.");
  }
}

async function updateViaBun(channel: UpdateChannel): Promise<boolean> {
  try {
    unlinkSync(join(homedir(), ".bun", "install", "global", "bun.lock"));
  } catch {
    // Lockfile may not exist.
  }

  log(`Updating via bun (${packageTagForChannel(channel)})`);
  const result = await runCommand("bun", ["install", "-g", "--force", "--no-cache", packageTagForChannel(channel)]);
  if (!result.success) return false;
  ok(`Updated via bun (${channel})`);
  return true;
}

async function updateViaNpm(channel: UpdateChannel): Promise<boolean> {
  log(`Updating via npm (${packageTagForChannel(channel)})`);
  const result = await runCommand("npm", ["install", "-g", packageTagForChannel(channel)]);
  if (!result.success) return false;
  ok(`Updated via npm (${channel})`);
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

async function updateSource(channel: UpdateChannel): Promise<void> {
  const sourceRoot = resolveSourceRoot();
  if (!sourceRoot) fail("Could not resolve Ravi source checkout. Set RAVI_REPO or use a global install.");

  const targetBranch = channel === "next" ? "dev" : "main";
  const status = runCommandSilent("git", ["status", "--porcelain"], sourceRoot);
  if (status.success && status.output.trim()) {
    fail(`Source checkout is dirty: ${sourceRoot}. Commit or stash before running update.`);
  }

  log(`Updating source checkout ${sourceRoot} from origin/${targetBranch}`);

  for (const step of [
    ["git", ["fetch", "origin", targetBranch]],
    ["git", ["switch", targetBranch]],
    ["git", ["pull", "--ff-only", "origin", targetBranch]],
    ["bun", ["install"]],
    ["bun", ["run", "build"]],
  ] as Array<[string, string[]]>) {
    const result = await runCommand(step[0], step[1], sourceRoot);
    if (!result.success) fail(`Source update failed at: ${step[0]} ${step[1].join(" ")}`);
  }

  ok(`Source checkout updated from ${targetBranch}`);
}

export async function runUpdate(options: { next?: boolean; stable?: boolean; restart?: boolean } = {}): Promise<void> {
  const channel = resolveUpdateChannel(options);
  if (options.next || options.stable) persistUpdateChannel(channel);
  const previousProcesses = getPm2Processes();

  console.log("\nRavi update");
  console.log("-----------");
  console.log(`Channel: ${channel}${channel === "next" ? " (dev builds)" : " (stable)"}`);

  const installType = detectInstallationType();
  console.log(`Install: ${installType}\n`);

  if (installType === "unknown") {
    fail(`No Ravi installation found. Install with: bun install -g ${packageTagForChannel(channel)}`);
  }

  if (installType === "source") {
    await updateSource(channel);
    await finishUpdate(options.restart !== false, previousProcesses);
    return;
  }

  const primary = installType as "bun" | "npm";
  const updated = primary === "bun" ? await updateViaBun(channel) : await updateViaNpm(channel);
  if (!updated) fail(`Failed to update via ${primary}`);

  const secondary = primary === "bun" ? "npm" : "bun";
  if (detectGlobalInstalls().has(secondary)) {
    console.log();
    log(`Also updating ${secondary} global install`);
    const secondaryUpdated = secondary === "bun" ? await updateViaBun(channel) : await updateViaNpm(channel);
    if (!secondaryUpdated) console.warn(`Warning: secondary ${secondary} update failed`);
  }

  await finishUpdate(options.restart !== false, previousProcesses);
}
