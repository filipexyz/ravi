import { spawn } from "node:child_process";
import { which } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRunnerPm2Env } from "./channels/pm2-env.js";
import {
  managedRuntimeMatchesTarget,
  managedRuntimeBundlePath,
  normalizeRuntimePath,
  resolveManagedRuntimeTargetFromPackageRoot,
  type ManagedRuntimeProcessSnapshot,
  type ManagedRuntimeTarget,
} from "./managed-runtime.js";
import { buildChannelsPm2Env, buildChannelsPm2StartArgs, buildDaemonPm2StartArgs } from "./daemon-stdin.js";
import { readDaemonSchemaPhase } from "./db/daemon-schema-owner.js";
import { performSupervisedDaemonRestart, type ManagedDaemonProcess } from "./cli/daemon-restart-supervision.js";
import { buildPm2Env, CHANNELS_PM2_PROCESS_NAME, getPm2Processes, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";

const MANAGED_RUNTIME_REBIND_ENV = "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND";
const MANAGED_RUNTIME_REBIND_TIMEOUT_MS = 90_000;

type RunResult = {
  success: boolean;
  output: string;
};

type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stream?: boolean;
};

export type ManagedRuntimeRebindStep =
  | {
      action: "delete";
      processName: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME;
      args: string[];
    }
  | {
      action: "start";
      processName: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME;
      args: string[];
      cwd: string;
    }
  | { action: "save"; args: string[] };

type ManagedRuntimeRebindRequest = {
  schemaVersion: 1;
  target: ManagedRuntimeTarget;
  previousProcesses: ManagedRuntimeProcessSnapshot[];
};

type ManagedRuntimeRebindDependencies = {
  run?: (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;
  getProcesses?: () => Pm2Process[];
  runnerEnv?: () => Record<string, string>;
  bunPath?: string;
  schemaPhase?: (process: ManagedDaemonProcess) => "waiting" | "owned" | "ready" | null;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
};

function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const executable = which(command, { PATH: process.env.PATH });
      if (!executable) throw new Error(`${command} executable is unavailable in the caller PATH`);
      child = spawn(executable, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...(options.env ?? process.env), FORCE_COLOR: options.stream === false ? "0" : "1" },
      });
    } catch (error) {
      resolve({ success: false, output: error instanceof Error ? error.message : String(error) });
      return;
    }

    const output: string[] = [];
    child.stdout?.on("data", (data) => output.push(data.toString()));
    child.stderr?.on("data", (data) => output.push(data.toString()));
    child.once("close", (code) => resolve({ success: code === 0, output: output.join("") }));
    child.once("error", (error) => resolve({ success: false, output: error.message }));
  });
}

export function managedRuntimeSnapshot(processes: Pm2Process[]): ManagedRuntimeProcessSnapshot[] {
  return processes
    .filter((process) => process.name === PM2_PROCESS_NAME || process.name === CHANNELS_PM2_PROCESS_NAME)
    .map(({ name, status, pid, createdAt }) => ({ name, status, pid, createdAt: createdAt ?? null }));
}

export function buildManagedRuntimeRebindPlan(
  previousProcesses: ManagedRuntimeProcessSnapshot[],
  target: ManagedRuntimeTarget,
  bunPath = process.execPath,
  processes: Pm2Process[] = [],
): ManagedRuntimeRebindStep[] {
  const daemon = previousProcesses.find((process) => process.name === PM2_PROCESS_NAME);
  const channels = previousProcesses.find((process) => process.name === CHANNELS_PM2_PROCESS_NAME);
  const plan: ManagedRuntimeRebindStep[] = [];

  // Stop intake before replacing the daemon so both processes always use one bundle.
  if (channels) {
    plan.push({
      action: "delete",
      processName: CHANNELS_PM2_PROCESS_NAME,
      args: ["delete", CHANNELS_PM2_PROCESS_NAME],
    });
  }
  if (daemon) {
    plan.push({ action: "delete", processName: PM2_PROCESS_NAME, args: ["delete", PM2_PROCESS_NAME] });
  }
  if (daemon?.status === "online") {
    plan.push({
      action: "start",
      processName: PM2_PROCESS_NAME,
      args: buildDaemonPm2StartArgs({ bundlePath: target.bundlePath }),
      cwd: target.cwd,
    });
  }
  if (channels?.status === "online") {
    plan.push({
      action: "start",
      processName: CHANNELS_PM2_PROCESS_NAME,
      args: buildChannelsPm2StartArgs({ bundlePath: target.bundlePath, bunPath, processes }),
      cwd: target.cwd,
    });
  }
  if (daemon || channels) plan.push({ action: "save", args: ["save", "--force"] });
  return plan;
}

