import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRunnerPm2Env } from "./channels/pm2-env.js";
import {
  managedRuntimeMatchesTarget,
  normalizeRuntimePath,
  resolveManagedRuntimeTargetFromPackageRoot,
  type ManagedRuntimeProcessSnapshot,
  type ManagedRuntimeTarget,
} from "./managed-runtime.js";
import { buildPm2Env, CHANNELS_PM2_PROCESS_NAME, getPm2Processes, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";

const MANAGED_RUNTIME_REBIND_ENV = "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND";
const MANAGED_RUNTIME_REBIND_TIMEOUT_MS = 30_000;

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
};

function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
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
      args: ["start", target.bundlePath, "--name", PM2_PROCESS_NAME, "--interpreter", bunPath, "--", "daemon", "run"],
      cwd: target.cwd,
    });
  }
  if (channels?.status === "online") {
    plan.push({
      action: "start",
      processName: CHANNELS_PM2_PROCESS_NAME,
      args: ["start", bunPath, "--name", CHANNELS_PM2_PROCESS_NAME, "--", target.bundlePath, "channels", "run"],
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
  const run = dependencies.run ?? runCommand;
  const getProcesses = dependencies.getProcesses ?? getPm2Processes;
  const plan = buildManagedRuntimeRebindPlan(previousProcesses, target, dependencies.bunPath);
  if (plan.length === 0) return true;

  const runtimeEnv = buildPm2Env({ RAVI_BUNDLE: target.bundlePath, RAVI_DAEMON_CWD: target.cwd });
  delete runtimeEnv[MANAGED_RUNTIME_REBIND_ENV];
  if (existsSync(join(target.cwd, ".git"))) runtimeEnv.RAVI_REPO = target.cwd;
  else delete runtimeEnv.RAVI_REPO;
  const runnerEnv = (dependencies.runnerEnv ?? buildRunnerPm2Env)();

  for (const step of plan) {
    if (step.action === "save") continue;
    const env =
      step.action === "start" && step.processName === CHANNELS_PM2_PROCESS_NAME
        ? { ...runtimeEnv, ...runnerEnv }
        : runtimeEnv;
    const result = await run("pm2", step.args, {
      cwd: step.action === "start" ? step.cwd : undefined,
      env,
      stream: false,
    });
    if (!result.success) return false;
  }

  if (!(await waitForManagedRuntimeTarget(previousProcesses, target, getProcesses))) return false;
  const saveStep = plan.find((step) => step.action === "save");
  if (saveStep) {
    const saved = await run("pm2", saveStep.args, { env: runtimeEnv, stream: false });
    if (!saved.success) return false;
  }
  return managedRuntimeMatchesTarget(previousProcesses, getProcesses(), target);
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
