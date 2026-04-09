import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCanonicalTaskDir, getTaskDocPath, readTaskDocFrontmatter } from "./task-doc.js";

const tempStateDirs: string[] = [];

afterEach(() => {
  while (tempStateDirs.length > 0) {
    const dir = tempStateDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  delete process.env.RAVI_STATE_DIR;
});

describe("task-doc", () => {
  it("parses minimal structured frontmatter from TASK.md", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-doc-frontmatter-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const task = { id: "task-frontmatter", taskDir: getCanonicalTaskDir("task-frontmatter") };
    const docPath = getTaskDocPath(task);
    mkdirSync(task.taskDir, { recursive: true });

    writeFileSync(
      docPath,
      `---
id: "task-frontmatter"
title: "Frontmatter parse"
parent_task_id: "task-parent"
status: "blocked"
priority: "urgent"
progress: 77
summary: "waiting on merge"
blocker_reason: "PR dependency"
---

# Frontmatter parse
`,
      "utf8",
    );

    expect(readTaskDocFrontmatter(task)).toEqual({
      id: "task-frontmatter",
      title: "Frontmatter parse",
      parentTaskId: "task-parent",
      status: "blocked",
      priority: "urgent",
      progress: 77,
      summary: "waiting on merge",
      blockerReason: "PR dependency",
    });
  });
});
