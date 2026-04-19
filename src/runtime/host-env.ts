import { delimiter, dirname, join } from "node:path";
import { SANITIZED_ENV_VARS } from "../hooks/sanitize-bash.js";
import { dbResolveActiveTaskBindingForSession } from "../tasks/task-db.js";
import type { RuntimeCapabilities } from "./types.js";

const TASK_RUNTIME_ENV_VARS = [
  "RAVI_TASK_ID",
  "RAVI_TASK_PROFILE_ID",
  "RAVI_PARENT_TASK_ID",
  "RAVI_TASK_SESSION",
  "RAVI_TASK_WORKSPACE",
];

function resolveCanonicalRaviCliPath(): string | null {
  const explicit = process.env.RAVI_BIN?.trim();
  if (explicit) {
    return explicit;
  }

  const bundlePath = process.argv[1];
  if (!bundlePath) {
    return null;
  }

  return join(dirname(dirname(dirname(bundlePath))), "bin", "ravi");
}

function prependPathEntry(currentPath: string | undefined, entry: string): string {
  const parts = (currentPath ?? "")
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== entry);
  return [entry, ...parts].join(delimiter);
}

export function buildRuntimeEnv(
  baseEnv: Record<string, string>,
  raviEnv: Record<string, string>,
  providerEnv: Record<string, string> | undefined,
  capabilities: RuntimeCapabilities,
): Record<string, string> {
  const sanitizedBaseEnv = { ...baseEnv };
  for (const key of TASK_RUNTIME_ENV_VARS) {
    delete sanitizedBaseEnv[key];
  }

  const runtimeEnv = {
    ...sanitizedBaseEnv,
    ...(providerEnv ?? {}),
    ...raviEnv,
  };
  const canonicalRaviCliPath = resolveCanonicalRaviCliPath();
  if (canonicalRaviCliPath) {
    runtimeEnv.RAVI_BIN = canonicalRaviCliPath;
    runtimeEnv.PATH = prependPathEntry(runtimeEnv.PATH, dirname(canonicalRaviCliPath));
  }

  if (!capabilities.supportsToolHooks) {
    for (const key of SANITIZED_ENV_VARS) {
      delete runtimeEnv[key];
    }
  }

  return runtimeEnv;
}

export function buildTaskRuntimeEnv(
  sessionName: string,
  sessionCwd: string,
  taskBarrierTaskId?: string,
): Record<string, string> {
  const normalizedTaskId = normalizePromptTaskBarrierTaskId(taskBarrierTaskId);
  if (!normalizedTaskId) {
    return {};
  }

  const binding = dbResolveActiveTaskBindingForSession(sessionName, normalizedTaskId);
  if (!binding) {
    return {};
  }

  const { task, assignment } = binding;
  const workspaceRoot =
    (assignment.worktree?.mode === "path" ? assignment.worktree.path : undefined) ??
    (task.worktree?.mode === "path" ? task.worktree.path : undefined) ??
    task.taskDir ??
    sessionCwd;

  return {
    RAVI_TASK_ID: task.id,
    ...(task.profileId ? { RAVI_TASK_PROFILE_ID: task.profileId } : {}),
    ...(task.parentTaskId ? { RAVI_PARENT_TASK_ID: task.parentTaskId } : {}),
    RAVI_TASK_SESSION: assignment.sessionName,
    ...(workspaceRoot ? { RAVI_TASK_WORKSPACE: workspaceRoot } : {}),
  };
}

export function normalizePromptTaskBarrierTaskId(taskBarrierTaskId?: string): string | undefined {
  const normalized = taskBarrierTaskId?.trim();
  return normalized ? normalized : undefined;
}
