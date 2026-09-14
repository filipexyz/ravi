/**
 * Focused contract tests for `ravi storage cleanup`.
 *
 * Every test runs against a throwaway fixture via `RAVI_STORAGE_FIXTURE_MODE=1`
 * and never touches real host state. The CLI-level cases spawn the real binary
 * with the host gateway disabled so the fixture path is exercised locally.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
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
import { StorageLockedError, runStorageCleanup } from "../../storage/cleanup.js";
import { computeStoragePolicyHash, tmpNameMatchesAllowlist } from "../../storage/policy.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const AGE_30D_MS = 30 * ONE_DAY_MS;

const fixtures: string[] = [];

function makeFixture(): { root: string; tmpRoot: string; receiptDir: string; outside: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "storage-test-"));
  fixtures.push(root);
  const tmpRoot = join(root, "tmp");
  const receiptDir = join(root, "receipts");
  const outside = join(root, "outside");
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(receiptDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return {
    root,
    tmpRoot,
    receiptDir,
    outside,
    env: {
      ...process.env,
      RAVI_HOST_CLI_GATEWAY: "0",
      RAVI_STORAGE_FIXTURE_MODE: "1",
      RAVI_STORAGE_FIXTURE_TMP_ROOTS: tmpRoot,
      RAVI_STORAGE_FIXTURE_RECEIPT_DIR: receiptDir,
    },
  };
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
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(result.areas["tmp-ravi"]?.candidates).toBe(1);
    expect(result.removed).toEqual([]);
    expect(readdirSync(fx.tmpRoot).sort()).toEqual(before);
    expect(result.receiptId).toBeTruthy();
    expect(existsSync(result.receiptPath)).toBe(true);
  });

  it("preserves young entries", () => {
    const fx = makeFixture();
    makeDir(join(fx.tmpRoot, "ravi-recent"), 0);
    const result = runStorageCleanup({ tier: "routine", env: fx.env });
    expect(result.areas["tmp-ravi"]?.candidates).toBe(0);
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

  it("exits 2 without --tier", () => {
    const { result } = run(["--json"]);
    expect(result.status).toBe(2);
  });

  it("exits 2 for an unknown tier", () => {
    const { result } = run(["--tier", "bogus", "--json"]);
    expect(result.status).toBe(2);
  });

  it("exits 0 for a dry-run and prints one JSON line", () => {
    const { result } = run(["--tier", "routine", "--json"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop()!);
    expect(payload.dryRun).toBe(true);
  });
});
