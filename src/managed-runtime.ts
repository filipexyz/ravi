import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHANNELS_PM2_PROCESS_NAME, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";

const RAVI_PACKAGE_NAMES = new Set(["ravi.bot", "@filipelabs/ravi"]);

export type ManagedRuntimeTarget = {
  bundlePath: string;
  cwd: string;
  version: string;
};

export type ManagedRuntimeProcessSnapshot = {
  name: string;
  status: string;
  pid: number;
  createdAt: number | null;
};

export type ManagedRuntimeMemberIdentity = {
  name: string;
  managed: boolean;
  online: boolean;
  status: string;
  pid: number | null;
  bundlePath: string | null;
  cwd: string | null;
  version: string | null;
  matchesCli: boolean | null;
};

export type ManagedRuntimeIdentity = {
  alignment: "aligned" | "drifted" | "unknown" | "not_running";
  cli: {
    bundlePath: string | null;
    cwd: string | null;
    version: string | null;
  };
  daemon: ManagedRuntimeMemberIdentity;
  channels: ManagedRuntimeMemberIdentity;
};

export function safeRuntimeRealpath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return realpathSync(trimmed);
  } catch {
    return trimmed;
  }
}

export function normalizeRuntimePath(value: string | null | undefined): string | null {
  return safeRuntimeRealpath(value)?.toLowerCase() ?? null;
}

function isRaviPackageRoot(dir: string): boolean {
  const packagePath = join(dir, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" && RAVI_PACKAGE_NAMES.has(pkg.name);
  } catch {
    return false;
  }
}

export function findRaviPackageRoot(startPath: string | null | undefined): string | null {
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
    if (isRaviPackageRoot(dir)) return safeRuntimeRealpath(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function readRaviVersion(packageRoot: string | null | undefined): string | null {
  if (!packageRoot) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function resolveManagedRuntimeTargetFromPackageRoot(
  packageRoot: string | null | undefined,
): ManagedRuntimeTarget | null {
  const cwd = findRaviPackageRoot(packageRoot);
  if (!cwd) return null;
  const bundlePath = safeRuntimeRealpath(join(cwd, "dist", "bundle", "index.js"));
  const version = readRaviVersion(cwd);
  if (!bundlePath || !version) return null;
  try {
    if (!statSync(bundlePath).isFile()) return null;
  } catch {
    return null;
  }
  return { bundlePath, cwd, version };
}

export function resolveManagedRuntimeTargetFromBundle(
  bundlePath: string | null | undefined,
): ManagedRuntimeTarget | null {
  const actualBundle = safeRuntimeRealpath(bundlePath);
  const target = resolveManagedRuntimeTargetFromPackageRoot(findRaviPackageRoot(actualBundle));
  if (!actualBundle || !target) return null;
  return normalizeRuntimePath(actualBundle) === normalizeRuntimePath(target.bundlePath) ? target : null;
}

export function managedRuntimeBundlePath(process: Pm2Process | undefined): string | null {
  if (!process) return null;
  if (process.name === PM2_PROCESS_NAME) return safeRuntimeRealpath(process.execPath);
  if (process.name === CHANNELS_PM2_PROCESS_NAME) return safeRuntimeRealpath(process.args?.[0]);
  return null;
}

function identityForProcess(
  name: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME,
  process: Pm2Process | undefined,
  cliBundlePath: string | null,
): ManagedRuntimeMemberIdentity {
  const bundlePath = managedRuntimeBundlePath(process);
  const target = resolveManagedRuntimeTargetFromBundle(bundlePath);
  const normalizedCli = normalizeRuntimePath(cliBundlePath);
  const normalizedBundle = normalizeRuntimePath(bundlePath);
  return {
    name,
    managed: Boolean(process),
    online: process?.status === "online",
    status: process?.status ?? "not_managed_by_pm2",
    pid: process?.pid ?? null,
    bundlePath,
    cwd: safeRuntimeRealpath(process?.cwd),
    version: target?.version ?? readRaviVersion(findRaviPackageRoot(bundlePath)),
    matchesCli: normalizedCli && normalizedBundle ? normalizedCli === normalizedBundle : null,
  };
}

export function buildManagedRuntimeIdentity(
  processes: Pm2Process[],
  cliBundleCandidate: string | null | undefined,
  currentProcessPid = process.pid,
): ManagedRuntimeIdentity {
  const daemonProcess = processes.find((entry) => entry.name === PM2_PROCESS_NAME);
  const channelsProcess = processes.find((entry) => entry.name === CHANNELS_PM2_PROCESS_NAME);
  const daemonBundlePath = managedRuntimeBundlePath(daemonProcess);
  const cliBundlePath =
    daemonProcess?.pid === currentProcessPid ? daemonBundlePath : safeRuntimeRealpath(cliBundleCandidate);
  const cliTarget = resolveManagedRuntimeTargetFromBundle(cliBundlePath);
  const daemon = identityForProcess(PM2_PROCESS_NAME, daemonProcess, cliBundlePath);
  const channels = identityForProcess(CHANNELS_PM2_PROCESS_NAME, channelsProcess, cliBundlePath);
  const onlineMembers = [daemon, channels].filter((member) => member.online);
  const managedMembers = [daemon, channels].filter((member) => member.managed);

  let alignment: ManagedRuntimeIdentity["alignment"] = "not_running";
  if (onlineMembers.length > 0) {
    const paths = [cliBundlePath, ...managedMembers.map((member) => member.bundlePath)].map(normalizeRuntimePath);
    alignment = paths.some((path) => !path) ? "unknown" : new Set(paths as string[]).size === 1 ? "aligned" : "drifted";
  }

  return {
    alignment,
    cli: {
      bundlePath: cliBundlePath,
      cwd: cliTarget?.cwd ?? findRaviPackageRoot(cliBundlePath),
      version: cliTarget?.version ?? readRaviVersion(findRaviPackageRoot(cliBundlePath)),
    },
    daemon,
    channels,
  };
}

export function managedRuntimeMatchesTarget(
  previousProcesses: ManagedRuntimeProcessSnapshot[],
  currentProcesses: Pm2Process[],
  target: ManagedRuntimeTarget,
): boolean {
  for (const name of [PM2_PROCESS_NAME, CHANNELS_PM2_PROCESS_NAME] as const) {
    const previous = previousProcesses.find((process) => process.name === name);
    if (!previous) continue;
    const current = currentProcesses.find((process) => process.name === name);

    if (previous.status !== "online") {
      if (current) return false;
      continue;
    }

    if (!current || current.status !== "online") return false;
    if (normalizeRuntimePath(managedRuntimeBundlePath(current)) !== normalizeRuntimePath(target.bundlePath))
      return false;
    if (normalizeRuntimePath(current.cwd) !== normalizeRuntimePath(target.cwd)) return false;
    if (resolveManagedRuntimeTargetFromBundle(managedRuntimeBundlePath(current))?.version !== target.version)
      return false;
    if (
      previous.pid > 0 &&
      current.pid === previous.pid &&
      (previous.createdAt === null || current.createdAt === previous.createdAt)
    ) {
      return false;
    }
  }
  return true;
}
