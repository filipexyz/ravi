import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHANNELS_PM2_PROCESS_NAME, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";
import {
  getRuntimeBootObservation,
  readRuntimeBootReceipt,
  runtimeBundleFingerprint,
  runtimeFileMetadata,
  type RuntimeBundleFingerprint,
} from "./runtime-process-identity.js";
import { getRaviStateDir } from "./utils/paths.js";

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
  runningVersion: string | null;
  diskVersion: string | null;
  startedAt: number | null;
  stale: boolean;
  codeStale: boolean;
  envStale: boolean;
  identityVerified: boolean;
  warnings: string[];
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

export type ManagedRuntimeIdentityOptions = {
  stateDir?: string;
  envFile?: string;
};

function identityForProcess(
  name: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME,
  process: Pm2Process | undefined,
  cliBundlePath: string | null,
  cliFingerprint: RuntimeBundleFingerprint | null,
  options: ManagedRuntimeIdentityOptions,
  fingerprint: (path: string | null) => RuntimeBundleFingerprint | null,
): ManagedRuntimeMemberIdentity {
  const diskBundlePath = managedRuntimeBundlePath(process);
  const receipt = process ? readRuntimeBootReceipt(process, options.stateDir) : null;
  const bundlePath = receipt?.bundlePath ?? diskBundlePath;
  const diskBundle = fingerprint(diskBundlePath);
  const normalizedCli = normalizeRuntimePath(cliBundlePath);
  const normalizedBundle = normalizeRuntimePath(bundlePath);
  const online = process?.status === "online";
  const startedAt = process?.startedAt ?? null;
  const envFile = receipt?.envFile ?? options.envFile ?? join(options.stateDir ?? getRaviStateDir(), ".env");
  const diskEnv = runtimeFileMetadata(envFile);
  const codeStale =
    online &&
    Boolean(
      (startedAt !== null && diskBundle && diskBundle.mtimeMs > startedAt) ||
        (receipt?.bundle && (!diskBundle || receipt.bundle.sha256 !== diskBundle.sha256)) ||
        (receipt && normalizeRuntimePath(receipt.bundlePath) !== normalizeRuntimePath(diskBundlePath)),
    );
  const envStale =
    online &&
    Boolean(
      (startedAt !== null && diskEnv && diskEnv.mtimeMs > startedAt) ||
        (receipt &&
          (Boolean(receipt.env) !== Boolean(diskEnv) ||
            (receipt.env &&
              diskEnv &&
              (receipt.env.mtimeMs !== diskEnv.mtimeMs ||
                receipt.env.size !== diskEnv.size ||
                receipt.env.ino !== diskEnv.ino)))),
    );
  const stale = codeStale || envStale;
  const identityVerified = online && Boolean(receipt?.bundle && diskBundle);
  const samePath = normalizedCli && normalizedBundle ? normalizedCli === normalizedBundle : null;
  const matchesCli =
    samePath === false || stale
      ? false
      : identityVerified && samePath && cliFingerprint
        ? receipt!.bundle!.sha256 === cliFingerprint.sha256
        : null;
  const restart =
    name === CHANNELS_PM2_PROCESS_NAME ? "ravi channels restart" : 'ravi daemon restart -m "reconcile runtime"';
  const warnings: string[] = [];
  if (codeStale)
    warnings.push(
      `${name} is running stale code: the bundle on disk changed after process start. Reconcile explicitly: ${restart}`,
    );
  if (envStale)
    warnings.push(
      `${name} has a stale environment: .env changed after process start. Reconcile explicitly: ${restart}`,
    );
  if (online && !identityVerified)
    warnings.push(
      `${name} running version is unverified (no valid boot identity for this PID and start time). Reconcile explicitly: ${restart}`,
    );
  if (online && matchesCli === false && !stale)
    warnings.push(
      `${name} does not match the CLI bundle. Reconcile explicitly from the intended installation: ${restart}`,
    );
  return {
    name,
    managed: Boolean(process),
    online,
    status: process?.status ?? "not_managed_by_pm2",
    pid: process?.pid ?? null,
    bundlePath,
    cwd: safeRuntimeRealpath(process?.cwd),
    runningVersion: online ? (receipt?.runningVersion ?? null) : null,
    diskVersion: readRaviVersion(findRaviPackageRoot(diskBundlePath)),
    startedAt,
    stale,
    codeStale,
    envStale,
    identityVerified,
    warnings,
    matchesCli,
  };
}

