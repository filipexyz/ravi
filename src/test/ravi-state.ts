import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { close as closeChatDb } from "../db.js";
import { closeContacts } from "../contacts.js";
import { closeSessionAdapterStore } from "../adapters/adapter-db.js";
import { closeRouterDb } from "../router/router-db.js";
import { closeSessionStore } from "../router/sessions.js";

const RAVI_STATE_LOCK_DIR = join(tmpdir(), "ravi-test-state.lock");
const RAVI_STATE_LOCK_RETRY_MS = 10;
const RAVI_STATE_LOCK_STALE_MS = 60_000;
const RAVI_STATE_LOCK_TIMEOUT_MS = 120_000;
const pendingStateDirs = new Set<string>();
let pendingStateCleanupRegistered = false;

async function acquireRaviStateLock(): Promise<void> {
  const deadline = Date.now() + RAVI_STATE_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(RAVI_STATE_LOCK_DIR);
      return;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = statSync(RAVI_STATE_LOCK_DIR);
        if (Date.now() - stats.mtimeMs > RAVI_STATE_LOCK_STALE_MS) {
          rmSync(RAVI_STATE_LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock may have been released between stat attempts.
      }

      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for isolated Ravi state lock");
      }

      await new Promise((resolve) => setTimeout(resolve, RAVI_STATE_LOCK_RETRY_MS));
    }
  }
}

function releaseRaviStateLock(): void {
  rmSync(RAVI_STATE_LOCK_DIR, { recursive: true, force: true });
}

function flushPendingStateDirs(): void {
  for (const dir of pendingStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  pendingStateDirs.clear();
}

function ensurePendingStateCleanup(): void {
  if (pendingStateCleanupRegistered) {
    return;
  }

  pendingStateCleanupRegistered = true;
  process.once("exit", flushPendingStateDirs);
}

export async function createIsolatedRaviState(prefix = "ravi-test-"): Promise<string> {
  await acquireRaviStateLock();
  closeChatDb();
  closeContacts();
  closeSessionAdapterStore();
  closeSessionStore();
  closeRouterDb();
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  pendingStateDirs.add(stateDir);
  ensurePendingStateCleanup();
  process.env.RAVI_STATE_DIR = stateDir;
  return stateDir;
}

export async function cleanupIsolatedRaviState(stateDir?: string | null): Promise<void> {
  closeChatDb();
  closeContacts();
  closeSessionAdapterStore();
  closeSessionStore();
  closeRouterDb();
  delete process.env.RAVI_STATE_DIR;
  if (stateDir) pendingStateDirs.add(stateDir);
  releaseRaviStateLock();
}
