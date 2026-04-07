import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { getRaviDbPath, dbGetInstance } from "../router/router-db.js";

type DaemonRuntimeInfo = {
  online: boolean;
  execPath: string | null;
  cwd: string | null;
  matchesCli: boolean | null;
};

type InstanceRuntimeInfo = {
  name: string;
  exists: boolean;
  enabled: boolean;
  instanceId: string | null;
  channel: string | null;
  affectsLiveMain: boolean;
};

export type CliRuntimeTargetSummary = {
  cliExecPath: string | null;
  cliBundlePath: string | null;
  dbPath: string;
  daemon: DaemonRuntimeInfo;
  instance: InstanceRuntimeInfo | null;
};

function safeRealpath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function normalizeComparablePath(value: string | null | undefined): string | null {
  const resolved = safeRealpath(value);
  return resolved ? resolved.toLowerCase() : null;
}

function readDaemonRuntimeInfo(): DaemonRuntimeInfo {
  try {
    const raw = execFileSync("pm2", ["jlist"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const list = JSON.parse(raw) as Array<Record<string, any>>;
    const ravi = list.find((entry) => entry?.name === "ravi");
    const status = ravi?.pm2_env?.status;
    const execPath = safeRealpath(ravi?.pm2_env?.pm_exec_path ?? null);
    const cwd = safeRealpath(ravi?.pm2_env?.pm_cwd ?? null);
    const cliBundlePath = normalizeComparablePath(process.argv[1] ?? null);
    const daemonBundlePath = normalizeComparablePath(execPath);
    return {
      online: status === "online",
      execPath,
      cwd,
      matchesCli: cliBundlePath && daemonBundlePath ? cliBundlePath === daemonBundlePath : null,
    };
  } catch {
    return {
      online: false,
      execPath: null,
      cwd: null,
      matchesCli: null,
    };
  }
}

export function inspectCliRuntimeTarget(instanceName?: string | null): CliRuntimeTargetSummary {
  const instance = instanceName ? dbGetInstance(instanceName) : null;

  return {
    cliExecPath: safeRealpath(process.env._ ?? null),
    cliBundlePath: safeRealpath(process.argv[1] ?? null),
    dbPath: getRaviDbPath(),
    daemon: readDaemonRuntimeInfo(),
    instance: instanceName
      ? {
          name: instanceName,
          exists: Boolean(instance),
          enabled: instance?.enabled !== false,
          instanceId: instance?.instanceId ?? null,
          channel: instance?.channel ?? null,
          affectsLiveMain: instanceName === "main",
        }
      : null,
  };
}

export function formatCliRuntimeTarget(summary: CliRuntimeTargetSummary): string[] {
  const lines = [
    "Runtime target:",
    `  CLI bundle:   ${summary.cliBundlePath ?? "-"}`,
    `  DB:           ${summary.dbPath}`,
  ];

  if (summary.daemon.online) {
    lines.push(`  Daemon:       online`);
    lines.push(`  Daemon bundle:${summary.daemon.execPath ?? "-"}`);
    lines.push(`  Same runtime: ${summary.daemon.matchesCli === true ? "yes" : "no"}`);
  } else {
    lines.push("  Daemon:       offline/unknown");
  }

  if (summary.instance) {
    lines.push(`  Instance:     ${summary.instance.name}`);
    lines.push(`  Enabled:      ${summary.instance.enabled ? "yes" : "no"}`);
    lines.push(`  Channel:      ${summary.instance.channel ?? "-"}`);
    lines.push(`  Instance ID:  ${summary.instance.instanceId ?? "-"}`);
    lines.push(`  Affects main: ${summary.instance.affectsLiveMain ? "yes" : "no"}`);
  }

  return lines;
}

export function getCliRuntimeMismatchMessage(summary: CliRuntimeTargetSummary): string | null {
  if (!summary.daemon.online || summary.daemon.matchesCli !== false) {
    return null;
  }

  return [
    "CLI/runtime mismatch detected.",
    `CLI bundle: ${summary.cliBundlePath ?? "-"}`,
    `Daemon bundle: ${summary.daemon.execPath ?? "-"}`,
    "This mutation would not be trustworthy against the live daemon.",
    "Use the repo CLI/runtime instead of the outdated PATH/global bundle.",
  ].join("\n");
}
