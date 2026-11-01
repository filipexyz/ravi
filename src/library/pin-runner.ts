/**
 * Library pin runner (spec skills/library).
 *
 * Started by the daemon. While a `ravi login` session exists it reports the
 * local agents and reads this installation's pins (`POST /pins/sync`, or
 * `GET /pins` without the link scope) at start and every
 * `RAVI_LIBRARY_PIN_INTERVAL_MS` (default 5 minutes), then applies them
 * (`applyLibraryPins`). Offline or on any error the last pins stay loaded;
 * an expired or missing login waits quietly for the next tick.
 */

import { isCloudAuthError } from "../cloud-auth/errors.js";
import { logger } from "../utils/logger.js";
import { openLibrarySession, type LibrarySession, type LibrarySessionOptions } from "./client.js";
import { syncLibraryPins, type LibraryPinDeps, type LibraryPinSyncOutcome } from "./pins.js";

const log = logger.child("library:pin-runner");

export const DEFAULT_LIBRARY_PIN_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 10_000;
/** Codes that mean "no usable login": wait for the next tick without noise. */
const QUIET_CODES: ReadonlySet<string> = new Set([
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "AUTH_INVALID",
  "INSTALLATION_REVOKED",
  "UNAUTHORIZED",
]);

export interface LibraryPinRunnerOptions extends LibraryPinDeps {
  intervalMs?: number;
  openSession?: (options: LibrarySessionOptions) => Promise<LibrarySession | null>;
}

export function libraryPinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RAVI_LIBRARY_PIN_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIBRARY_PIN_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.trunc(raw));
}

export type LibraryPinTickResult =
  | { status: "synced"; outcome: LibraryPinSyncOutcome }
  | { status: "skipped"; reason: "no_login" }
  | { status: "error"; code: string; quiet: boolean };

export class LibraryPinRunner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<LibraryPinTickResult> | null = null;
  private readonly intervalMs: number;

  constructor(private readonly options: LibraryPinRunnerOptions = {}) {
    this.intervalMs = options.intervalMs ?? libraryPinIntervalMs();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info("Starting Library pin runner", { intervalMs: this.intervalMs });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    log.info("Stopped Library pin runner");
  }

  /** One sync now; overlapping calls share it. */
  tickOnce(): Promise<LibraryPinTickResult> {
    if (this.inFlight) return this.inFlight;
    const current = this.tick().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = current;
    return current;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tickOnce()
        .catch((error) => log.error("Library pin tick failed", { error: errorMessage(error) }))
        .finally(() => this.schedule(this.intervalMs));
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<LibraryPinTickResult> {
    let session: LibrarySession | null;
    try {
      const options: LibrarySessionOptions = { resolveProject: false };
      session = this.options.openSession ? await this.options.openSession(options) : await openLibrarySession(options);
    } catch (error) {
      log.debug("Library pin sync skipped: credentials unreadable", { error: errorMessage(error) });
      return { status: "skipped", reason: "no_login" };
    }
    if (!session) return { status: "skipped", reason: "no_login" };
    try {
      const outcome = await syncLibraryPins(session, { report: true }, this.options);
      if (outcome.changed) {
        log.info("Library pins synced", { pins: outcome.pins.length, revision: outcome.revision });
      }
      return { status: "synced", outcome };
    } catch (error) {
      const code = isCloudAuthError(error) ? error.code : "UNKNOWN";
      const quiet = QUIET_CODES.has(code) || (isCloudAuthError(error) && error.status === 401);
      const reason = isCloudAuthError(error) ? error.details?.reason : undefined;
      if (quiet) {
        log.debug("Library pin sync waiting for a valid login", { code });
      } else {
        // The pins of the last sync stay loaded.
        log.warn("Library pin sync failed; keeping the last pins", {
          code,
          ...(typeof reason === "string" ? { conflict: reason } : {}),
          error: errorMessage(error),
        });
      }
      return { status: "error", code, quiet };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let singleton: LibraryPinRunner | null = null;

export function getLibraryPinRunner(): LibraryPinRunner {
  singleton ??= new LibraryPinRunner();
  return singleton;
}

export async function startLibraryPinRunner(): Promise<void> {
  await getLibraryPinRunner().start();
}

export async function stopLibraryPinRunner(): Promise<void> {
  if (singleton) {
    await singleton.stop();
    singleton = null;
  }
}
