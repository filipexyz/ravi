/**
 * `ravi storage` — one native, fail-closed disk cleanup operation.
 *
 * Surface: `ravi storage cleanup --tier <routine|weekly> [--execute] [--json]`.
 * Dry-run is the default and performs no mutation; `--execute` removes only the
 * candidates the same policy would have shown. The command is host-local, so it
 * is `@CliOnly` — it is intentionally not part of the remote SDK/OpenAPI
 * surface.
 *
 * Tests and the out-of-candidate checker drive the destructive path through the
 * fixture seams gated by `RAVI_STORAGE_FIXTURE_MODE=1` (tmp roots, receipt dir
 * and allowlist live in `src/storage/policy.ts`).
 */

import "reflect-metadata";
import { z } from "zod";
import { CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { CONTRACT_EXIT_ERROR, CONTRACT_EXIT_USAGE, contractFail } from "../agent-contract.js";
import { StorageLockedError, runStorageCleanup, type StorageCleanupResult } from "../../storage/cleanup.js";
import { STORAGE_TIERS } from "../../storage/policy.js";

const OP = "storage cleanup";

const storageAreaSummarySchema = z.object({
  candidates: z.number(),
  removed: z.number(),
  preserved: z.number(),
  freedBytes: z.number(),
});

const storageCleanupReturnSchema = z
  .object({
    success: z.boolean(),
    op: z.literal("storage cleanup"),
    tier: z.enum(["routine", "weekly"]),
    dryRun: z.boolean(),
    policyVersion: z.string(),
    policyHash: z.string(),
    bytesBefore: z.number(),
    bytesAfter: z.number(),
    freedBytes: z.number(),
    areas: z.record(z.string(), storageAreaSummarySchema),
    errors: z.array(z.string()),
    limitations: z.array(z.string()),
    removed: z.array(z.string()),
    preserved: z.array(z.string()),
    receiptId: z.string(),
    receiptPath: z.string(),
    executedAt: z.string(),
  })
  .passthrough();

@Group({ name: "storage", description: "Native, fail-closed disk cleanup", scope: "open" })
export class StorageCommands {
  @Command({
    name: "cleanup",
    description: "Remove only unambiguous, allowlisted, aged disk artifacts (dry-run by default; requires --execute)",
    helpAfter: [
      "",
      "Tiers:",
      "  routine  tmp-ravi namespaces and Codex artifacts with an inactive proof",
      "  weekly   orphan Omni objects and terminal task worktrees (>20 days)",
      "",
      "Safety:",
      "  Dry-run never mutates. --execute removes only what the same policy showed.",
      "  Ambiguity always preserves data; symlinks are never followed.",
      "",
    ].join("\n"),
  })
  @CommandAccess({ kind: "mutate", resource: "storage", action: "cleanup", risk: "destructive" })
  @CliOnly()
  @Returns(storageCleanupReturnSchema)
  cleanup(
    @Option({ flags: "--tier <tier>", description: "Policy preset: routine | weekly" }) tier?: string,
    @Option({
      flags: "--execute",
      description: "Actually remove eligible candidates; without it the command is a side-effect-free dry-run",
    })
    execute?: boolean,
    @Option({ flags: "--json", description: "Print one machine-readable result" }) asJson?: boolean,
  ) {
    if (tier !== "routine" && tier !== "weekly") {
      contractFail(OP, "USAGE_ERROR", tier ? `Invalid --tier "${tier}".` : "Missing required option --tier.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: {
          acceptedValues: [...STORAGE_TIERS],
          suggestedAction: "Re-run with --tier routine or --tier weekly",
        },
      });
    }

    let result: StorageCleanupResult;
    try {
      result = runStorageCleanup({ tier, execute: execute === true });
    } catch (error) {
      if (error instanceof StorageLockedError) {
        contractFail(OP, "STORAGE_LOCKED", "Another storage cleanup run is in progress.", {
          asJson,
          exitCode: CONTRACT_EXIT_ERROR,
          details: {
            retryable: true,
            suggestedAction: "Wait for the active run to finish and retry",
          },
        });
      }
      throw error;
    }

    if (asJson) {
      console.log(JSON.stringify(result));
    } else {
      printHumanSummary(result);
    }
    if (!result.success) process.exitCode = 1;
    return result;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function printHumanSummary(result: StorageCleanupResult): void {
  console.log(`storage cleanup (${result.tier}) — ${result.dryRun ? "dry-run" : "execute"}`);
  console.log(`policy: v${result.policyVersion} (${result.policyHash.slice(0, 12)})`);
  console.log(
    `before: ${formatBytes(result.bytesBefore)} | after: ${formatBytes(result.bytesAfter)} | freed: ${formatBytes(result.freedBytes)}`,
  );
  for (const [area, summary] of Object.entries(result.areas)) {
    console.log(
      `  ${area}: candidates=${summary.candidates} removed=${summary.removed} preserved=${summary.preserved}`,
    );
  }
  if (result.removed.length > 0) console.log(`removed: ${result.removed.join(", ")}`);
  for (const limitation of result.limitations) console.log(`limitation: ${limitation}`);
  for (const error of result.errors) console.error(`error: ${error}`);
  console.log(`receipt: ${result.receiptPath}`);
}
