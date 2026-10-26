/**
 * Tests for the storage-v2 classes and operations.
 *
 * Covers the four host classes added by the brief (superseded backups, aged
 * instance attachments, aged Claude transcripts, status@broadcast videos) plus
 * `report`, `summary`, `--notify` and `schedule`.
 *
 * Every filesystem case runs inside a throwaway fixture through
 * `RAVI_STORAGE_FIXTURE_MODE=1`; no test reads or writes real host state. The
 * adversarial cases pin the fail-closed rule: anything the policy cannot prove
 * is preserved and counted as "in doubt".
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStorageCleanup } from "./cleanup.js";
import { backupTypeKey, scanBackupsArea } from "./backups.js";
import { isAttachmentName, scanAttachmentsArea } from "./attachments.js";
import { scanClaudeJsonlArea } from "./claude-jsonl.js";
import { scanOmniBroadcastArea } from "./omni-broadcast.js";
import { loadOmniBroadcastMedia, readOmniDatabaseUrl, staticOmniProbe } from "./omni-probe.js";
import { buildStorageReport } from "./report.js";
import { buildStorageSummary, parseStorageSince } from "./summary.js";
import { formatStorageNotify, deliverStorageNotify } from "./notify.js";
import {
  applyStorageSchedule,
  canonicalScheduleInput,
  planStorageSchedule,
  type StorageScheduleStore,
} from "./schedule.js";
import {
  STORAGE_CLASSES,
  STORAGE_CLASS_TIER,
  STORAGE_POLICY_VERSION,
  STORAGE_SCHEDULE_CRON,
  STORAGE_SCHEDULE_NAME,
  STORAGE_SCHEDULE_NOTIFY_SESSION,
  STORAGE_SCHEDULE_TIMEZONE,
  resolveStoragePolicy,
} from "./policy.js";
import type { CronJob, CronJobInput } from "../cron/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const AGE_100D_MS = 100 * DAY_MS;
const AGE_10D_MS = 10 * DAY_MS;

const roots: string[] = [];

interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "storage-v2-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RAVI_STORAGE_FIXTURE_MODE: "1",
    RAVI_STORAGE_FIXTURE_RECEIPT_DIR: join(root, "receipts"),
  };
  return { root, env };
}

function dir(base: string, ...segments: string[]): string {
  const path = join(base, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

function file(path: string, bytes: number, ageMs: number, content?: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content ?? "x".repeat(bytes));
  if (ageMs > 0) {
    const stamp = new Date(Date.now() - ageMs);
    utimesSync(path, stamp, stamp);
  }
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage policy v2", () => {
  it("declares the four new host classes, all in the weekly tier", () => {
    expect(STORAGE_POLICY_VERSION).toBe("2");
    for (const id of ["backups-superseded", "instance-attachments", "claude-jsonl", "omni-broadcast-mp4"] as const) {
      expect(STORAGE_CLASSES).toContain(id);
      expect(STORAGE_CLASS_TIER[id]).toBe("weekly");
    }
  });
});

describe("backups-superseded", () => {
  it("groups entries by artifact type, ignoring the trailing timestamp", () => {
    expect(backupTypeKey("state-20260101T000000Z.db")).toBe("state.db");
    expect(backupTypeKey("state-20260102T101500Z.db")).toBe("state.db");
    expect(backupTypeKey("notes-2026-01-01.tar.gz")).toBe(null);
    expect(backupTypeKey("readme.md")).toBe(null);
  });

  it("keeps only the newest backup of each type", () => {
    const fx = fixture();
    const backups = dir(fx.root, "backups");
    fx.env.RAVI_STORAGE_FIXTURE_BACKUPS_DIR = backups;
    const old = file(join(backups, "state-20260101T000000Z.db"), 100, AGE_100D_MS);
    const newest = file(join(backups, "state-20260102T000000Z.db"), 200, AGE_10D_MS);
    const other = file(join(backups, "config-20260101T000000Z.json"), 50, AGE_100D_MS);

    const policy = resolveStoragePolicy("weekly", fx.env);
    const scan = scanBackupsArea(policy, Date.now());
    const byPath = new Map(scan.entries.map((entry) => [entry.path, entry]));

    expect(byPath.get(old)?.decision).toBe("candidate");
    expect(byPath.get(newest)?.decision).toBe("preserved");
    expect(byPath.get(other)?.decision).toBe("preserved");
  });

  it("preserves unrecognizable names as in-doubt instead of guessing", () => {
    const fx = fixture();
    const backups = dir(fx.root, "backups");
    fx.env.RAVI_STORAGE_FIXTURE_BACKUPS_DIR = backups;
    const unknown = file(join(backups, "mystery.db"), 10, AGE_100D_MS);

    const scan = scanBackupsArea(resolveStoragePolicy("weekly", fx.env), Date.now());
    const entry = scan.entries.find((candidate) => candidate.path === unknown);
    expect(entry?.decision).toBe("preserved");
    expect(entry?.doubt).toBe(true);
  });

  it("never follows a symlinked backup", () => {
    const fx = fixture();
    const backups = dir(fx.root, "backups");
    fx.env.RAVI_STORAGE_FIXTURE_BACKUPS_DIR = backups;
    const outside = file(join(fx.root, "outside.db"), 10, AGE_100D_MS);
    const link = join(backups, "state-20260101T000000Z.db");
    symlinkSync(outside, link);

    const scan = scanBackupsArea(resolveStoragePolicy("weekly", fx.env), Date.now());
    const entry = scan.entries.find((candidate) => candidate.path === link);
    expect(entry?.decision).toBe("preserved");
    expect(entry?.reason).toBe("symlink not followed");
  });

  it("removes the superseded copy on --execute and keeps the newest", () => {
    const fx = fixture();
    const backups = dir(fx.root, "backups");
    fx.env.RAVI_STORAGE_FIXTURE_BACKUPS_DIR = backups;
    const old = file(join(backups, "state-20260101T000000Z.db"), 100, AGE_100D_MS);
    const newest = file(join(backups, "state-20260102T000000Z.db"), 200, AGE_10D_MS);

    const result = runStorageCleanup({
      tier: "weekly",
      execute: true,
      env: fx.env,
      omniBroadcastProbe: staticOmniProbe({ rows: [] }),
    });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.classes["backups-superseded"]?.removed).toBe(1);
  });
});

describe("instance-attachments", () => {
  it("accepts only the saved-attachment name shape", () => {
    expect(isAttachmentName("1792625764127-ACBAF328EF0C142A0DAF19B99852E534.ogg")).toBe(true);
    expect(isAttachmentName("notes.ogg")).toBe(false);
    expect(isAttachmentName("1792625764127-../escape.ogg")).toBe(false);
    expect(isAttachmentName("1792625764127-AAAAAAAA.png.exe")).toBe(false);
  });

  it("marks only attachments older than 90 days as candidates", () => {
    const fx = fixture();
    const attachments = dir(fx.root, "attachments");
    fx.env.RAVI_STORAGE_FIXTURE_ATTACHMENTS_DIR = attachments;
    const aged = file(join(attachments, "1792625764127-ACBAF328EF0C142A.ogg"), 12, AGE_100D_MS);
    const young = file(join(attachments, "1792625881924-ACA75D89561AC77E.ogg"), 12, AGE_10D_MS);
    const odd = file(join(attachments, "leftover.bin"), 12, AGE_100D_MS);
    const nested = dir(attachments, "sub");

    const scan = scanAttachmentsArea(resolveStoragePolicy("weekly", fx.env), Date.now());
    const byPath = new Map(scan.entries.map((entry) => [entry.path, entry]));

    expect(byPath.get(aged)?.decision).toBe("candidate");
    expect(byPath.get(young)?.decision).toBe("preserved");
    expect(byPath.get(odd)?.decision).toBe("preserved");
    expect(byPath.get(odd)?.doubt).toBe(true);
    // A nested directory is outside the flat attachment surface entirely.
    expect(byPath.has(nested)).toBe(false);
  });

  it("removes the aged attachment on --execute, nothing else", () => {
    const fx = fixture();
    const attachments = dir(fx.root, "attachments");
    fx.env.RAVI_STORAGE_FIXTURE_ATTACHMENTS_DIR = attachments;
    const aged = file(join(attachments, "1792625764127-ACBAF328EF0C142A.ogg"), 12, AGE_100D_MS);
    const young = file(join(attachments, "1792625881924-ACA75D89561AC77E.ogg"), 12, AGE_10D_MS);
    const odd = file(join(attachments, "leftover.bin"), 12, AGE_100D_MS);

    const result = runStorageCleanup({
      tier: "weekly",
      execute: true,
      env: fx.env,
      omniBroadcastProbe: staticOmniProbe({ rows: [] }),
    });

    expect(existsSync(aged)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(odd)).toBe(true);
    expect(result.classes["instance-attachments"]?.removed).toBe(1);
    expect(result.classes["instance-attachments"]?.inDoubtBytes).toBe(12);
  });
});

describe("claude-jsonl", () => {
  it("candidates aged transcripts and never touches */memory/*", () => {
    const fx = fixture();
    const projects = dir(fx.root, "claude-projects");
    fx.env.RAVI_STORAGE_FIXTURE_CLAUDE_DIR = projects;
    const aged = file(join(projects, "proj-a", "session-1.jsonl"), 40, AGE_100D_MS);
    const young = file(join(projects, "proj-a", "session-2.jsonl"), 40, AGE_10D_MS);
    const memory = file(join(projects, "proj-a", "memory", "session-3.jsonl"), 40, AGE_100D_MS);
    const notJsonl = file(join(projects, "proj-a", "session-4.txt"), 40, AGE_100D_MS);

    const scan = scanClaudeJsonlArea(resolveStoragePolicy("weekly", fx.env), Date.now());
    const byPath = new Map(scan.entries.map((entry) => [entry.path, entry]));

    expect(byPath.get(aged)?.decision).toBe("candidate");
    expect(byPath.get(young)?.decision).toBe("preserved");
    expect(byPath.get(memory)?.decision).toBe("preserved");
    expect(byPath.get(memory)?.reason).toBe("never delete */memory/*");
    expect(byPath.has(notJsonl)).toBe(false);
  });

  it("keeps memory transcripts even when the rest of the tree is removed", () => {
    const fx = fixture();
    const projects = dir(fx.root, "claude-projects");
    fx.env.RAVI_STORAGE_FIXTURE_CLAUDE_DIR = projects;
    const aged = file(join(projects, "proj-a", "session-1.jsonl"), 40, AGE_100D_MS);
    const memory = file(join(projects, "proj-a", "memory", "session-3.jsonl"), 40, AGE_100D_MS);

    const result = runStorageCleanup({
      tier: "weekly",
      execute: true,
      env: fx.env,
      omniBroadcastProbe: staticOmniProbe({ rows: [] }),
    });

    expect(existsSync(aged)).toBe(false);
    expect(existsSync(memory)).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("omni-broadcast-mp4", () => {
  function mediaFixture() {
    const fx = fixture();
    const media = dir(fx.root, "omni-media", "status");
    fx.env.RAVI_STORAGE_FIXTURE_OMNI_MEDIA_DIR = join(fx.root, "omni-media");
    return { fx, media };
  }

  it("candidates only a file positively matched to a status@broadcast externalId", () => {
    const { fx, media } = mediaFixture();
    const matched = file(join(media, "abc123.mp4"), 30, AGE_10D_MS);
    const probe = staticOmniProbe({
      rows: [{ externalId: "abc123", localPath: "status/abc123.mp4", postedAt: Date.now() - AGE_10D_MS }],
    });

    const scan = scanOmniBroadcastArea(resolveStoragePolicy("weekly", fx.env), Date.now(), probe);
    const entry = scan.entries.find((candidate) => candidate.path === matched);
    expect(entry?.decision).toBe("candidate");
  });

  it("preserves as in-doubt when no row matches the file", () => {
    const { fx, media } = mediaFixture();
    const unmatched = file(join(media, "orphan.mp4"), 30, AGE_10D_MS);

    const scan = scanOmniBroadcastArea(
      resolveStoragePolicy("weekly", fx.env),
      Date.now(),
      staticOmniProbe({ rows: [] }),
    );
    const entry = scan.entries.find((candidate) => candidate.path === unmatched);
    expect(entry?.decision).toBe("preserved");
    expect(entry?.doubt).toBe(true);
  });

  it("preserves as in-doubt when the externalId differs from the file name", () => {
    const { fx, media } = mediaFixture();
    const mismatched = file(join(media, "abc123.mp4"), 30, AGE_10D_MS);
    const probe = staticOmniProbe({
      rows: [{ externalId: "zzz999", localPath: "status/abc123.mp4", postedAt: Date.now() - AGE_10D_MS }],
    });

    const scan = scanOmniBroadcastArea(resolveStoragePolicy("weekly", fx.env), Date.now(), probe);
    const entry = scan.entries.find((candidate) => candidate.path === mismatched);
    expect(entry?.decision).toBe("preserved");
    expect(entry?.doubt).toBe(true);
  });

  it("preserves every video when the Omni source is unavailable", () => {
    const { fx, media } = mediaFixture();
    const video = file(join(media, "abc123.mp4"), 30, AGE_10D_MS);

    const scan = scanOmniBroadcastArea(
      resolveStoragePolicy("weekly", fx.env),
      Date.now(),
      staticOmniProbe({ rows: [], error: "database unreachable" }),
    );

    expect(scan.entries.every((entry) => entry.decision === "preserved" && entry.doubt === true)).toBe(true);
    expect(scan.entries.map((entry) => entry.path)).toContain(video);
    expect(scan.limitations.join(" ")).toContain("unavailable");
  });

  it("preserves a matched video younger than 7 days", () => {
    const { fx, media } = mediaFixture();
    const young = file(join(media, "abc123.mp4"), 30, DAY_MS);
    const probe = staticOmniProbe({
      rows: [{ externalId: "abc123", localPath: "status/abc123.mp4", postedAt: Date.now() - DAY_MS }],
    });

    const scan = scanOmniBroadcastArea(resolveStoragePolicy("weekly", fx.env), Date.now(), probe);
    const entry = scan.entries.find((candidate) => candidate.path === young);
    expect(entry?.decision).toBe("preserved");
    expect(entry?.doubt).toBeUndefined();
  });

  it("removes a matched aged video on --execute and preserves the unmatched one", () => {
    const { fx, media } = mediaFixture();
    const matched = file(join(media, "abc123.mp4"), 30, AGE_10D_MS);
    const unmatched = file(join(media, "orphan.mp4"), 30, AGE_10D_MS);
    const probe = staticOmniProbe({
      rows: [{ externalId: "abc123", localPath: "status/abc123.mp4", postedAt: Date.now() - AGE_10D_MS }],
    });

    const result = runStorageCleanup({ tier: "weekly", execute: true, env: fx.env, omniBroadcastProbe: probe });

    expect(existsSync(matched)).toBe(false);
    expect(existsSync(unmatched)).toBe(true);
    expect(result.classes["omni-broadcast-mp4"]?.removed).toBe(1);
    expect(result.errors).toEqual([]);
  });
});

describe("omni probe fixtures", () => {
  it("reads rows from the fixture JSON and skips malformed rows", async () => {
    const fx = fixture();
    const path = join(fx.root, "omni-rows.json");
    writeFileSync(
      path,
      JSON.stringify([
        { external_id: "abc", media_local_path: "./status/abc.mp4", platform_timestamp: "2026-01-01T00:00:00Z" },
        { external_id: "", media_local_path: "x.mp4", platform_timestamp: 1 },
        { external_id: "no-stamp", media_local_path: "y.mp4" },
      ]),
    );
    fx.env.RAVI_STORAGE_FIXTURE_OMNI_DB_JSON = path;

    const result = await loadOmniBroadcastMedia(resolveStoragePolicy("weekly", fx.env), fx.env);
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.externalId).toBe("abc");
    expect(result.rows[0]?.localPath).toBe("status/abc.mp4");
  });

  it("returns an error instead of throwing when the fixture is missing", async () => {
    const fx = fixture();
    fx.env.RAVI_STORAGE_FIXTURE_OMNI_DB_JSON = join(fx.root, "absent.json");
    const result = await loadOmniBroadcastMedia(resolveStoragePolicy("weekly", fx.env), fx.env);
    expect(result.rows).toEqual([]);
    expect(result.error).toContain("not found");
  });

  it("reads the database URL only from the canonical config shape", () => {
    const fx = fixture();
    const good = join(fx.root, "config.json");
    writeFileSync(good, JSON.stringify({ server: { databaseUrl: "postgres://omni" } }));
    expect(readOmniDatabaseUrl(good)).toBe("postgres://omni");
    writeFileSync(good, "{not json");
    expect(readOmniDatabaseUrl(good)).toBe(null);
    expect(readOmniDatabaseUrl(null)).toBe(null);
  });
});

describe("storage report", () => {
  it("accounts every class and writes nothing", () => {
    const fx = fixture();
    const backups = dir(fx.root, "backups");
    const attachments = dir(fx.root, "attachments");
    const claude = dir(fx.root, "claude");
    const omni = dir(fx.root, "omni", "status");
    fx.env.RAVI_STORAGE_FIXTURE_BACKUPS_DIR = backups;
    fx.env.RAVI_STORAGE_FIXTURE_ATTACHMENTS_DIR = attachments;
    fx.env.RAVI_STORAGE_FIXTURE_CLAUDE_DIR = claude;
    fx.env.RAVI_STORAGE_FIXTURE_OMNI_MEDIA_DIR = join(fx.root, "omni");

    file(join(backups, "state-20260101T000000Z.db"), 100, AGE_100D_MS);
    file(join(backups, "state-20260102T000000Z.db"), 200, AGE_10D_MS);
    file(join(attachments, "1792625764127-ACBAF328EF0C142A.ogg"), 12, AGE_100D_MS);
    file(join(claude, "proj", "memory", "m.jsonl"), 7, AGE_100D_MS);
    file(join(omni, "status", "orphan.mp4"), 30, AGE_10D_MS);

    const policy = resolveStoragePolicy("weekly", fx.env);
    const report = buildStorageReport(policy, {
      now: Date.now(),
      omniBroadcastProbe: staticOmniProbe({ rows: [] }),
      disk: null,
    });

    expect(report.classes).toHaveLength(STORAGE_CLASSES.length);
    expect(report.classes.map((entry) => entry.id).sort()).toEqual([...STORAGE_CLASSES].sort());
    expect(report.totals.eligibleBytes).toBe(100 + 12);
    expect(report.totals.inDoubtBytes).toBe(30);
    expect(report.classes.find((entry) => entry.id === "claude-jsonl")?.eligibleBytes).toBe(0);
    // Read-only: no receipt, no lock, no directory created by the report.
    expect(existsSync(fx.env.RAVI_STORAGE_FIXTURE_RECEIPT_DIR!)).toBe(false);
  });
});

describe("storage summary", () => {
  function receipt(options: {
    id: string;
    createdAt: string;
    freedBytes: number;
    classes?: Record<string, { freedBytes: number; runs?: number }>;
    dryRun?: boolean;
  }): Record<string, unknown> {
    const classes: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(options.classes ?? { "tmp-ravi": { freedBytes: options.freedBytes } })) {
      classes[id] = {
        candidates: 1,
        removed: 1,
        preserved: 0,
        eligibleBytes: entry.freedBytes,
        inDoubtBytes: 0,
        preservedBytes: 0,
        freedBytes: entry.freedBytes,
      };
    }
    return {
      schema: "ravi.storage.receipt/v2",
      id: options.id,
      createdAt: options.createdAt,
      tier: "weekly",
      dryRun: options.dryRun ?? false,
      policyVersion: "2",
      policyHash: "0".repeat(64),
      freedBytes: options.freedBytes,
      classes,
      disk: { before: null, after: null },
      errors: [],
      limitations: [],
      removed: [],
      preservedSample: [],
    };
  }

  it("parses bounded windows and rejects everything else", () => {
    expect(parseStorageSince("7d")).toEqual({ ms: 7 * DAY_MS, normalized: "7d" });
    expect(parseStorageSince("24h")).toEqual({ ms: DAY_MS, normalized: "24h" });
    for (const value of ["", "7", "0d", "-7d", "7x", "7 days", "1.5d"]) {
      expect(parseStorageSince(value)).toBe(null);
    }
  });

  it("aggregates only receipts inside the window, per class", () => {
    const fx = fixture();
    const receipts = dir(fx.root, "receipts");
    const now = Date.now();
    writeFileSync(
      join(receipts, "a.json"),
      JSON.stringify(
        receipt({
          id: "a",
          createdAt: new Date(now - DAY_MS).toISOString(),
          freedBytes: 100,
          classes: { "tmp-ravi": { freedBytes: 100 }, "claude-jsonl": { freedBytes: 0 } },
        }),
      ),
    );
    writeFileSync(
      join(receipts, "b.json"),
      JSON.stringify(
        receipt({
          id: "b",
          createdAt: new Date(now - 2 * DAY_MS).toISOString(),
          freedBytes: 50,
          classes: { "tmp-ravi": { freedBytes: 50 } },
        }),
      ),
    );
    writeFileSync(
      join(receipts, "old.json"),
      JSON.stringify(receipt({ id: "old", createdAt: new Date(now - 30 * DAY_MS).toISOString(), freedBytes: 999 })),
    );

    const summary = buildStorageSummary({ receiptDir: receipts, sinceMs: 7 * DAY_MS, since: "7d", now, disk: null });

    expect(summary.success).toBe(true);
    expect(summary.runs).toBe(2);
    expect(summary.executedRuns).toBe(2);
    expect(summary.freedBytes).toBe(150);
    expect(summary.classes["tmp-ravi"]).toEqual({ freedBytes: 150, runs: 2 });
    expect(summary.classes["claude-jsonl"]).toEqual({ freedBytes: 0, runs: 1 });
    expect(summary.invalidReceipts).toEqual([]);
  });

  it("reports a malformed receipt instead of silently dropping it", () => {
    const fx = fixture();
    const receipts = dir(fx.root, "receipts");
    writeFileSync(join(receipts, "broken.json"), "{not json");

    const summary = buildStorageSummary({
      receiptDir: receipts,
      sinceMs: 7 * DAY_MS,
      since: "7d",
      now: Date.now(),
      disk: null,
    });

    expect(summary.success).toBe(false);
    expect(summary.invalidReceipts).toEqual([join(receipts, "broken.json")]);
  });
});

describe("storage notify", () => {
  it("formats GB freed per class plus disk percent", () => {
    const message = formatStorageNotify({
      success: true,
      op: "storage summary",
      generatedAt: new Date(0).toISOString(),
      since: "7d",
      sinceMs: 7 * DAY_MS,
      windowStart: new Date(0).toISOString(),
      runs: 2,
      executedRuns: 1,
      freedBytes: 3 * 1024 ** 3,
      classes: {
        "tmp-ravi": { freedBytes: 2 * 1024 ** 3, runs: 1 },
        "claude-jsonl": { freedBytes: 1024 ** 3, runs: 1 },
      },
      disk: { root: "/", totalBytes: 100, usedBytes: 91, availableBytes: 9, usedPercent: 91 },
      receiptDir: "/receipts",
      invalidReceipts: [],
    });

    expect(message).toContain("3.00 GB liberados na semana");
    expect(message).toContain("claude-jsonl 1.00 GB");
    expect(message).toContain("tmp-ravi 2.00 GB");
    expect(message).toContain("disco 91% usado");
  });

  it("writes to the fixture sink instead of NATS in fixture mode", async () => {
    const fx = fixture();
    const out = join(fx.root, "notify.jsonl");
    fx.env.RAVI_STORAGE_FIXTURE_NOTIFY_OUT = out;

    const result = await deliverStorageNotify("session-x", "hello", fx.env);

    expect(result.delivered).toBe(true);
    expect(readFileSync(out, "utf8")).toContain('"target":"session-x"');
  });

  it("reports a delivery failure instead of throwing", async () => {
    const fx = fixture();
    fx.env.RAVI_STORAGE_FIXTURE_NOTIFY_OUT = join(fx.root, "missing-dir", "notify.jsonl");
    const result = await deliverStorageNotify("session-x", "hello", fx.env);
    expect(result.delivered).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("storage schedule", () => {
  function makeStore(): StorageScheduleStore & { jobs: CronJob[]; created: CronJobInput[] } {
    const jobs: CronJob[] = [];
    const created: CronJobInput[] = [];
    return {
      jobs,
      created,
      list: () => jobs,
      create(input) {
        created.push(input);
        const now = Date.now();
        const job: CronJob = {
          id: `job-${jobs.length + 1}`,
          name: input.name,
          description: input.description,
          enabled: input.enabled !== false,
          deleteAfterRun: input.deleteAfterRun === true,
          schedule: input.schedule,
          sessionTarget: input.sessionTarget ?? "main",
          executionType: input.executionType ?? "agent",
          message: input.message,
          shellCommand: input.shellCommand,
          shellTimeoutMs: input.shellTimeoutMs,
          onError: input.onError,
          createdAt: now,
          updatedAt: now,
        };
        jobs.push(job);
        return job;
      },
      update(id, patch) {
        const job = jobs.find((candidate) => candidate.id === id);
        if (!job) throw new Error("missing job");
        Object.assign(job, patch, { updatedAt: Date.now() });
        return job;
      },
    };
  }

  it("pins the canonical weekly cron and notify session", () => {
    const input = canonicalScheduleInput();
    expect(input.name).toBe(STORAGE_SCHEDULE_NAME);
    expect(input.schedule).toEqual({ type: "cron", cron: STORAGE_SCHEDULE_CRON, timezone: STORAGE_SCHEDULE_TIMEZONE });
    expect(input.shellCommand).toContain(`--notify ${STORAGE_SCHEDULE_NOTIFY_SESSION}`);
    expect(input.shellCommand).toContain("--tier weekly --execute");
    expect(input.executionType).toBe("shell");
    expect(input.deleteAfterRun).toBe(false);
  });

  it("creates once and is idempotent afterwards", () => {
    const store = makeStore();
    expect(planStorageSchedule(store).action).toBe("create");

    const first = applyStorageSchedule(store);
    expect(first.action).toBe("create");
    expect(store.jobs).toHaveLength(1);

    const second = applyStorageSchedule(store);
    expect(second.action).toBe("unchanged");
    expect(second.changed).toBe(false);
    expect(store.jobs).toHaveLength(1);
  });

  it("corrects drift on an existing job instead of duplicating it", () => {
    const store = makeStore();
    applyStorageSchedule(store);
    const job = store.jobs[0]!;
    job.schedule = { type: "cron", cron: "0 9 * * 1", timezone: "UTC" };
    job.shellCommand = "ravi storage cleanup --tier routine";

    const plan = planStorageSchedule(store);
    expect(plan.action).toBe("update");
    expect(plan.jobId).toBe(job.id);
    expect(plan.changes).toContain("schedule");
    expect(plan.changes).toContain("shellCommand");

    const applied = applyStorageSchedule(store, plan);
    expect(applied.action).toBe("update");
    expect(store.jobs).toHaveLength(1);
    expect(planStorageSchedule(store).action).toBe("unchanged");
  });

  it("reports duplicate jobs but never deletes them", () => {
    const store = makeStore();
    applyStorageSchedule(store);
    const duplicate = store.create(canonicalScheduleInput());

    const plan = planStorageSchedule(store);
    expect(plan.action).toBe("unchanged");
    expect(plan.duplicates).toEqual([duplicate.id]);
    expect(store.jobs).toHaveLength(2);
  });
});
