/**
 * Shared provisioning helpers for the automatic memory curation rollout.
 *
 * Called both by `ravi memory enroll` (bulk seed) and by `ravi agents create`
 * (auto-enroll on new agent). Idempotent — safe to run before/after any
 * enrolment step without duplicating filesystem state.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AgentMemoryPaths {
  cwd: string;
  memoryPath: string;
  memoryDir: string;
}

export interface ProvisionAgentMemoryResult {
  memoryFileCreated: boolean;
  memoryDirCreated: boolean;
  memoryPath: string;
  memoryDir: string;
}

export interface PurgeAgentMemoryResult {
  memoryFileDeleted: boolean;
  memoryDirDeleted: boolean;
  topicFilesRemoved: number;
}

export function agentMemoryPaths(agentCwd: string): AgentMemoryPaths {
  return {
    cwd: agentCwd,
    memoryPath: join(agentCwd, "MEMORY.md"),
    memoryDir: join(agentCwd, "memory"),
  };
}

/**
 * Ensure the cold-start MEMORY.md file + memory/ dir exist for an agent.
 *
 * The seed carries the current agent id in the header so R6 injection
 * downstream reads coherent. Re-running does not overwrite an existing file.
 */
export function provisionAgentMemory(agentId: string, agentCwd: string): ProvisionAgentMemoryResult {
  const paths = agentMemoryPaths(agentCwd);
  const memoryFileCreated = ensureMemoryFile(paths.memoryPath, agentId);
  const memoryDirCreated = ensureDir(paths.memoryDir);
  return {
    memoryFileCreated,
    memoryDirCreated,
    memoryPath: paths.memoryPath,
    memoryDir: paths.memoryDir,
  };
}

/**
 * Delete the MEMORY.md file and every topic file under memory/ for an agent.
 *
 * Reserved for `ravi agents delete --purge-memory`. NEVER call this from an
 * automated flow — R7 forbids destructive memory operations without human
 * intent.
 */
export function purgeAgentMemory(agentCwd: string): PurgeAgentMemoryResult {
  const paths = agentMemoryPaths(agentCwd);
  let memoryFileDeleted = false;
  let memoryDirDeleted = false;
  let topicFilesRemoved = 0;

  if (existsSync(paths.memoryPath)) {
    unlinkSync(paths.memoryPath);
    memoryFileDeleted = true;
  }

  if (existsSync(paths.memoryDir)) {
    // m9: rmSync(recursive) clears the whole tree — count first, then a single
    // recursive unlink instead of per-file unlinkSync + rmSync (double I/O).
    topicFilesRemoved = readdirSync(paths.memoryDir, { withFileTypes: true }).filter((e) => e.isFile()).length;
    rmSync(paths.memoryDir, { recursive: true, force: true });
    memoryDirDeleted = true;
  }

  return { memoryFileDeleted, memoryDirDeleted, topicFilesRemoved };
}

function ensureMemoryFile(memoryPath: string, agentId: string): boolean {
  if (existsSync(memoryPath)) return false;
  const parent = dirname(memoryPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const seed = `# ${agentId} — auto-memory\n\n## Diário\n\n`;
  writeFileSync(memoryPath, seed, "utf-8");
  return true;
}

function ensureDir(dirPath: string): boolean {
  if (existsSync(dirPath)) return false;
  mkdirSync(dirPath, { recursive: true });
  return true;
}
