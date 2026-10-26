/**
 * Focused contract tests for `ravi storage cleanup`.
 *
 * Every test runs against a throwaway fixture via `RAVI_STORAGE_FIXTURE_MODE=1`
 * and never touches real host state. The CLI-level cases spawn the real binary
 * with the host gateway disabled so the fixture path is exercised locally.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canRemove, StorageLockedError, runStorageCleanup } from "../../storage/cleanup.js";
import type { CodexProbe, StorageEntry } from "../../storage/eligibility.js";
import { computeStoragePolicyHash, resolveStoragePolicy, tmpNameMatchesAllowlist } from "../../storage/policy.js";
import { createRaviTaskProbe } from "../../storage/task-worktrees.js";
import type { TaskProbe, TaskWorktreeAssessment, TaskWorktreeRecord } from "../../storage/task-probe.js";
import { withoutRaviRuntimeContextEnv } from "../../test/ravi-state.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const AGE_30D_MS = 30 * ONE_DAY_MS;

const fixtures: string[] = [];

function makeFixture(options: { codex?: boolean } = {}): {
  root: string;
  tmpRoot: string;
  receiptDir: string;
  outside: string;
  codexDir: string;
  env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "storage-test-"));
  fixtures.push(root);
  const tmpRoot = join(root, "tmp");
  const receiptDir = join(root, "receipts");
  const outside = join(root, "outside");
  const codexDir = join(root, "codex-sessions");
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(receiptDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...withoutRaviRuntimeContextEnv(),
    RAVI_HOST_CLI_GATEWAY: "0",
    RAVI_STATE_DIR: join(root, "state"),
    RAVI_SUPPRESS_AUDIT_EVENTS: "1",
    RAVI_STORAGE_FIXTURE_MODE: "1",
    RAVI_STORAGE_FIXTURE_TMP_ROOTS: tmpRoot,
    RAVI_STORAGE_FIXTURE_RECEIPT_DIR: receiptDir,
  };
  // The suite must exercise the operator's real local CLI path even when the
  // test runner itself inherited a runtime context (e.g. from a session turn).
  // A context key would route every spawned command through the gateway and
  // the CLI-only guard, which is a different contract than the one under test.
  delete env.RAVI_CONTEXT_KEY;
  delete env.RAVI_SESSION_KEY;
  delete env.RAVI_SESSION_NAME;
  // Every spawn gets its own empty state dir: no test may migrate or lock the
  // operator's live ~/.ravi/ravi.db.
  mkdirSync(env.RAVI_STATE_DIR!, { recursive: true });
  if (options.codex) {
    mkdirSync(codexDir, { recursive: true });
    env.RAVI_STORAGE_FIXTURE_CODEX_DIR = codexDir;
  }
  return { root, tmpRoot, receiptDir, outside, codexDir, env };
}

function writeRollout(
  dir: string,
  name: string,
  sessionId: string,
  ageMs: number,
  originator: string | null = "ravi",
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const payload: Record<string, unknown> = { session_id: sessionId };
  if (originator !== null) payload.originator = originator;
  writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload })}\n`);
  const stamp = new Date(Date.now() - ageMs);
  utimesSync(file, stamp, stamp);
  return file;
}

function makeDir(path: string, ageMs?: number): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "blob.bin"), "x".repeat(1024));
  if (ageMs !== undefined) {
    const stamp = new Date(Date.now() - ageMs);
    utimesSync(path, stamp, stamp);
  }
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage policy", () => {
  it("has a stable content hash", () => {
    const first = computeStoragePolicyHash();
    expect(first).toBe(computeStoragePolicyHash());
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses a closed allowlist match", () => {
    expect(tmpNameMatchesAllowlist("ravi-foo", ["ravi-*"])).toBe(true);
    expect(tmpNameMatchesAllowlist("ravi-foo", ["observation-plane*"])).toBe(false);
    expect(tmpNameMatchesAllowlist("unrelated", ["ravi-*"])).toBe(false);
    // regex metacharacters in a name never turn into a wildcard
    expect(tmpNameMatchesAllowlist("ravi-a.b", ["ravi-a.b"])).toBe(true);
    expect(tmpNameMatchesAllowlist("ravi-axb", ["ravi-a.b"])).toBe(false);
  });
});

describe("storage cleanup dry-run", () => {
  it("reports candidates without mutating anything", () => {
    const fx = makeFixture();
    makeDir(join(fx.tmpRoot, "ravi-eligible"), AGE_30D_MS);
    makeDir(join(fx.tmpRoot, "ravi-recent"), 0);

    const before = readdirSync(fx.tmpRoot).sort();
    const result = runStorageCleanup({ tier: "routine", env: fx.env });

    expect(result.dryRun).toBe(true);
    expect(result.wouldFreeBytes).toBeGreaterThan(0);
    // A dry-run frees nothing: `summary` must never count it as released space.
    expect(result.freedBytes).toBe(0);
    expect(result.classes["tmp-ravi"]?.candidates).toBe(1);
    expect(result.classes["tmp-ravi"]?.freedBytes).toBe(0);
    expect(result.removed).toEqual([]);
    expect(readdirSync(fx.tmpRoot).sort()).toEqual(before);
    expect(result.receiptId).toBeTruthy();
    expect(existsSync(result.receiptPath)).toBe(true);
  });

  it("preserves young entries", () => {
    const fx = makeFixture();
    makeDir(join(fx.tmpRoot, "ravi-recent"), 0);
    const result = runStorageCleanup({ tier: "routine", env: fx.env });
    expect(result.classes["tmp-ravi"]?.candidates).toBe(0);
    expect(result.preserved).toContain(join(fx.tmpRoot, "ravi-recent"));
  });
});

describe("storage cleanup execute", () => {
  it("removes exactly the eligible set and preserves recent entries and symlink targets", () => {
    const fx = makeFixture();
    makeDir(join(fx.tmpRoot, "ravi-eligible"), AGE_30D_MS);
    makeDir(join(fx.tmpRoot, "ravi-recent"), 0);
    const escape = join(fx.tmpRoot, "ravi-symlink");
    symlinkSync(fx.outside, escape);

    const result = runStorageCleanup({ tier: "routine", execute: true, env: fx.env });

    expect(result.dryRun).toBe(false);
    expect(existsSync(join(fx.tmpRoot, "ravi-eligible"))).toBe(false);
    expect(existsSync(join(fx.tmpRoot, "ravi-recent"))).toBe(true);
    expect(existsSync(fx.outside)).toBe(true);
    // the symlink itself is preserved, never followed
    expect(result.preserved).toContain(escape);
    expect(result.errors).toEqual([]);
  });

  it("fails closed while another run holds the lock", () => {
    const fx = makeFixture();
    makeDir(join(fx.tmpRoot, "ravi-eligible"), AGE_30D_MS);
    writeFileSync(join(fx.receiptDir, ".cleanup.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    expect(() => runStorageCleanup({ tier: "routine", execute: true, env: fx.env })).toThrow(StorageLockedError);
    expect(existsSync(join(fx.tmpRoot, "ravi-eligible"))).toBe(true);
  });

  it("writes receipts and never prunes the in-flight receipt", () => {
    const fx = makeFixture();
    makeDir(join(fx.tmpRoot, "ravi-eligible"), AGE_30D_MS);
    const result = runStorageCleanup({ tier: "routine", execute: true, env: fx.env, now: Date.now() });
    expect(existsSync(result.receiptPath)).toBe(true);
    const receipts = readdirSync(fx.receiptDir).filter((name) => name.endsWith(".json"));
    expect(receipts).toContain(`${result.receiptId}.json`);
  });
});

describe("storage cleanup CLI usage", () => {
  const run = (args: string[]) => {
    const fx = makeFixture();
    return {
      fx,
      result: spawnSync("bun", ["src/cli/index.ts", "storage", "cleanup", ...args], {
        cwd: join(import.meta.dir, "..", "..", ".."),
        env: fx.env,
        encoding: "utf8",
        timeout: 30_000,
      }),
    };
  };

  // Spawning the real binary is CPU-bound and competes with the rest of the
  // suite, so these cases need a budget larger than bun's 5s default.
  const SPAWN_BUDGET_MS = 120_000;

  it(
    "exits 2 without --tier",
    () => {
      const { result } = run(["--json"]);
      expect(result.status).toBe(2);
    },
    SPAWN_BUDGET_MS,
  );

  it(
    "exits 2 for an unknown tier",
    () => {
      const { result } = run(["--tier", "bogus", "--json"]);
      expect(result.status).toBe(2);
    },
    SPAWN_BUDGET_MS,
  );

  it(
    "exits 0 for a dry-run and prints one JSON line",
    () => {
      const { result } = run(["--tier", "routine", "--json"]);
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim().split("\n").pop()!);
      expect(payload.dryRun).toBe(true);
    },
    SPAWN_BUDGET_MS,
  );
});

const NOT_LIVE: CodexProbe = { processRunning: () => false, sessionLiveness: () => "not-live" };
const LIVE: CodexProbe = { processRunning: () => false, sessionLiveness: () => "live" };
const UNKNOWN: CodexProbe = { processRunning: () => false, sessionLiveness: () => "unknown" };
const RUNNING: CodexProbe = { processRunning: () => true, sessionLiveness: () => "not-live" };

describe("storage cleanup codex-inactive", () => {
  it("removes an aged rollout only when liveness proves not-live", () => {
    const fx = makeFixture({ codex: true });
    const file = writeRollout(fx.codexDir, "rollout-2026-01-01T00-00-00-fixed.jsonl", "codex-1", AGE_30D_MS);

    const dry = runStorageCleanup({ tier: "routine", env: fx.env, codexProbe: NOT_LIVE });
    expect(dry.classes["codex-inactive"]?.candidates).toBe(1);

    const executed = runStorageCleanup({ tier: "routine", execute: true, env: fx.env, codexProbe: NOT_LIVE });
    expect(existsSync(file)).toBe(false);
    expect(executed.errors).toEqual([]);
  });

  it("preserves a rollout referenced by a live Ravi session", () => {
    const fx = makeFixture({ codex: true });
    const file = writeRollout(fx.codexDir, "rollout-live.jsonl", "codex-live", AGE_30D_MS);
    const result = runStorageCleanup({ tier: "routine", execute: true, env: fx.env, codexProbe: LIVE });
    expect(existsSync(file)).toBe(true);
    expect(result.classes["codex-inactive"]?.candidates).toBe(0);
  });

  it("preserves a rollout when liveness is unknown and records the limitation", () => {
    const fx = makeFixture({ codex: true });
    const file = writeRollout(fx.codexDir, "rollout-unknown.jsonl", "codex-unknown", AGE_30D_MS);
    const result = runStorageCleanup({ tier: "routine", execute: true, env: fx.env, codexProbe: UNKNOWN });
    expect(existsSync(file)).toBe(true);
    expect(result.limitations.join(" ")).toContain("liveness");
  });

  it("preserves every rollout while a codex process is running", () => {
    const fx = makeFixture({ codex: true });
    const file = writeRollout(fx.codexDir, "rollout-process.jsonl", "codex-process", AGE_30D_MS);
    const result = runStorageCleanup({ tier: "routine", execute: true, env: fx.env, codexProbe: RUNNING });
    expect(existsSync(file)).toBe(true);
    expect(result.preserved).toContain(file);
  });

  it("preserves young and metadata-less rollouts", () => {
    const fx = makeFixture({ codex: true });
    const young = writeRollout(fx.codexDir, "rollout-young.jsonl", "codex-young", 1000);
    const bad = join(fx.codexDir, "rollout-bad.jsonl");
    writeFileSync(bad, `${JSON.stringify({ type: "not_meta" })}\n`);
    utimesSync(bad, new Date(Date.now() - AGE_30D_MS), new Date(Date.now() - AGE_30D_MS));

    const result = runStorageCleanup({ tier: "routine", execute: true, env: fx.env, codexProbe: NOT_LIVE });
    expect(existsSync(young)).toBe(true);
    expect(existsSync(bad)).toBe(true);
    expect(result.classes["codex-inactive"]?.candidates).toBe(0);
  });

  it("re-verifies liveness at removal time and preserves on a late live answer", () => {
    const fx = makeFixture({ codex: true });
    const file = writeRollout(fx.codexDir, "rollout-race.jsonl", "codex-race", AGE_30D_MS);
    let scans = 0;
    const flaky: CodexProbe = {
      processRunning: () => false,
      sessionLiveness: () => {
        scans += 1;
        return scans === 1 ? "not-live" : "live";
      },
    };
    const result = runStorageCleanup({ tier: "routine", execute: true, env: fx.env, codexProbe: flaky });
    expect(existsSync(file)).toBe(true);
    // A deterministic preservation is reported as `blocked`, not as a failure.
    expect(result.blocked.join(" ")).toContain("liveness");
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("requires a Ravi ownership mark, not just liveness", () => {
    const fx = makeFixture({ codex: true });
    const owned = writeRollout(fx.codexDir, "rollout-owned.jsonl", "codex-owned", AGE_30D_MS, "ravi");
    const foreign = writeRollout(fx.codexDir, "rollout-foreign.jsonl", "codex-foreign", AGE_30D_MS, "codex_exec");
    const legacy = writeRollout(fx.codexDir, "rollout-legacy.jsonl", "codex-legacy", AGE_30D_MS, null);
    const corrupt = join(fx.codexDir, "rollout-corrupt.jsonl");
    writeFileSync(corrupt, "{not json\n");
    utimesSync(corrupt, new Date(Date.now() - AGE_30D_MS), new Date(Date.now() - AGE_30D_MS));

    const result = runStorageCleanup({ tier: "routine", execute: true, env: fx.env, codexProbe: NOT_LIVE });

    expect(existsSync(owned)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(corrupt)).toBe(true);
    expect(result.classes["codex-inactive"]?.candidates).toBe(1);
    expect(result.classes["codex-inactive"]?.removed).toBe(1);
    expect(result.removed).toEqual([owned]);
    // Each preserved rollout is visible in the preserved record, and the
    // foreign/legacy ones are counted as in doubt (not silently dropped).
    expect(result.preserved).toContain(foreign);
    expect(result.preserved).toContain(legacy);
    expect(result.classes["codex-inactive"]?.inDoubtBytes).toBeGreaterThan(0);
  });
});

function taskRecord(worktreePath: string, overrides: Partial<TaskWorktreeRecord> = {}): TaskWorktreeRecord {
  const stamp = Date.now() - AGE_30D_MS;
  return {
    taskId: "task-x",
    status: "done",
    taskDir: null,
    worktreePath,
    worktreeBranch: "task-branch",
    updatedAt: stamp,
    completedAt: stamp,
    archivedAt: null,
    ...overrides,
  };
}

function fakeTaskProbe(
  record: TaskWorktreeRecord,
  assessment: TaskWorktreeAssessment,
  removeResult: { ok: true } | { ok: false; error: string } = { ok: true },
): { probe: TaskProbe; calls: { removed: number } } {
  const calls = { removed: 0 };
  return {
    calls,
    probe: {
      listWorktreeTasks: () => ({ records: [record] }),
      assess: () => assessment,
      remove: () => {
        calls.removed += 1;
        return removeResult;
      },
    },
  };
}

const CANDIDATE: TaskWorktreeAssessment = { decision: "candidate", reason: "safe" };
const PRESERVED: TaskWorktreeAssessment = { decision: "preserved", reason: "dirty worktree" };

describe("storage cleanup tasks-terminal", () => {
  it("removes a terminal, aged, safe worktree through the probe", () => {
    const fx = makeFixture();
    const path = join(fx.root, "tasks", "wt");
    mkdirSync(path, { recursive: true });
    const { probe, calls } = fakeTaskProbe(taskRecord(path), CANDIDATE);
    const result = runStorageCleanup({ tier: "weekly", execute: true, env: fx.env, taskProbe: probe });
    expect(calls.removed).toBe(1);
    expect(result.removed).toContain(path);
    expect(result.errors).toEqual([]);
  });

  it("preserves non-terminal and young tasks", () => {
    const fx = makeFixture();
    const path = join(fx.root, "tasks", "wt");
    const active = fakeTaskProbe(taskRecord(path, { status: "in_progress", completedAt: null }), CANDIDATE);
    const activeResult = runStorageCleanup({ tier: "weekly", execute: true, env: fx.env, taskProbe: active.probe });
    expect(activeResult.classes["tasks-terminal"]?.candidates).toBe(0);
    expect(active.calls.removed).toBe(0);

    const young = fakeTaskProbe(taskRecord(path, { completedAt: Date.now() }), CANDIDATE);
    const youngResult = runStorageCleanup({ tier: "weekly", execute: true, env: fx.env, taskProbe: young.probe });
    expect(youngResult.classes["tasks-terminal"]?.candidates).toBe(0);
    expect(young.calls.removed).toBe(0);
  });

  it("preserves a worktree the probe refuses (dirty/stashed/unpushed)", () => {
    const fx = makeFixture();
    const path = join(fx.root, "tasks", "wt");
    const { probe, calls } = fakeTaskProbe(taskRecord(path), PRESERVED);
    const result = runStorageCleanup({ tier: "weekly", execute: true, env: fx.env, taskProbe: probe });
    expect(calls.removed).toBe(0);
    expect(result.classes["tasks-terminal"]?.preserved).toBe(1);
  });

  it("reports a removal failure without masking it", () => {
    const fx = makeFixture();
    const path = join(fx.root, "tasks", "wt");
    mkdirSync(path, { recursive: true });
    const { probe } = fakeTaskProbe(taskRecord(path), CANDIDATE, { ok: false, error: "git refused" });
    const result = runStorageCleanup({ tier: "weekly", execute: true, env: fx.env, taskProbe: probe });
    expect(result.success).toBe(false);
    expect(result.errors.join(" ")).toContain("git refused");
  });

  it("preserves everything when no task source is available", () => {
    const fx = makeFixture();
    const result = runStorageCleanup({ tier: "weekly", execute: true, env: fx.env });
    expect(result.removed).toEqual([]);
    expect(result.limitations.join(" ")).toContain("tasks-terminal");
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeGitFixture(): { root: string; repo: string; worktree: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "storage-git-"));
  fixtures.push(root);
  const tasksRoot = join(root, "tasks");
  const repo = join(root, "repo");
  const worktree = join(tasksRoot, "wt");
  mkdirSync(repo, { recursive: true });
  mkdirSync(tasksRoot, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Storage Test"]);
  writeFileSync(join(repo, "file.txt"), "hello\n");
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["worktree", "add", "-q", worktree, "-b", "task-branch"]);
  return { root, repo, worktree, env: { ...process.env, RAVI_STATE_DIR: root } };
}

function pushWorktree(fx: { root: string; repo: string; worktree: string }): void {
  const remote = join(fx.root, "remote.git");
  git(fx.root, ["init", "-q", "--bare", remote]);
  git(fx.repo, ["remote", "add", "origin", remote]);
  git(fx.worktree, ["push", "-q", "-u", "origin", "task-branch"]);
}

describe("task worktree Git safety proof", () => {
  it("preserves a worktree with no upstream (unpushed risk)", () => {
    const fx = makeGitFixture();
    const probe = createRaviTaskProbe(fx.env);
    const assessment = probe.assess(taskRecord(fx.worktree));
    expect(assessment.decision).toBe("preserved");
    expect(assessment.reason).toContain("upstream");
  });

  it("accepts a clean, fully pushed secondary worktree", () => {
    const fx = makeGitFixture();
    pushWorktree(fx);
    const probe = createRaviTaskProbe(fx.env);
    expect(probe.assess(taskRecord(fx.worktree)).decision).toBe("candidate");
  });

  it("preserves dirty and stashed worktrees", () => {
    const fx = makeGitFixture();
    pushWorktree(fx);
    const probe = createRaviTaskProbe(fx.env);
    writeFileSync(join(fx.worktree, "file.txt"), "changed\n");
    expect(probe.assess(taskRecord(fx.worktree)).reason).toContain("dirty");
    git(fx.worktree, ["stash"]);
    expect(probe.assess(taskRecord(fx.worktree)).reason).toContain("stash");
  });

  it("preserves a worktree with unpushed commits", () => {
    const fx = makeGitFixture();
    pushWorktree(fx);
    writeFileSync(join(fx.worktree, "extra.txt"), "more\n");
    git(fx.worktree, ["add", "extra.txt"]);
    git(fx.worktree, ["commit", "-q", "-m", "wip"]);
    const probe = createRaviTaskProbe(fx.env);
    expect(probe.assess(taskRecord(fx.worktree)).reason).toContain("unpushed");
  });

  it("removes the worktree through git worktree remove", () => {
    const fx = makeGitFixture();
    pushWorktree(fx);
    const probe = createRaviTaskProbe(fx.env);
    const outcome = probe.remove(taskRecord(fx.worktree));
    expect(outcome.ok).toBe(true);
    expect(existsSync(fx.worktree)).toBe(false);
  });
});

/**
 * Protected roots in the real host shape. `~/.codex/sessions` lives inside the
 * protected `~/.codex` and `~/.ravi/tasks` inside the protected `~/.ravi`; the
 * execute gate must still be able to remove its own allowlisted candidates
 * there, while keeping every other protected path protected.
 */
