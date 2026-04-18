import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

function runCommand(command: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const output: string[] = [];
    const child = spawn(command, args, {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1" },
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

export async function runUpdate(options: { next?: boolean; stable?: boolean } = {}): Promise<void> {
  const channel = resolveUpdateChannel(options);
  if (options.next || options.stable) persistUpdateChannel(channel);

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

  console.log();
  ok("Ravi CLI updated");
  console.log("Restart the daemon when you want the live runtime to use the new bundle.");
}
