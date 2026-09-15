/**
 * Domain-level tests for the storage package (no CLI spawn).
 *
 * Covers the pure safety helpers: policy seams, allowlist matching, realpath
 * containment, bounded measurement, the incremental Codex metadata parser and
 * the task terminal helpers.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContainedIn, measureBytes, parseCodexSessionId } from "./eligibility.js";
import {
  computeStoragePolicyHash,
  isStorageFixtureMode,
  resolveStoragePolicy,
  tmpNameMatchesAllowlist,
} from "./policy.js";
import { isTerminalTask, taskTerminalStamp, type TaskWorktreeRecord } from "./task-probe.js";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "storage-domain-"));
  roots.push(root);
  return root;
}
process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("storage policy domain", () => {
  it("produces a stable content hash", () => {
    expect(computeStoragePolicyHash()).toBe(computeStoragePolicyHash());
    expect(computeStoragePolicyHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores fixture seams outside fixture mode", () => {
    const env = {
      RAVI_STATE_DIR: "/tmp/ravi-domain-state",
      RAVI_STORAGE_FIXTURE_TMP_ROOTS: "/tmp/evil",
      RAVI_STORAGE_FIXTURE_RECEIPT_DIR: "/tmp/evil-receipts",
      RAVI_STORAGE_FIXTURE_CODEX_DIR: "/tmp/evil-codex",
    };
    const policy = resolveStoragePolicy("routine", env);
    expect(policy.fixtureMode).toBe(false);
    expect(policy.tmpRoots).not.toContain("/tmp/evil");
    expect(policy.receiptDir).not.toBe("/tmp/evil-receipts");
    expect(policy.codexSessionsDir).not.toBe("/tmp/evil-codex");
  });

  it("honors fixture seams only when RAVI_STORAGE_FIXTURE_MODE=1", () => {
    const env = {
      RAVI_STORAGE_FIXTURE_MODE: "1",
      RAVI_STORAGE_FIXTURE_TMP_ROOTS: "/tmp/a:/tmp/b",
      RAVI_STORAGE_FIXTURE_RECEIPT_DIR: "/tmp/receipts",
      RAVI_STORAGE_FIXTURE_CODEX_DIR: "/tmp/codex",
    };
    expect(isStorageFixtureMode(env)).toBe(true);
    const policy = resolveStoragePolicy("routine", env);
    expect(policy.tmpRoots).toEqual(["/tmp/a", "/tmp/b"]);
    expect(policy.receiptDir).toBe("/tmp/receipts");
    expect(policy.codexSessionsDir).toBe("/tmp/codex");
  });

  it("matches the allowlist as a closed set", () => {
    expect(tmpNameMatchesAllowlist("ravi-abc", ["ravi-*"])).toBe(true);
    expect(tmpNameMatchesAllowlist("ravi-a.b", ["ravi-a.b"])).toBe(true);
    expect(tmpNameMatchesAllowlist("ravi-axb", ["ravi-a.b"])).toBe(false);
    expect(tmpNameMatchesAllowlist("unrelated", ["ravi-*"])).toBe(false);
  });
});

describe("containment and measurement", () => {
  it("accepts a child inside the root and rejects traversal", () => {
    const root = fixture();
    const inside = join(root, "tmp");
    const child = join(inside, "candidate");
    const outside = join(root, "outside");
    mkdirSync(child, { recursive: true });
    mkdirSync(outside, { recursive: true });
    expect(isContainedIn(child, inside)).toBe(true);
    expect(isContainedIn(outside, inside)).toBe(false);
  });

  it("rejects a symlink whose real target escapes the root", () => {
    const root = fixture();
    const inside = join(root, "tmp");
    const outside = join(root, "outside");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const link = join(inside, "escape");
    symlinkSync(outside, link);
    expect(isContainedIn(link, inside)).toBe(false);
  });

  it("measures a tree without following symlinks", () => {
    const root = fixture();
    writeFileSync(join(root, "file.bin"), "x".repeat(100));
    const outside = fixture();
    writeFileSync(join(outside, "big.bin"), "y".repeat(10_000));
    symlinkSync(outside, join(root, "link"));
    expect(measureBytes(root)).toBe(100);
  });
});

describe("codex metadata parser", () => {
  it("reads a session id from a first line larger than one read chunk", () => {
    const dir = fixture();
    const file = join(dir, "rollout-long.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { session_id: "01abc", pad: "z".repeat(200_000) } })}\n{"type":"other"}\n`,
    );
    expect(parseCodexSessionId(file)).toBe("01abc");
  });

  it("returns null for missing or non-meta first lines", () => {
    const dir = fixture();
    const bad = join(dir, "rollout-bad.jsonl");
    writeFileSync(bad, `${JSON.stringify({ type: "not_meta" })}\n`);
    expect(parseCodexSessionId(bad)).toBeNull();
    expect(parseCodexSessionId(join(dir, "missing.jsonl"))).toBeNull();
  });
});

describe("task terminal helpers", () => {
  const base: TaskWorktreeRecord = {
    taskId: "t",
    status: "done",
    taskDir: null,
    worktreePath: "/tmp/wt",
    worktreeBranch: "b",
    updatedAt: 1,
    completedAt: 2,
    archivedAt: null,
  };

  it("classifies terminal and active tasks", () => {
    expect(isTerminalTask(base)).toBe(true);
    expect(isTerminalTask({ ...base, status: "in_progress", completedAt: null })).toBe(false);
    expect(isTerminalTask({ ...base, status: "in_progress", completedAt: null, archivedAt: 5 })).toBe(true);
  });

  it("prefers completed over archived over updated stamps", () => {
    expect(taskTerminalStamp(base)).toBe(2);
    expect(taskTerminalStamp({ ...base, completedAt: null })).toBe(1);
    expect(taskTerminalStamp({ ...base, completedAt: null, archivedAt: 3 })).toBe(3);
  });
});