function makeProtectedFixture(): {
  root: string;
  home: string;
  codexDir: string;
  tasksDir: string;
  tmpRoot: string;
  env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "storage-protected-"));
  fixtures.push(root);
  const home = join(root, "home");
  const stateDir = join(home, ".ravi");
  const codexDir = join(home, ".codex", "sessions");
  const tasksDir = join(stateDir, "tasks");
  const tmpRoot = join(root, "tmp");
  const receiptDir = join(stateDir, "storage", "receipts");
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(receiptDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...withoutRaviRuntimeContextEnv(),
    RAVI_HOST_CLI_GATEWAY: "0",
    RAVI_STATE_DIR: stateDir,
    RAVI_SUPPRESS_AUDIT_EVENTS: "1",
    RAVI_STORAGE_FIXTURE_MODE: "1",
    RAVI_STORAGE_FIXTURE_TMP_ROOTS: tmpRoot,
    RAVI_STORAGE_FIXTURE_RECEIPT_DIR: receiptDir,
    RAVI_STORAGE_FIXTURE_CODEX_DIR: codexDir,
    RAVI_STORAGE_FIXTURE_PROTECTED_ROOTS: [
      stateDir,
      join(home, ".config", "ravi"),
      join(home, ".pi"),
      join(home, ".codex"),
      join(home, ".omni"),
    ].join(":"),
  };
  return { root, home, codexDir, tasksDir, tmpRoot, env };
}

