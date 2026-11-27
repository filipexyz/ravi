/**
 * Where the store keeps its files, under the Ravi state directory:
 *
 *   $RAVI_STATE_DIR/app-store/
 *     sources/<source>/   verified keys.json, index.json, blocklist.json (+ .sig) and state.json
 *     receipts/<id>.json  one receipt per installed app
 *     packages/<id>/<version>-<hash12>/   the installed tree of each kept version
 *     staging/            downloads before they are checked
 *     trash/              uninstalled apps, kept for recovery
 *     sideloaded.json     apps already in $RAVI_STATE_DIR/apps when the store first wrote
 *   $RAVI_STATE_DIR/apps/<id>/   the active copy that discovery reads
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRaviStateDir } from "../../utils/paths.js";

export function appStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "app-store");
}

export function stateAppsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "apps");
}

export function appIdToPath(id: string): string[] {
  return id.split("/");
}

/** File-safe name for an app id (ids may contain "/"). */
export function appIdFileName(id: string): string {
  return id.replaceAll("/", "__");
}

export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

export function readFileIfExists(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null;
}