function encodeManagedRuntimeRebindRequest(request: ManagedRuntimeRebindRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

export function decodeManagedRuntimeRebindRequest(encoded: string): ManagedRuntimeRebindRequest {
  if (!encoded || encoded.length > 32_768) throw new Error("Invalid managed runtime rebind request");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid managed runtime rebind request");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid managed runtime rebind request");
  const input = parsed as Partial<ManagedRuntimeRebindRequest>;
  if (input.schemaVersion !== 1 || !input.target || !Array.isArray(input.previousProcesses)) {
    throw new Error("Invalid managed runtime rebind request");
  }

  const target = resolveManagedRuntimeTargetFromPackageRoot(input.target.cwd);
  if (
    !target ||
    normalizeRuntimePath(target.bundlePath) !== normalizeRuntimePath(input.target.bundlePath) ||
    target.version !== input.target.version
  ) {
    throw new Error("Managed runtime rebind target is not the requested Ravi bundle");
  }

  const seen = new Set<string>();
  const previousProcesses = input.previousProcesses.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid managed runtime process snapshot");
    if (entry.name !== PM2_PROCESS_NAME && entry.name !== CHANNELS_PM2_PROCESS_NAME) {
      throw new Error("Invalid managed runtime process name");
    }
    if (seen.has(entry.name)) throw new Error("Duplicate managed runtime process snapshot");
    seen.add(entry.name);
    if (
      typeof entry.status !== "string" ||
      typeof entry.pid !== "number" ||
      (entry.createdAt !== null && typeof entry.createdAt !== "number")
    ) {
      throw new Error("Invalid managed runtime process snapshot");
    }
    return { name: entry.name, status: entry.status, pid: entry.pid, createdAt: entry.createdAt };
  });

  return { schemaVersion: 1, target, previousProcesses };
}

async function waitForManagedRuntimeTarget(
  previousProcesses: ManagedRuntimeProcessSnapshot[],
  target: ManagedRuntimeTarget,
  getProcesses: () => Pm2Process[],
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (managedRuntimeMatchesTarget(previousProcesses, getProcesses(), target)) return true;
    await delay(250);
  }
  return managedRuntimeMatchesTarget(previousProcesses, getProcesses(), target);
}

