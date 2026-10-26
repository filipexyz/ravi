/**
 * `ravi storage` — native, fail-closed disk accounting and cleanup.
 *
 * Operations:
 *   cleanup  remove only unambiguous, allowlisted, aged artifacts (dry-run default)
 *   report   read-only bytes per class: eligible vs in doubt
 *   summary  read-only aggregation of the receipt ledger over a window
 *   schedule idempotently manage the single weekly cron
 *
 * The domain is host-local, so every operation is `@CliOnly` — it is
 * intentionally not part of the remote SDK/OpenAPI surface.
 *
 * Tests and the out-of-candidate checker drive the destructive path through the
 * fixture seams gated by `RAVI_STORAGE_FIXTURE_MODE=1` (see `policy.ts`).
 */

import "reflect-metadata";
import { z } from "zod";
import { CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { CONTRACT_EXIT_ERROR, CONTRACT_EXIT_USAGE, contractDryRun, contractFail } from "../agent-contract.js";
import { StorageLockedError, runStorageCleanup, type StorageCleanupResult } from "../../storage/cleanup.js";
import { createRaviCodexProbe } from "../../storage/codex-liveness.js";
import { readDiskUsage } from "../../storage/disk.js";
import { buildStorageReport } from "../../storage/report.js";
import { buildStorageSummary, parseStorageSince } from "../../storage/summary.js";
import { formatByteSize, formatGigabytes } from "../../storage/format.js";
import { deliverStorageNotify, formatStorageNotify } from "../../storage/notify.js";
import { loadOmniBroadcastMedia, staticOmniProbe } from "../../storage/omni-probe.js";
import {
  STORAGE_SCHEDULE_CRON,
  STORAGE_SCHEDULE_NAME,
  STORAGE_SCHEDULE_NOTIFY_SESSION,
  STORAGE_SCHEDULE_TIMEOUT_MS,
  STORAGE_SCHEDULE_TIMEZONE,
  STORAGE_SUMMARY_WINDOW_MS,
  STORAGE_TIERS,
  isStorageFixtureMode,
  resolveStoragePolicy,
  type StorageTier,
} from "../../storage/policy.js";
import {
  applyStorageSchedule,
  canonicalScheduleInput,
  planStorageSchedule,
  type StorageScheduleStore,
} from "../../storage/schedule.js";
import { createRaviTaskProbe } from "../../storage/task-worktrees.js";

const OP = "storage cleanup";
const _OP_REPORT = "storage report";
const OP_SUMMARY = "storage summary";
const OP_SCHEDULE = "storage schedule";

const storageClassSummarySchema = z.object({
  candidates: z.number(),
  removed: z.number(),
  preserved: z.number(),
  eligibleBytes: z.number(),
  inDoubtBytes: z.number(),
  preservedBytes: z.number(),
  freedBytes: z.number(),
});

const diskUsageSchema = z
  .object({
    root: z.string(),
    totalBytes: z.number(),
    usedBytes: z.number(),
    availableBytes: z.number(),
    usedPercent: z.number(),
  })
  .nullable();

const storageCleanupReturnSchema = z
  .object({
    success: z.boolean(),
    op: z.literal("storage cleanup"),
    tier: z.enum(["routine", "weekly"]),
    dryRun: z.boolean(),
    policyVersion: z.string(),
    policyHash: z.string(),
    freedBytes: z.number(),
    classes: z.record(z.string(), storageClassSummarySchema),
    disk: z.object({ before: diskUsageSchema, after: diskUsageSchema }),
    errors: z.array(z.string()),
    limitations: z.array(z.string()),
    removed: z.array(z.string()),
    preserved: z.array(z.string()),
    receiptId: z.string(),
    receiptPath: z.string(),
    executedAt: z.string(),
  })
  .passthrough();

const storageReportReturnSchema = z
  .object({
    success: z.boolean(),
    op: z.literal("storage report"),
    generatedAt: z.string(),
    policyVersion: z.string(),
    policyHash: z.string(),
    classes: z.array(
      z
        .object({
          id: z.string(),
          tier: z.enum(["routine", "weekly"]),
          scopeBytes: z.number(),
          eligibleBytes: z.number(),
          inDoubtBytes: z.number(),
          preservedBytes: z.number(),
          candidates: z.number(),
          preserved: z.number(),
          limitations: z.array(z.string()),
        })
        .passthrough(),
    ),
    totals: z.object({
      scopeBytes: z.number(),
      eligibleBytes: z.number(),
      inDoubtBytes: z.number(),
      preservedBytes: z.number(),
      candidates: z.number(),
      preserved: z.number(),
    }),
    disk: diskUsageSchema,
    limitations: z.array(z.string()),
  })
  .passthrough();

const storageSummaryReturnSchema = z
  .object({
    success: z.boolean(),
    op: z.literal("storage summary"),
    generatedAt: z.string(),
    since: z.string(),
    sinceMs: z.number(),
    windowStart: z.string(),
    runs: z.number(),
    executedRuns: z.number(),
    freedBytes: z.number(),
    classes: z.record(z.string(), z.object({ freedBytes: z.number(), runs: z.number() })),
    disk: diskUsageSchema,
    receiptDir: z.string(),
    invalidReceipts: z.array(z.string()),
  })
  .passthrough();

const storageScheduleReturnSchema = z
  .object({
    success: z.boolean(),
    op: z.literal("storage schedule"),
    action: z.enum(["create", "update", "unchanged"]),
    jobId: z.string(),
    changed: z.boolean(),
    cron: z.string(),
    timezone: z.string(),
    command: z.string(),
    enabled: z.boolean(),
    nextRunAt: z.string().nullable(),
  })
  .passthrough();

@Group({ name: "storage", description: "Native, fail-closed disk accounting and cleanup", scope: "open" })
export class StorageCommands {
  @Command({
    name: "cleanup",
    description: "Remove only unambiguous, allowlisted, aged disk artifacts (dry-run by default; requires --execute)",
    helpAfter: [
      "",
      "Tiers:",
      "  routine  tmp-ravi namespaces and Codex artifacts with an inactive proof",
      "  weekly   backups, instance attachments, Claude transcripts, status@broadcast",
      "           videos, orphan Omni objects and terminal task worktrees",
      "",
      "Classes (weekly):",
      "  backups-superseded     ~/.ravi/backups keeps only the newest of each type",
      "  instance-attachments   ~/ravi/main/attachments older than 90 days",
      "  claude-jsonl           ~/.claude/projects/**/*.jsonl older than 90 days",
      "                         (never */memory/*)",
      "  omni-broadcast-mp4     status@broadcast videos older than 7 days, only with",
      "                         a matched externalId (no match = preserve)",
      "",
      "Safety:",
      "  Dry-run never mutates. --execute removes only what the same policy showed.",
      "  Ambiguity always preserves data; symlinks are never followed.",
      "  --notify <session> requires --execute and reports the last 7 days.",
      "",
    ].join("\n"),
  })
  @CommandAccess({ kind: "mutate", resource: "storage", action: "cleanup", risk: "destructive" })
  @CliOnly()
  @Returns(storageCleanupReturnSchema)
  async cleanup(
    @Option({ flags: "--tier <tier>", description: "Policy preset: routine | weekly" }) tier?: string,
    @Option({
      flags: "--execute",
      description: "Actually remove eligible candidates; without it the command is a side-effect-free dry-run",
    })
    execute?: boolean,
    @Option({
      flags: "--notify <session>",
      description: "After --execute, notify a session with GB freed in the last 7 days, by class, and disk %",
    })
    notify?: string,
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

    if (notify !== undefined && notify.trim() === "") {
      contractFail(OP, "USAGE_ERROR", "Option --notify needs a session name.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: "Pass --notify <session> or omit the flag" },
      });
    }
    if (notify !== undefined && execute !== true) {
      contractFail(OP, "USAGE_ERROR", "--notify only reports freed space, so it requires --execute.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: "Re-run with --execute --notify <session> after reviewing the dry-run" },
      });
    }

    const notifyTarget = notify?.trim();
    if (notifyTarget && !isStorageFixtureMode()) {
      const { resolveSession } = await import("../../router/sessions.js");
      if (!resolveSession(notifyTarget)) {
        contractFail(OP, "USAGE_ERROR", `Session "${notifyTarget}" was not found.`, {
          asJson,
          exitCode: CONTRACT_EXIT_USAGE,
          details: { suggestedAction: "Pass the name of an existing session" },
        });
      }
    }

    const policy = resolveStoragePolicy(tier as StorageTier);
    const omniBroadcastProbe = staticOmniProbe(await loadOmniBroadcastMedia(policy));

    let result: StorageCleanupResult;
    try {
      result = runStorageCleanup({
        tier,
        execute: execute === true,
        codexProbe: createRaviCodexProbe(),
        // Fixtures never touch the real task database or real worktrees.
        taskProbe: isStorageFixtureMode() ? undefined : createRaviTaskProbe(),
        omniBroadcastProbe,
      });
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

    let notifyResult: { target: string; delivered: boolean; error?: string } | null = null;
    if (notifyTarget) {
      const sinceMs = STORAGE_SUMMARY_WINDOW_MS;
      const summary = buildStorageSummary({
        receiptDir: policy.receiptDir,
        sinceMs,
        since: "7d",
        now: Date.now(),
        disk: readDiskUsage(policy.receiptDir),
      });
      const message = formatStorageNotify(summary);
      const delivered = await deliverStorageNotify(notifyTarget, message);
      notifyResult = {
        target: notifyTarget,
        delivered: delivered.delivered,
        ...(delivered.error ? { error: delivered.error } : {}),
      };
      if (!delivered.delivered) {
        result.errors.push(`notify failed for ${notifyTarget}: ${delivered.error ?? "unknown error"}`);
        result.success = false;
      }
    }

    const payload = { ...result, notify: notifyResult };
    if (asJson) {
      console.log(JSON.stringify(payload));
    } else {
      printHumanSummary(result);
      if (notifyResult) {
        console.log(
          notifyResult.delivered
            ? `notified: ${notifyResult.target}`
            : `notify failed: ${notifyResult.target} (${notifyResult.error ?? "unknown error"})`,
        );
      }
    }
    if (!result.success) process.exitCode = 1;
    return payload;
  }

  @Command({
    name: "report",
    description: "Read-only bytes per class: eligible vs in doubt (writes nothing)",
    helpAfter: [
      "",
      "Read-only: no receipt, no lock, no directory is created.",
      "`eligible` = bytes the current policy would remove with --execute.",
      "`in doubt` = bytes preserved because a signal was unresolved (not merely young).",
      "",
    ].join("\n"),
  })
  @CommandAccess({ kind: "read", resource: "storage", action: "report", risk: "low" })
  @CliOnly()
  @Returns(storageReportReturnSchema)
  async report(@Option({ flags: "--json", description: "Print one machine-readable result" }) asJson?: boolean) {
    const policy = resolveStoragePolicy("weekly");
    const omniBroadcastProbe = staticOmniProbe(await loadOmniBroadcastMedia(policy));
    const report = buildStorageReport(policy, {
      now: Date.now(),
      codexProbe: createRaviCodexProbe(),
      taskProbe: isStorageFixtureMode() ? undefined : createRaviTaskProbe(),
      omniBroadcastProbe,
      disk: readDiskUsage(policy.receiptDir),
    });
    if (asJson) console.log(JSON.stringify(report));
    else printReport(report);
    return report;
  }

  @Command({
    name: "summary",
    description: "Read-only aggregation of receipts: freed bytes by class over a window",
  })
  @CommandAccess({ kind: "read", resource: "storage", action: "summary", risk: "low" })
  @CliOnly()
  @Returns(storageSummaryReturnSchema)
  summary(
    @Option({ flags: "--since <window>", description: "Window, e.g. 7d, 24h, 90m (default: 7d)" }) since?: string,
    @Option({ flags: "--json", description: "Print one machine-readable result" }) asJson?: boolean,
  ) {
    const parsed = since === undefined ? { ms: STORAGE_SUMMARY_WINDOW_MS, normalized: "7d" } : parseStorageSince(since);
    if (!parsed) {
      contractFail(OP_SUMMARY, "USAGE_ERROR", `Invalid --since "${since}".`, {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: {
          acceptedValues: ["7d", "24h", "90m", "1w"],
          suggestedAction: "Use a positive duration with one of ms|s|m|h|d|w, for example --since 7d",
        },
      });
    }
    const policy = resolveStoragePolicy("weekly");
    const summary = buildStorageSummary({
      receiptDir: policy.receiptDir,
      sinceMs: parsed.ms,
      since: parsed.normalized,
      now: Date.now(),
      disk: readDiskUsage(policy.receiptDir),
    });
    if (asJson) console.log(JSON.stringify(summary));
    else printSummary(summary);
    if (!summary.success) process.exitCode = 1;
    return summary;
  }

  @Command({
    name: "schedule",
    description: `Idempotently manage the weekly cron (${STORAGE_SCHEDULE_CRON} ${STORAGE_SCHEDULE_TIMEZONE}); dry-run by default`,
    helpAfter: [
      "",
      "Canonical job (fixed by policy):",
      `  name     ${STORAGE_SCHEDULE_NAME}`,
      `  schedule ${STORAGE_SCHEDULE_CRON} ${STORAGE_SCHEDULE_TIMEZONE} (Sunday 04:00)`,
      `  command  ravi storage cleanup --tier weekly --execute --notify ${STORAGE_SCHEDULE_NOTIFY_SESSION} --json`,
      "",
      "Idempotent: an existing job with this name is corrected, never duplicated.",
      "Without --execute nothing is written (exit 3).",
      "",
    ].join("\n"),
  })
  @CommandAccess({ kind: "mutate", resource: "storage", action: "schedule", risk: "medium" })
  @CliOnly()
  @Returns(storageScheduleReturnSchema)
  async schedule(
    @Option({ flags: "--execute", description: "Write the cron job; without it this is a dry-run plan" })
    execute?: boolean,
    @Option({ flags: "--json", description: "Print one machine-readable result" }) asJson?: boolean,
  ) {
    const { dbCreateCronJob, dbListCronJobs, dbUpdateCronJob } = await import("../../cron/cron-db.js");
    const store: StorageScheduleStore = {
      list: () => dbListCronJobs(),
      create: (input) => dbCreateCronJob(input),
      update: (id, patch) => dbUpdateCronJob(id, patch),
    };
    const plan = planStorageSchedule(store);
    if (execute !== true) {
      contractDryRun(
        OP_SCHEDULE,
        {
          action: plan.action,
          jobId: plan.jobId,
          changes: plan.changes,
          duplicates: plan.duplicates,
          job: canonicalScheduleInput(),
        },
        { asJson },
      );
    }

    const applied = applyStorageSchedule(store, plan);
    if (applied.changed) {
      try {
        const { nats } = await import("../../nats.js");
        await nats.emit("ravi.cron.refresh", {});
      } catch {
        // The daemon also re-arms timers on its own poll; a refresh failure must
        // not roll back a persisted job.
      }
    }
    const job = store.list().find((candidate) => candidate.id === applied.jobId);
    const payload = {
      success: true,
      op: "storage schedule" as const,
      action: applied.action,
      jobId: applied.jobId,
      changed: applied.changed,
      cron: STORAGE_SCHEDULE_CRON,
      timezone: STORAGE_SCHEDULE_TIMEZONE,
      command: canonicalScheduleInput().shellCommand ?? "",
      enabled: job?.enabled ?? true,
      nextRunAt: job?.nextRunAt ? new Date(job.nextRunAt).toISOString() : null,
    };
    if (asJson) console.log(JSON.stringify(payload));
    else {
      console.log(`storage schedule — ${applied.action} (${applied.jobId})`);
      console.log(`  cron:    ${STORAGE_SCHEDULE_CRON} ${STORAGE_SCHEDULE_TIMEZONE}`);
      console.log(`  command: ${payload.command}`);
      console.log(`  timeout: ${formatDuration(STORAGE_SCHEDULE_TIMEOUT_MS)}`);
      if (payload.nextRunAt) console.log(`  next:    ${payload.nextRunAt}`);
      if (plan.duplicates.length > 0) {
        console.log(`  warning: duplicate jobs with the same name left untouched: ${plan.duplicates.join(", ")}`);
      }
    }
    return payload;
  }
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

function printHumanSummary(result: StorageCleanupResult): void {
  console.log(`storage cleanup (${result.tier}) — ${result.dryRun ? "dry-run" : "execute"}`);
  console.log(`policy: v${result.policyVersion} (${result.policyHash.slice(0, 12)})`);
  const before = result.disk.before;
  const after = result.disk.after;
  console.log(
    `disk: ${before ? `${formatGigabytes(before.usedBytes)} used, ${before.usedPercent}%` : "unknown"} -> ` +
      `${after ? `${formatGigabytes(after.usedBytes)} used, ${after.usedPercent}%` : "unknown"}`,
  );
  console.log(`freed: ${formatByteSize(result.freedBytes)}`);
  for (const [id, summary] of Object.entries(result.classes)) {
    console.log(
      `  ${id}: eligible=${formatByteSize(summary.eligibleBytes)} removed=${summary.removed} ` +
        `in-doubt=${formatByteSize(summary.inDoubtBytes)} preserved=${summary.preserved}`,
    );
  }
  if (result.removed.length > 0) console.log(`removed: ${result.removed.join(", ")}`);
  for (const limitation of result.limitations) console.log(`limitation: ${limitation}`);
  for (const error of result.errors) console.error(`error: ${error}`);
  console.log(`receipt: ${result.receiptPath}`);
}

function printReport(report: ReturnType<typeof buildStorageReport>): void {
  console.log(`storage report — policy v${report.policyVersion} (${report.policyHash.slice(0, 12)})`);
  if (report.disk) {
    console.log(
      `disk: ${formatGigabytes(report.disk.usedBytes)} used, ${report.disk.usedPercent}% | ` +
        `${formatGigabytes(report.disk.availableBytes)} free`,
    );
  } else {
    console.log("disk: unavailable");
  }
  const rows = report.classes.map((entry) => [
    entry.id,
    entry.tier,
    formatByteSize(entry.scopeBytes),
    formatByteSize(entry.eligibleBytes),
    formatByteSize(entry.inDoubtBytes),
    String(entry.candidates),
  ]);
  const header = ["class", "tier", "scope", "eligible", "in doubt", "files"];
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
  console.log(render(header));
  for (const row of rows) console.log(render(row));
  console.log(
    render([
      "total",
      "",
      formatByteSize(report.totals.scopeBytes),
      formatByteSize(report.totals.eligibleBytes),
      formatByteSize(report.totals.inDoubtBytes),
      String(report.totals.candidates),
    ]),
  );
  for (const limitation of report.limitations) console.log(`limitation: ${limitation}`);
}

function printSummary(summary: ReturnType<typeof buildStorageSummary>): void {
  console.log(`storage summary (since ${summary.since}) — ${summary.runs} run(s), ${summary.executedRuns} executed`);
  console.log(`freed: ${formatGigabytes(summary.freedBytes)}`);
  for (const [id, entry] of Object.entries(summary.classes)) {
    console.log(`  ${id}: ${formatGigabytes(entry.freedBytes)} (${entry.runs} run(s))`);
  }
  if (summary.disk) {
    console.log(
      `disk: ${formatGigabytes(summary.disk.usedBytes)} used, ${summary.disk.usedPercent}% | ` +
        `${formatGigabytes(summary.disk.availableBytes)} free`,
    );
  }
  for (const path of summary.invalidReceipts) console.error(`invalid receipt: ${path}`);
}
