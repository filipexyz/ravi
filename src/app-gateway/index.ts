/**
 * Daemon wiring for the Pages app gateway relay runner.
 *
 * Opt-in: unless `RAVI_APP_GATEWAY_ENABLED=1`, nothing is imported and no
 * socket is ever opened. Per-daemon (not leader-gated); the SQLite relay
 * lease keeps one socket per installation across daemons sharing a state dir.
 */

import { APP_GATEWAY_ENABLED_ENV } from "./constants.js";
import type { AppGatewayRelayRunner } from "./relay-runner.js";

let singleton: AppGatewayRelayRunner | null = null;

export function isAppGatewayRelayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[APP_GATEWAY_ENABLED_ENV] === "1";
}

export async function startAppGatewayRelayRunner(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!isAppGatewayRelayEnabled(env)) return false;
  if (!singleton) {
    const { AppGatewayRelayRunner } = await import("./relay-runner.js");
    singleton = new AppGatewayRelayRunner({ env });
  }
  await singleton.start();
  return true;
}

export async function stopAppGatewayRelayRunner(): Promise<void> {
  if (!singleton) return;
  const runner = singleton;
  singleton = null;
  await runner.stop();
}