export async function rebindManagedRuntimeProcesses(
  previousProcesses: ManagedRuntimeProcessSnapshot[],
  target: ManagedRuntimeTarget,
  dependencies: ManagedRuntimeRebindDependencies = {},
): Promise<boolean> {
  if (previousProcesses.length === 0) return true;
  const run = dependencies.run ?? runCommand;
  const getProcesses = dependencies.getProcesses ?? (() => getPm2Processes({ strict: true }));
  const bunPath = dependencies.bunPath ?? process.execPath;
  const phase = dependencies.schemaPhase ?? readDaemonSchemaPhase;
  const daemon = previousProcesses.find((process) => process.name === PM2_PROCESS_NAME);
  const channels = previousProcesses.find((process) => process.name === CHANNELS_PM2_PROCESS_NAME);
  if (channels?.status === "online" && daemon?.status !== "online") return false;

  const initial = getProcesses();
  for (const previous of previousProcesses) {
    const matches = initial.filter((process) => process.name === previous.name);
    if (
      matches.length !== 1 ||
      matches[0]!.pid !== previous.pid ||
      (previous.createdAt !== null && matches[0]!.createdAt !== previous.createdAt)
    )
      return false;
  }

  // Prepare launch arguments and runner settings before any PM2 mutation.
  const plan = buildManagedRuntimeRebindPlan(previousProcesses, target, bunPath, initial);
  const runtimeEnv = buildPm2Env({
    RAVI_BUNDLE: target.bundlePath,
    RAVI_DAEMON_CWD: target.cwd,
    RAVI_PM2_EXECUTABLE: bunPath,
  });
  runtimeEnv[MANAGED_RUNTIME_REBIND_ENV] = "";
  runtimeEnv.RAVI_REPO = existsSync(join(target.cwd, ".git")) ? target.cwd : "";
  const runnerEnv = { ...(dependencies.runnerEnv ?? buildRunnerPm2Env)(), ...buildChannelsPm2Env(bunPath) };
  const execute = async (args: string[], env = runtimeEnv, cwd?: string): Promise<number> => {
    const result = await run("pm2", args, { cwd, env, stream: false });
    return result.success ? 0 : 1;
  };
  const save = () => execute(["save", "--force"]);
  const remove = async (name: string): Promise<number> => {
    for (const process of getProcesses().filter((entry) => entry.name === name)) {
      if ((await execute(["delete", String(process.pm_id)])) !== 0) return 1;
    }
    return 0;
  };
  const asManaged = (process: Pm2Process): ManagedDaemonProcess => ({
    name: process.name,
    pmId: process.pm_id,
    pid: process.pid,
    status: process.status,
    startedAt: process.startedAt ?? undefined,
  });
  const predecessor = initial.find((process) => process.name === PM2_PROCESS_NAME);
  const coordinated = predecessor?.status === "online" && phase(asManaged(predecessor)) === "ready";
  let readyDaemon: ManagedDaemonProcess | undefined;
  const daemonStillReady = (processes: Pm2Process[]): boolean => {
    const expected = readyDaemon;
    if (!expected) return daemon?.status !== "online";
    const current = processes.find(
      (process) =>
        process.name === PM2_PROCESS_NAME &&
        process.pm_id === expected.pmId &&
        process.pid === expected.pid &&
        (process.startedAt ?? undefined) === expected.startedAt,
    );
    return Boolean(
      current &&
        current.status === "online" &&
        phase(asManaged(current)) === "ready" &&
        managedRuntimeMatchesTarget([daemon!], processes, target),
    );
  };

  // Legacy owners do not hold the schema lock. They cannot coexist with a new
  // writer, even while PM2 reports both processes online.
  if (!coordinated) {
    if ((await remove(CHANNELS_PM2_PROCESS_NAME)) !== 0) return false;
    if ((await remove(PM2_PROCESS_NAME)) !== 0) return false;
  }

  const daemonStart = plan.find((step) => step.action === "start" && step.processName === PM2_PROCESS_NAME);
  if (daemonStart) {
    const result = await performSupervisedDaemonRestart({
      list: () =>
        getProcesses()
          .filter((process) => process.name === PM2_PROCESS_NAME)
          .map(asManaged),
      start: ({ force }) => {
        const args = [...daemonStart.args];
        if (force) args.splice(args.indexOf("--"), 0, "--force");
        return execute(args, runtimeEnv, target.cwd);
      },
      deletePmId: (pmId) => execute(["delete", String(pmId)]),
      save,
      beforePredecessorStop: () => remove(CHANNELS_PM2_PROCESS_NAME),
      pidAlive:
        dependencies.pidAlive ??
        ((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            // no-cause: A failed liveness probe cannot prove a supervised successor, so preserve the predecessor.
            return false;
          }
        }),
      schemaPhase: (candidate) => {
        const current = getProcesses().find(
          (process) => process.pm_id === candidate.pmId && process.pid === candidate.pid,
        );
        if (
          !current ||
          normalizeRuntimePath(managedRuntimeBundlePath(current)) !== normalizeRuntimePath(target.bundlePath)
        )
          return null;
        return phase(candidate);
      },
      now: dependencies.now,
      wait: dependencies.wait,
      readyTimeoutMs: dependencies.readyTimeoutMs,
    });
    if (!result.ok || !result.readySuccessor) return false;
    readyDaemon = result.readySuccessor;
    if (!daemonStillReady(getProcesses())) return false;
  }

  const channelStart = plan.find((step) => step.action === "start" && step.processName === CHANNELS_PM2_PROCESS_NAME);
  if (
    channelStart &&
    (await execute(channelStart.args, buildPm2Env({ ...runtimeEnv, ...runnerEnv }), target.cwd)) !== 0
  )
    return false;
  if (!(await waitForManagedRuntimeTarget(previousProcesses, target, getProcesses))) return false;
  if (!daemonStillReady(getProcesses())) return false;
  if ((await save()) !== 0) return false;
  const finalProcesses = getProcesses();
  return daemonStillReady(finalProcesses) && managedRuntimeMatchesTarget(previousProcesses, finalProcesses, target);
}

export function buildManagedRuntimeRebindSupervisorInvocation(
  target: ManagedRuntimeTarget,
  processes: Pm2Process[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  const request: ManagedRuntimeRebindRequest = {
    schemaVersion: 1,
    target,
    previousProcesses: managedRuntimeSnapshot(processes),
  };
  const env = buildPm2Env({
    ...(baseEnv as Record<string, string>),
    RAVI_BUNDLE: target.bundlePath,
    RAVI_DAEMON_CWD: target.cwd,
  });
  if (existsSync(join(target.cwd, ".git"))) env.RAVI_REPO = target.cwd;
  else delete env.RAVI_REPO;
  env[MANAGED_RUNTIME_REBIND_ENV] = encodeManagedRuntimeRebindRequest(request);
  return { command: process.execPath, args: [target.bundlePath], cwd: target.cwd, env };
}

export async function maybeRunManagedRuntimeRebindFromEnv(): Promise<boolean> {
  const encoded = process.env[MANAGED_RUNTIME_REBIND_ENV];
  if (!encoded) return false;
  delete process.env[MANAGED_RUNTIME_REBIND_ENV];
  const request = decodeManagedRuntimeRebindRequest(encoded);
  if (!(await rebindManagedRuntimeProcesses(request.previousProcesses, request.target))) {
    throw new Error("Managed Ravi runtime did not converge on the updated bundle");
  }
  return true;
}

export async function runManagedRuntimeRebindSupervisor(
  target: ManagedRuntimeTarget,
  processes: Pm2Process[],
): Promise<boolean> {
  const invocation = buildManagedRuntimeRebindSupervisorInvocation(target, processes);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        detached: true,
        stdio: "ignore",
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.unref();
      resolve(success);
    };
    timer = setTimeout(() => finish(false), MANAGED_RUNTIME_REBIND_TIMEOUT_MS);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}
