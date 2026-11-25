/**
 * What discovery accepts from `$RAVI_STATE_DIR/apps` once the store is in use
 * (spec apps/store, "Discovery"). Before the store first writes, nothing
 * changes. After that, a state app runs only when it has a receipt or was
 * already there when the store started (the sideloaded baseline), so a folder
 * dropped into the state directory later is not picked up as an app.
 */

import { join, resolve } from "node:path";
import type { RaviAppManifestRecord } from "../types.js";
import { appIdToPath, stateAppsRoot } from "./paths.js";
import { isStoreInitialized, readReceipt, readSideloaded } from "./receipts.js";

export function markStoreOwnership(records: RaviAppManifestRecord[], env: NodeJS.ProcessEnv = process.env): void {
  const stateRecords = records.filter((record) => record.source === "state");
  if (stateRecords.length === 0) return;
  let initialized = false;
  let sideloaded = new Set<string>();
  try {
    initialized = isStoreInitialized(env);
    if (initialized) sideloaded = readSideloaded(env);
  } catch (error) {
    for (const record of stateRecords) reject(record, `the app store state is unreadable: ${message(error)}`);
    return;
  }
  for (const record of stateRecords) {
    const id = record.manifest?.id?.trim().toLowerCase() || record.id;
    let receipt: ReturnType<typeof readReceipt> = null;
    try {
      receipt = readReceipt(id, env);
    } catch (error) {
      reject(record, message(error));
      continue;
    }
    if (receipt) {
      const expected = resolve(join(stateAppsRoot(env), ...appIdToPath(id), "ravi.app.json"));
      if (record.path !== expected) {
        reject(record, `store app ${id} must live at ${expected}`);
      } else if (receipt.state === "quarantined") {
        reject(record, `store app ${id} is quarantined: ${receipt.quarantine?.reason ?? "no reason recorded"}`);
      }
      continue;
    }
    if (initialized && !sideloaded.has(id)) {
      reject(record, `${id} was not installed by the app store; install it with ravi apps install`);
    }
  }
}

function reject(record: RaviAppManifestRecord, error: string): void {
  record.errors.push(error);
  record.valid = false;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
