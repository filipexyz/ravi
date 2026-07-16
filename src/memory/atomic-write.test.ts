import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.js";

describe("atomicWrite (R10 atomicity + drift detect + .bak)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ravi-memory-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("R26 cold-start: writes when target does not exist and no expectedPriorContent supplied", () => {
    const target = join(dir, "MEMORY.md");
    const result = atomicWrite({
      targetPath: target,
      newContent: "# fresh memory\n",
    });
    expect(result.written).toBe(true);
    expect(result.driftDetected).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("# fresh memory\n");
  });

  it("writes atomically when expectedPriorContent matches on-disk state", () => {
    const target = join(dir, "MEMORY.md");
    writeFileSync(target, "prior", "utf-8");
    const result = atomicWrite({
      targetPath: target,
      newContent: "next",
      expectedPriorContent: "prior",
    });
    expect(result.written).toBe(true);
    expect(result.driftDetected).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("next");
  });

  it("R10 refuses + writes .bak when on-disk drifted from expectedPriorContent", () => {
    const target = join(dir, "MEMORY.md");
    writeFileSync(target, "external edit — curator did not observe this", "utf-8");
    const result = atomicWrite({
      targetPath: target,
      newContent: "curator's rewrite",
      expectedPriorContent: "what curator saw",
    });
    expect(result.written).toBe(false);
    expect(result.driftDetected).toBe(true);
    expect(result.backupPath).toBe(`${target}.bak`);
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(readFileSync(result.backupPath!, "utf-8")).toBe("external edit — curator did not observe this");
    // Target must NOT have been clobbered — original external content survives.
    expect(readFileSync(target, "utf-8")).toBe("external edit — curator did not observe this");
  });

  it("R10 refuses to clobber non-empty target when no expectedPriorContent is supplied", () => {
    const target = join(dir, "MEMORY.md");
    writeFileSync(target, "existing content", "utf-8");
    const result = atomicWrite({
      targetPath: target,
      newContent: "clobber attempt",
    });
    expect(result.written).toBe(false);
    expect(result.driftDetected).toBe(true);
    expect(result.reason).toContain("expectedPriorContent");
    // Original still intact.
    expect(readFileSync(target, "utf-8")).toBe("existing content");
  });

  it("does not leave the temp file behind on success", () => {
    const target = join(dir, "MEMORY.md");
    atomicWrite({
      targetPath: target,
      newContent: "ok",
    });
    const leftover = readdirSync(dir).filter((entry) => entry.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("m3: releases the lock file on success (no .lock left behind)", () => {
    const target = join(dir, "MEMORY.md");
    atomicWrite({ targetPath: target, newContent: "ok" });
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("m3: refuses with lockContention when a fresh lock is held (lost-update guard)", () => {
    const target = join(dir, "MEMORY.md");
    writeFileSync(target, "prior", "utf-8");
    // Simulate a concurrent writer mid-critical-section: hold the lock open.
    const heldLock = openSync(`${target}.lock`, "wx");
    try {
      const result = atomicWrite({
        targetPath: target,
        newContent: "second writer's rewrite",
        expectedPriorContent: "prior",
      });
      expect(result.written).toBe(false);
      expect(result.lockContention).toBe(true);
      expect(result.driftDetected).toBe(false);
      // The held writer's target is untouched — no lost update.
      expect(readFileSync(target, "utf-8")).toBe("prior");
    } finally {
      closeSync(heldLock);
      rmSync(`${target}.lock`, { force: true });
    }
  });
});
