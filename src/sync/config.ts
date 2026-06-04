export const SYNC_RUNNER_ENABLED_ENV = "RAVI_SYNC_RUNNER_ENABLED";
export const SYNC_RUNNER_INTERVAL_ENV = "RAVI_SYNC_RUNNER_INTERVAL_MS";
export const SYNC_PULL_DOMAINS_ENV = "RAVI_SYNC_PULL_DOMAINS";

type Env = Record<string, string | undefined>;

export interface SyncRuntimeConfig {
  runnerEnabled: boolean;
  runnerEnabledEnv: typeof SYNC_RUNNER_ENABLED_ENV;
  pullDomains: string[];
}

export function getSyncRuntimeConfig(env: Env = process.env): SyncRuntimeConfig {
  return {
    runnerEnabled: env[SYNC_RUNNER_ENABLED_ENV] === "1",
    runnerEnabledEnv: SYNC_RUNNER_ENABLED_ENV,
    pullDomains: listEnv(SYNC_PULL_DOMAINS_ENV, env),
  };
}

export function listEnv(name: string, env: Env = process.env): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function numberEnv(name: string, fallback: number, env: Env = process.env): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
