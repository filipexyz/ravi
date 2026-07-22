import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentMemoryPaths, provisionAgentMemory, purgeAgentMemory } from "./enroll.js";

describe("provisionAgentMemory (R26 cold-start seed)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ravi-enroll-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds MEMORY.md with the agent id in the header + creates memory/ dir on first run", () => {
    const result = provisionAgentMemory("ravi-dev", dir);
    expect(result.memoryFileCreated).toBe(true);
    expect(result.memoryDirCreated).toBe(true);
    expect(readFileSync(result.memoryPath, "utf-8")).toBe("# ravi-dev — auto-memory\n\n## Diário\n\n");
    expect(existsSync(result.memoryDir)).toBe(true);
  });

  it("re-run is idempotent — pre-existing MEMORY.md and memory/ are left untouched", () => {
    const paths = agentMemoryPaths(dir);
    mkdirSync(paths.memoryDir, { recursive: true });
    writeFileSync(paths.memoryPath, "existing curated content\n", "utf-8");
    const result = provisionAgentMemory("ravi-dev", dir);
    expect(result.memoryFileCreated).toBe(false);
    expect(result.memoryDirCreated).toBe(false);
    expect(readFileSync(paths.memoryPath, "utf-8")).toBe("existing curated content\n");
  });
});

describe("purgeAgentMemory (destructive opt-in for agents delete --purge-memory)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ravi-purge-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes MEMORY.md + every topic file + the memory/ dir", () => {
    const paths = agentMemoryPaths(dir);
    mkdirSync(paths.memoryDir, { recursive: true });
    writeFileSync(paths.memoryPath, "index\n", "utf-8");
    writeFileSync(join(paths.memoryDir, "topic-a.md"), "a\n", "utf-8");
    writeFileSync(join(paths.memoryDir, "topic-b.md"), "b\n", "utf-8");
    const result = purgeAgentMemory(dir);
    expect(result.memoryFileDeleted).toBe(true);
    expect(result.memoryDirDeleted).toBe(true);
    expect(result.topicFilesRemoved).toBe(2);
    expect(existsSync(paths.memoryPath)).toBe(false);
    expect(existsSync(paths.memoryDir)).toBe(false);
  });

  it("returns zero counts on an agent that never had memory provisioned (no throw)", () => {
    const result = purgeAgentMemory(dir);
    expect(result).toEqual({ memoryFileDeleted: false, memoryDirDeleted: false, topicFilesRemoved: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });
});
