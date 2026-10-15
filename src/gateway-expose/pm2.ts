// PM2 registration of the tunnel runner, `ravi-gateway` (called by
// `ravi gateway expose`, 05b). The PM2 entry carries no secret: `buildPm2Env`
// drops `TUNNEL_*`, and the runner reads the credentials from the secret store
// at start and hands them to cloudflared only. Exit 78 (drift latched, not
// configured) is a stop code, so PM2 does not restart a refusing runner.

import { buildPm2Env, GATEWAY_PM2_PROCESS_NAME } from "../pm2.js";
import { TUNNEL_RUNNER_EXIT_REFUSED } from "./tunnel-runner.js";

/** Above cloudflared's 1 s `--grace-period`, so a stop never SIGKILLs the runner before its child is gone. */
export const GATEWAY_PM2_KILL_TIMEOUT_MS = 8_000;

export interface GatewayRunnerTarget {
  bundlePath: string;
  cwd?: string;
}

export type Pm2Runner = (args: string[], options: { cwd?: string; env: Record<string, string> }) => { status: number };

export function buildGatewayRunnerPm2Args(target: GatewayRunnerTarget): string[] {
  return [
    "start",
    "bun",
    "--name",
    GATEWAY_PM2_PROCESS_NAME,
    "--kill-timeout",
    String(GATEWAY_PM2_KILL_TIMEOUT_MS),
    "--stop-exit-codes",
    String(TUNNEL_RUNNER_EXIT_REFUSED),
    "--",
    target.bundlePath,
    "gateway",
    "tunnel-run",
  ];
}

/** `pm2 delete` (when present) + `pm2 start` + `pm2 save`; returns the statuses. */
export function startGatewayRunnerPm2(
  target: GatewayRunnerTarget,
  deps: { runPm2: Pm2Runner; exists: () => boolean; baseEnv?: NodeJS.ProcessEnv },
): { status: number; saveStatus: number | null } {
  const env = buildPm2Env(undefined, deps.baseEnv ?? process.env);
  if (deps.exists()) {
    const deleted = deps.runPm2(["delete", GATEWAY_PM2_PROCESS_NAME], { env });
    if (deleted.status !== 0) return { status: deleted.status, saveStatus: null };
  }
  const { status } = deps.runPm2(buildGatewayRunnerPm2Args(target), { cwd: target.cwd, env });
  if (status !== 0) return { status, saveStatus: null };
  return { status, saveStatus: deps.runPm2(["save", "--force"], { env }).status };
}