export function managedRuntimeWarnings(identity: ManagedRuntimeIdentity): string[] {
  return [...identity.daemon.warnings, ...identity.channels.warnings];
}

export function buildManagedRuntimeIdentity(
  processes: Pm2Process[],
  cliBundleCandidate: string | null | undefined,
  currentProcessPid = process.pid,
  options: ManagedRuntimeIdentityOptions = {},
): ManagedRuntimeIdentity {
  const daemonProcess = processes.find((entry) => entry.name === PM2_PROCESS_NAME);
  const channelsProcess = processes.find((entry) => entry.name === CHANNELS_PM2_PROCESS_NAME);
  const daemonBundlePath = managedRuntimeBundlePath(daemonProcess);
  const cliBundlePath =
    daemonProcess?.pid === currentProcessPid ? daemonBundlePath : safeRuntimeRealpath(cliBundleCandidate);
  const cliTarget = resolveManagedRuntimeTargetFromBundle(cliBundlePath);
  const fingerprints = new Map<string, RuntimeBundleFingerprint | null>();
  const fingerprint = (path: string | null): RuntimeBundleFingerprint | null => {
    if (!path) return null;
    if (!fingerprints.has(path)) fingerprints.set(path, runtimeBundleFingerprint(path));
    return fingerprints.get(path) ?? null;
  };
  const observation = currentProcessPid === process.pid ? getRuntimeBootObservation() : null;
  const cliBoot =
    observation && normalizeRuntimePath(observation.bundlePath) === normalizeRuntimePath(cliBundlePath)
      ? observation
      : null;
  const cliFingerprint = cliBoot?.bundle ?? fingerprint(cliBundlePath);
  const daemon = identityForProcess(
    PM2_PROCESS_NAME,
    daemonProcess,
    cliBundlePath,
    cliFingerprint,
    options,
    fingerprint,
  );
  const channels = identityForProcess(
    CHANNELS_PM2_PROCESS_NAME,
    channelsProcess,
    cliBundlePath,
    cliFingerprint,
    options,
    fingerprint,
  );
  const onlineMembers = [daemon, channels].filter((member) => member.online);
  const managedMembers = [daemon, channels].filter((member) => member.managed);

  let alignment: ManagedRuntimeIdentity["alignment"] = "not_running";
  if (onlineMembers.length > 0) {
    if (managedMembers.some((member) => member.stale || member.matchesCli === false)) alignment = "drifted";
    else if (
      !daemon.online ||
      !cliFingerprint ||
      managedMembers.some((member) => !member.identityVerified || member.matchesCli !== true)
    )
      alignment = "unknown";
    else alignment = "aligned";
  }

  return {
    alignment,
    cli: {
      bundlePath: cliBundlePath,
      cwd: cliTarget?.cwd ?? findRaviPackageRoot(cliBundlePath),
      version: cliBoot?.runningVersion ?? cliTarget?.version ?? readRaviVersion(findRaviPackageRoot(cliBundlePath)),
    },
    daemon,
    channels,
  };
}

export function managedRuntimeMatchesTarget(
  previousProcesses: ManagedRuntimeProcessSnapshot[],
  currentProcesses: Pm2Process[],
  target: ManagedRuntimeTarget,
  options: ManagedRuntimeIdentityOptions = {},
): boolean {
  const identity = buildManagedRuntimeIdentity(currentProcesses, target.bundlePath, -1, options);
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
    const member = name === PM2_PROCESS_NAME ? identity.daemon : identity.channels;
    if (
      !member.identityVerified ||
      member.stale ||
      member.matchesCli !== true ||
      member.runningVersion !== target.version
    )
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
