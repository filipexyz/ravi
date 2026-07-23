import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { close as closeChatDb } from "../db.js";
import { closeContacts } from "../contacts.js";
import { closeSessionAdapterStore } from "../adapters/adapter-db.js";
import { closeDevinDb } from "../devin/store.js";
import { closeRouterDb } from "../router/router-db.js";
import { closeSessionStore } from "../router/sessions.js";

const RAVI_STATE_LOCK_DIR = join(tmpdir(), "ravi-test-state.lock");
const RAVI_STATE_LOCK_RETRY_MS = 10;
const RAVI_STATE_LOCK_STALE_MS = 60_000;
const RAVI_STATE_LOCK_TIMEOUT_MS = 120_000;
const pendingStateDirs = new Set<string>();
let pendingStateCleanupRegistered = false;
let previousAuditSuppression: string | undefined;

export const RAVI_RUNTIME_CONTEXT_ENV_KEYS = [
  "RAVI_ACCOUNT_ID",
  "RAVI_ACTOR_AGENT_ID",
  "RAVI_ACTOR_TYPE",
  "RAVI_AGENT_ID",
  "RAVI_CANONICAL_CHAT_ID",
  "RAVI_CHANNEL",
  "RAVI_CHAT_ID",
  "RAVI_CONTACT_ID",
  "RAVI_CONTEXT_KEY",
  "RAVI_GROUP_ID",
  "RAVI_GROUP_NAME",
  "RAVI_INSTANCE_ID",
  "RAVI_NORMALIZED_SENDER_ID",
  "RAVI_PLATFORM_IDENTITY_ID",
  "RAVI_RAW_SENDER_ID",
  "RAVI_SENDER_ID",
  "RAVI_SENDER_NAME",
  "RAVI_SENDER_PHONE",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_TURN_SCOPED_AUTHORITY",
] as const;

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
  closeDevinDb();
  closeSessionAdapterStore();
  closeSessionStore();
  closeRouterDb();
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  pendingStateDirs.add(stateDir);
  ensurePendingStateCleanup();
  process.env.RAVI_STATE_DIR = stateDir;
  previousAuditSuppression = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
  process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
  return stateDir;
}

export function withoutRaviRuntimeContextEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cleanEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of RAVI_RUNTIME_CONTEXT_ENV_KEYS) {
    delete cleanEnv[key];
  }
  return cleanEnv;
}

export async function cleanupIsolatedRaviState(stateDir?: string | null): Promise<void> {
  closeChatDb();
  closeContacts();
  closeDevinDb();
  closeSessionAdapterStore();
  closeSessionStore();
  closeRouterDb();
  delete process.env.RAVI_STATE_DIR;
  if (previousAuditSuppression === undefined) {
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
  } else {
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousAuditSuppression;
  }
  previousAuditSuppression = undefined;
  if (stateDir) pendingStateDirs.add(stateDir);
  releaseRaviStateLock();
}