describe("execute gate under the real protected roots", () => {
  it("dry-run candidates are exactly the set the execute can remove", () => {
    const fx = makeProtectedFixture();
    const rollout = writeRollout(fx.codexDir, "rollout-owned.jsonl", "codex-owned", AGE_30D_MS, "ravi");
    const tmpDir = join(fx.tmpRoot, "ravi-eligible");
    makeDir(tmpDir, AGE_30D_MS);

    const dry = runStorageCleanup({ tier: "routine", env: fx.env, codexProbe: NOT_LIVE });
    const candidates = dry.classes["codex-inactive"]?.candidates ?? 0;
    expect(candidates).toBe(1);
    expect(dry.wouldFreeBytes).toBeGreaterThan(0);

    const executed = runStorageCleanup({ tier: "routine", execute: true, env: fx.env, codexProbe: NOT_LIVE });

    expect(existsSync(rollout)).toBe(false);
    expect(existsSync(tmpDir)).toBe(false);
    // SPEC invariant 6: the dry-run eligible set equals the removed set.
    expect(executed.removed.sort()).toEqual([rollout, tmpDir].sort());
    // No candidate may be promoted to "protected path" after being counted.
    expect(executed.blocked.filter((line) => line.includes("protected path"))).toEqual([]);
    expect(executed.errors).toEqual([]);
    expect(executed.success).toBe(true);
  });

  it("keeps other protected paths protected", () => {
    const fx = makeProtectedFixture();
    const policy = resolveStoragePolicy("routine", fx.env);
    const evil = join(fx.home, ".ravi", "ravi-evil");
    mkdirSync(evil, { recursive: true });
    const entry: StorageEntry = {
      area: "tmp-ravi",
      root: fx.tmpRoot,
      path: evil,
      bytes: 0,
      decision: "candidate",
      reason: "crafted",
    };
    expect(canRemove(entry, policy, Date.now(), {})).toBe("protected path");
  });
});

