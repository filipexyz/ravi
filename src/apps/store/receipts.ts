/**
 * Install receipts (spec apps/store, "Receipts"). A receipt records what the
 * operator installed and which agents may see it. It grants nothing on its
 * own: the router checks the tree against it on every run, and the permission
 * gate reads `exposedTo`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appIdFileName, appStoreRoot, writeFileAtomic } from "./paths.js";
import { type AppReceipt, AppStoreError, appReceiptSchema } from "./types.js";

export const SIDELOADED_SCHEMA = "ravi.app-sideloaded/v1";

export function receiptsDir(env?: NodeJS.ProcessEnv): string {
  return join(appStoreRoot(env), "receipts");
}

export function receiptPath(id: string, env?: NodeJS.ProcessEnv): string {
  return join(receiptsDir(env), `${appIdFileName(id)}.json`);
}

export function readReceipt(id: string, env?: NodeJS.ProcessEnv): AppReceipt | null {
  const path = receiptPath(id, env);
  if (!existsSync(path)) return null;
  try {
    const receipt = appReceiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (receipt.id !== id) throw new Error(`receipt names ${receipt.id}`);
    return receipt;
  } catch (error) {
    throw new AppStoreError("APP_RECEIPT_INVALID", `The install receipt of ${id} is unreadable.`, 1, {
      id,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function writeReceipt(receipt: AppReceipt, env?: NodeJS.ProcessEnv): void {
  const parsed = appReceiptSchema.parse(receipt);
  writeFileAtomic(receiptPath(parsed.id, env), `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
}

export function listReceipts(env?: NodeJS.ProcessEnv): AppReceipt[] {
  const dir = receiptsDir(env);
  if (!existsSync(dir)) return [];
  const receipts: AppReceipt[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length).replaceAll("__", "/");
    const receipt = readReceipt(id, env);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}

/** True once the store has written anything: from then on, unknown state apps are refused. */
export function isStoreInitialized(env?: NodeJS.ProcessEnv): boolean {
  return existsSync(join(appStoreRoot(env), "sideloaded.json"));
}

/**
 * Apps already present in `$RAVI_STATE_DIR/apps` the first time the store
 * writes keep working: they were put there by hand before the store existed.
 */
export function readSideloaded(env?: NodeJS.ProcessEnv): Set<string> {
  const path = join(appStoreRoot(env), "sideloaded.json");
  if (!existsSync(path)) return new Set();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { schema?: string; apps?: unknown };
    if (value.schema !== SIDELOADED_SCHEMA || !Array.isArray(value.apps)) throw new Error("unexpected shape");
    return new Set(value.apps.filter((entry): entry is string => typeof entry === "string"));
  } catch (error) {
    throw new AppStoreError("APP_STORE_STATE_INVALID", "The store's sideloaded list is unreadable.", 1, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Record the baseline once. `existingIds` are the state apps discovered right now. */
export function ensureStoreInitialized(existingIds: readonly string[], env?: NodeJS.ProcessEnv): void {
  if (isStoreInitialized(env)) return;
  const apps = [...new Set(existingIds)].sort();
  writeFileAtomic(
    join(appStoreRoot(env), "sideloaded.json"),
    `${JSON.stringify({ schema: SIDELOADED_SCHEMA, createdAt: new Date().toISOString(), apps }, null, 2)}\n`,
    0o600,
  );
}
