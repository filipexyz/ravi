import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pm2Process } from "./pm2.js";
import {
  observeRuntimeBoot,
  readRuntimeBootReceipt,
  runtimeBootBundlePath,
  writeRuntimeBootReceipt,
  type RuntimeBootReceipt,
} from "./runtime-process-identity.js";

const START = 1_800_000_000_000;

function fixture() {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-boot-identity-")));
  const bundlePath = join(stateDir, "dist", "bundle", "index.js");
  const envFile = join(stateDir, ".env");
  mkdirSync(join(stateDir, "dist", "bundle"), { recursive: true });
  writeFileSync(bundlePath, "// code loaded at boot\n");
  writeFileSync(envFile, "PRIVATE_FIXTURE_KEY=secret-that-must-not-enter-a-receipt\n");
  const process: Pm2Process = {
    name: "ravi-channels",
    pid: 123,
    pm_id: 2,
    status: "online",
    cpu: 0,
    memory: 0,
    createdAt: START - 86_400_000,
    startedAt: START,
  };
  const receipt: RuntimeBootReceipt = {
    ...observeRuntimeBoot({ bundlePath, envFile, runningVersion: "3.1.0", now: START + 100 }),
    schemaVersion: 1,
    name: "ravi-channels",
    pid: process.pid,
    startedAt: START,
  };
  const receiptPath = join(stateDir, "runtime-processes", "ravi-channels.json");
  return { stateDir, bundlePath, envFile, process, receipt, receiptPath };
}

describe("runtime boot bundle path", () => {
  it("uses the loaded bundle URL even when PM2 argv names its process container", () => {
    const bundle = "/opt/ravi/dist/bundle/index.js";
    expect(runtimeBootBundlePath(pathToFileURL(bundle).href, ["/usr/bin/bun", "/pm2/ProcessContainer.js"])).toBe(
      bundle,
    );
  });

  it("uses the source entry point outside a bundle and falls back when argv has no entry", () => {
    const modulePath = "/checkout/src/runtime-process-identity.ts";
    const moduleUrl = pathToFileURL(modulePath).href;
    expect(runtimeBootBundlePath(moduleUrl, ["/usr/bin/bun", "/checkout/src/cli/index.ts"])).toBe(
      "/checkout/src/cli/index.ts",
    );
    expect(runtimeBootBundlePath(moduleUrl, ["/usr/bin/bun"])).toBe(modulePath);
  });
});

describe("runtime boot receipts", () => {
  it("preserves the captured version and fingerprint after disk changes without storing env contents", () => {
    const f = fixture();
    try {
      const capturedHash = f.receipt.bundle?.sha256;
      writeFileSync(f.bundlePath, "// replaced after boot\n");
      writeFileSync(join(f.stateDir, "package.json"), JSON.stringify({ name: "ravi.bot", version: "3.2.0" }));
      writeFileSync(f.envFile, "PRIVATE_FIXTURE_KEY=different-secret\n");
      writeRuntimeBootReceipt(f.receipt, f.stateDir);

      const stored = readRuntimeBootReceipt(f.process, f.stateDir);
      expect(stored?.runningVersion).toBe("3.1.0");
      expect(stored?.bundle?.sha256).toBe(capturedHash);
      expect(stored?.env).toEqual(f.receipt.env);
      expect(stored?.bundle?.sha256).not.toBe(
        observeRuntimeBoot({ bundlePath: f.bundlePath, envFile: f.envFile, runningVersion: "3.2.0" }).bundle?.sha256,
      );
      const raw = readFileSync(f.receiptPath, "utf8");
      expect(raw).not.toContain("PRIVATE_FIXTURE_KEY");
      expect(raw).not.toContain("secret-that-must-not-enter-a-receipt");
      expect(raw).not.toContain("different-secret");
      expect(statSync(f.receiptPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(f.stateDir, { recursive: true, force: true });
    }
  });

  it("binds identity to PID and process start rather than PM2 registration age", () => {
    const f = fixture();
    try {
      writeRuntimeBootReceipt(f.receipt, f.stateDir);
      expect(readRuntimeBootReceipt({ ...f.process, createdAt: START - 1 }, f.stateDir)).toEqual(f.receipt);
      expect(readRuntimeBootReceipt({ ...f.process, pid: 124 }, f.stateDir)).toBeNull();
      expect(readRuntimeBootReceipt({ ...f.process, startedAt: START + 1 }, f.stateDir)).toBeNull();
      expect(readRuntimeBootReceipt({ ...f.process, startedAt: null }, f.stateDir)).toBeNull();
      expect(readRuntimeBootReceipt({ ...f.process, pid: 0 }, f.stateDir)).toBeNull();
      expect(readRuntimeBootReceipt({ ...f.process, name: "unmanaged-process" }, f.stateDir)).toBeNull();
    } finally {
      rmSync(f.stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed on absent, malformed and mismatched receipts", () => {
    const f = fixture();
    try {
      expect(readRuntimeBootReceipt(f.process, f.stateDir)).toBeNull();
      writeRuntimeBootReceipt(f.receipt, f.stateDir);
      const invalid = [
        "{incomplete",
        "null",
        JSON.stringify({ ...f.receipt, schemaVersion: 2 }),
        JSON.stringify({ ...f.receipt, name: "ravi" }),
        JSON.stringify({ ...f.receipt, runningVersion: "" }),
        JSON.stringify({ ...f.receipt, capturedAt: START - 1 }),
        JSON.stringify({ ...f.receipt, bundle: { ...f.receipt.bundle, sha256: "not-a-hash" } }),
        JSON.stringify({ ...f.receipt, env: { mtimeMs: "not-a-time", size: 1, ino: 1 } }),
      ];
      for (const raw of invalid) {
        writeFileSync(f.receiptPath, raw);
        expect(readRuntimeBootReceipt(f.process, f.stateDir)).toBeNull();
      }
    } finally {
      rmSync(f.stateDir, { recursive: true, force: true });
    }
  });
});
