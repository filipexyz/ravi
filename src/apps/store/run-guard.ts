/**
 * Checks the router runs before a store app operation (spec apps/store,
 * "Run"). The tree on disk must still hash to the receipt, and an official
 * app must not be on the cached block list. A failure refuses the run; it
 * never repairs anything by itself.
 */

import type { RaviAppManifestRecord } from "../types.js";
import { checkReceiptTree } from "./install.js";
import { readReceipt } from "./receipts.js";
import { findBlock, loadCachedSource } from "./source.js";
import type { AppStoreSourceConfig } from "./trust.js";
import { AppStoreError } from "./types.js";

export function assertStoreAppRunnable(
  app: RaviAppManifestRecord,
  env: NodeJS.ProcessEnv = process.env,
  source?: AppStoreSourceConfig,
): void {
  if (app.source !== "state") return;
  const id = app.manifest?.id ?? app.id;
  const receipt = readReceipt(id, env);
  if (!receipt) return;
  if (receipt.state !== "active") {
    throw new AppStoreError("APP_QUARANTINED", `${id} is quarantined: ${receipt.quarantine?.reason ?? ""}`, 3, { id });
  }
  const problems = checkReceiptTree(receipt, { env });
  if (problems.length > 0) {
    throw new AppStoreError("APP_TREE_CHANGED", `${id} does not match its install receipt: ${problems.join("; ")}`, 3, {
      id,
      problems,
    });
  }
  if (receipt.source === "official") {
    const cached = loadCachedSource({ env, source });
    const block = cached ? findBlock(cached.blocklist, id, receipt.version, receipt.treeHash) : null;
    if (block) {
      throw new AppStoreError(
        "APP_BLOCKED",
        `${id}@${receipt.version} is blocked: ${block.reason || "no reason given"}.`,
        3,
        {
          id,
        },
      );
    }
  }
}