describe("execute gate re-checks age and the lock", () => {
  it("preserves a transcript whose mtime was refreshed after the scan", () => {
    const fx = makeFixture();
    const claudeDir = join(fx.root, "claude-projects");
    fx.env.RAVI_STORAGE_FIXTURE_CLAUDE_DIR = claudeDir;
    const transcript = join(claudeDir, "proj", "session.jsonl");
    mkdirSync(join(claudeDir, "proj"), { recursive: true });
    writeFileSync(transcript, "{}");
    const old = new Date(Date.now() - AGE_30D_MS);
    utimesSync(transcript, old, old);

    const policy = resolveStoragePolicy("weekly", fx.env);
    const entry: StorageEntry = {
      area: "claude-jsonl",
      root: claudeDir,
      path: transcript,
      bytes: 2,
      decision: "candidate",
      reason: "aged transcript",
    };
    // The file is touched between scan and removal (e.g. a resumed session).
    const fresh = new Date();
    utimesSync(transcript, fresh, fresh);

    const reason = canRemove(entry, policy, Date.now(), {});
    expect(reason).toContain("younger than the threshold");
  });

  it("never steals a lock that was just created and is still empty", () => {
    const fx = makeFixture();
    makeDir(join(fx.tmpRoot, "ravi-eligible"), AGE_30D_MS);
    const lockPath = join(fx.receiptDir, ".cleanup.lock");
    writeFileSync(lockPath, "");

    expect(() => runStorageCleanup({ tier: "routine", execute: true, env: fx.env })).toThrow(StorageLockedError);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(fx.tmpRoot, "ravi-eligible"))).toBe(true);
  });

  it("takes over an unreadable lock only when it is old enough", () => {
    const fx = makeFixture();
    const dir = join(fx.tmpRoot, "ravi-eligible");
    makeDir(dir, AGE_30D_MS);
    const lockPath = join(fx.receiptDir, ".cleanup.lock");
    writeFileSync(lockPath, "");
    const stale = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockPath, stale, stale);

    const result = runStorageCleanup({ tier: "routine", execute: true, env: fx.env });
    expect(result.removed).toContain(dir);
    expect(existsSync(lockPath)).toBe(false);
  });
});
