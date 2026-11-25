/**
 * App store block-list runner (spec apps/store, "Blocking").
 *
 * Started by the daemon. While an app from the official source is installed,
 * it refreshes the signed source at start and every
 * `RAVI_APP_STORE_REFRESH_MS` (default 6 hours) and quarantines any installed
 * version the block list names. It never installs or updates anything.
 */

import { logger } from "../../utils/logger.js";
import { quarantineBlocked } from "./install.js";
import { listReceipts } from "./receipts.js";
import { type AppStoreContext, refreshSource } from "./source.js";
import { AppStoreError } from "./types.js";

const log = logger.child("apps:store-runner");

export const DEFAULT_APP_STORE_REFRESH_MS = 6 * 60 * 60_000;
const MIN_INTERVAL_MS = 60_000;

export function appStoreRefreshIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RAVI_APP_STORE_REFRESH_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_APP_STORE_REFRESH_MS;
  return Math.max(MIN_INTERVAL_MS, Math.trunc(raw));
}

export type AppStoreTickResult =
  | { status: "skipped"; reason: "no_official_apps" | "unconfigured" }
  | { status: "refreshed"; quarantined: string[] }
  | { status: "error"; code: string; quarantined: string[] };

export async function appStoreTick(ctx: AppStoreContext = {}): Promise<AppStoreTickResult> {
  if (!listReceipts(ctx.env).some((receipt) => receipt.source === "official")) {
    return { status: "skipped", reason: "no_official_apps" };
  }
  try {
    await refreshSource(ctx);
  } catch (error) {
    if (error instanceof AppStoreError && error.code === "APP_STORE_SOURCE_UNCONFIGURED") {
      return { status: "skipped", reason: "unconfigured" };
    }
    // A failed refresh keeps the last verified block list, which still applies.
    const quarantined = safeQuarantine(ctx);
    return { status: "error", code: error instanceof AppStoreError ? error.code : "UNKNOWN", quarantined };
  }
  return { status: "refreshed", quarantined: safeQuarantine(ctx) };
}

function safeQuarantine(ctx: AppStoreContext): string[] {
  try {
    return quarantineBlocked(ctx);
  } catch (error) {
    log.warn("App store could not apply the block list", { error: errorMessage(error) });
    return [];
  }
}

export class AppStoreRunner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly intervalMs: number;

  constructor(private readonly ctx: AppStoreContext & { intervalMs?: number } = {}) {
    this.intervalMs = ctx.intervalMs ?? appStoreRefreshIntervalMs(ctx.env);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      appStoreTick(this.ctx)
        .then((result) => {
          if (result.status === "error") log.warn("App store refresh failed; the last block list stays", result);
          const quarantined = result.status === "skipped" ? [] : result.quarantined;
          if (quarantined.length > 0) log.warn("App store quarantined blocked apps", { apps: quarantined });
        })
        .catch((error) => log.error("App store tick failed", { error: errorMessage(error) }))
        .finally(() => this.schedule(this.intervalMs));
    }, delay);
    this.timer.unref?.();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let singleton: AppStoreRunner | null = null;

export async function startAppStoreRunner(): Promise<void> {
  singleton ??= new AppStoreRunner();
  await singleton.start();
}

export async function stopAppStoreRunner(): Promise<void> {
  if (singleton) {
    await singleton.stop();
    singleton = null;
  }
}
