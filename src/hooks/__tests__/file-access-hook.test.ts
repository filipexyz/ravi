/**
 * Tests for file access restriction in PreCompact hook
 */

import { describe, test, expect } from "bun:test";
import { resolve, join } from "node:path";

/**
 * Simulates the file access hook logic for testing
 */
function checkFileAccess(
  agentCwd: string,
  memoryPath: string,
  requestedPath: string,
): { allowed: boolean; normalizedPath: string } {
  const normalizedPath = resolve(agentCwd, requestedPath);
  return {
    allowed: normalizedPath === memoryPath,
    normalizedPath,
  };
}

describe("file access hook security", () => {
  const agentCwd = "/Users/luis/ravi/main";
  const memoryPath = join(agentCwd, "MEMORY.md");

  test("allows access to MEMORY.md with absolute path", () => {
    const result = checkFileAccess(agentCwd, memoryPath, "/Users/luis/ravi/main/MEMORY.md");
    expect(result.allowed).toBe(true);
  });

  test("allows access to MEMORY.md with relative path", () => {
    const result = checkFileAccess(agentCwd, memoryPath, "MEMORY.md");
    expect(result.allowed).toBe(true);
  });

  test("blocks access to other files in same directory", () => {
    const result = checkFileAccess(agentCwd, memoryPath, "CLAUDE.md");
    expect(result.allowed).toBe(false);
  });

  test("blocks access to files in parent directory", () => {
    const result = checkFileAccess(agentCwd, memoryPath, "../other.md");
    expect(result.allowed).toBe(false);
  });

  test("blocks path traversal attacks", () => {
    // Try to escape using ../
    const attacks = [
      "../../../etc/passwd",
      "/Users/luis/ravi/main/../../../etc/passwd",
      "MEMORY.md/../../../etc/passwd",
      "./MEMORY.md/../CLAUDE.md",
      "MEMORY.md/../../secret.txt",
    ];

    for (const attack of attacks) {
      const result = checkFileAccess(agentCwd, memoryPath, attack);
      expect(result.allowed).toBe(false);
      expect(result.normalizedPath).not.toContain("..");
    }
  });

  test("blocks absolute paths to other locations", () => {
    const result = checkFileAccess(agentCwd, memoryPath, "/etc/passwd");
    expect(result.allowed).toBe(false);
  });

  test("blocks access to other agent directories", () => {
    const result = checkFileAccess(agentCwd, memoryPath, "/Users/luis/ravi/other-agent/MEMORY.md");
    expect(result.allowed).toBe(false);
  });

  test("handles empty path", () => {
    const result = checkFileAccess(agentCwd, memoryPath, "");
    expect(result.allowed).toBe(false);
  });

  test("handles path with special characters", () => {
    const specialPaths = ["MEMORY.md%00", "MEMORY.md\x00", "MEMORY.md ", " MEMORY.md"];

    for (const path of specialPaths) {
      const result = checkFileAccess(agentCwd, memoryPath, path);
      // These should NOT match the exact memoryPath
      expect(result.normalizedPath).not.toBe(memoryPath);
    }
  });

  test("normalizes ./MEMORY.md correctly", () => {
    const result = checkFileAccess(agentCwd, memoryPath, "./MEMORY.md");
    expect(result.allowed).toBe(true);
    expect(result.normalizedPath).toBe(memoryPath);
  });

  test("handles double slashes", () => {
    const result = checkFileAccess(agentCwd, memoryPath, "//MEMORY.md");
    // Double slash at start is absolute path to root
    expect(result.allowed).toBe(false);
  });
});
