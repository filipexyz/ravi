import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCanonicalTaskDir, getTaskDocPath, readTaskDocFrontmatter, writeTaskDoc } from "./task-doc.js";
import type { TaskRecord } from "./types.js";

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
progress_note: "investigando contrato do runtime"
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
      progressNote: "investigando contrato do runtime",
      summary: "waiting on merge",
      blockerReason: "PR dependency",
    });
  });

  it("preserves progress_note when the runtime rewrites TASK.md frontmatter", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-doc-preserve-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const taskDir = getCanonicalTaskDir("task-preserve-progress-note");
    const task: TaskRecord = {
      id: "task-preserve-progress-note",
      title: "Preserve progress note",
      instructions: "Keep the descriptive note while appending sections.",
      status: "in_progress",
      priority: "high",
      progress: 42,
      taskDir,
      createdAt: 1,
      updatedAt: 1,
    };
    const docPath = getTaskDocPath(task);
    mkdirSync(taskDir, { recursive: true });

    writeFileSync(
      docPath,
      `---
id: "task-preserve-progress-note"
title: "Preserve progress note"
parent_task_id: null
status: "in_progress"
priority: "high"
progress: 42
progress_note: "investigando o contrato de report"
summary: null
blocker_reason: null
---

# Preserve progress note
`,
      "utf8",
    );

    writeTaskDoc(task, {
      appendSection: {
        title: "Comment",
        timestamp: 2,
        lines: ["frontmatter rewrite should keep progress_note"],
      },
    });

    expect(readTaskDocFrontmatter(task).progressNote).toBe("investigando o contrato de report");
    expect(readFileSync(docPath, "utf8")).toContain('progress_note: "investigando o contrato de report"');
  });

  it("rejects TASK.md materialization for profiles without a task document policy", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-task-doc-runtime-only-"));
    tempStateDirs.push(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;

    const taskDir = getCanonicalTaskDir("task-runtime-only");
    const task: TaskRecord = {
      id: "task-runtime-only",
      title: "Runtime only",
      instructions: "No TASK.md here",
      status: "open",
      priority: "normal",
      progress: 0,
      taskDir,
      profileId: "runtime-only-test",
      profileSnapshot: {
        id: "runtime-only-test",
        version: "1",
        label: "Runtime only",
        description: "guard",
        sessionNameTemplate: "<task-id>-work",
        workspaceBootstrap: {
          mode: "task_dir",
          ensureTaskDir: true,
        },
        sync: {
          artifactFirst: false,
        },
        rendererHints: {
          label: "Runtime only",
          showTaskDoc: false,
          showWorkspace: true,
        },
        defaultTags: [],
        inputs: [],
        completion: {},
        progress: {},
        templates: {
          dispatch: "dispatch",
          resume: "resume",
          dispatchSummary: "summary",
          dispatchEventMessage: "event",
        },
        artifacts: [],
        state: [],
        sourceKind: "system",
        source: "system:runtime-only-test",
        manifestPath: null,
      },
      createdAt: 1,
      updatedAt: 1,
    };

    expect(() => writeTaskDoc(task)).toThrow(
      "Task task-runtime-only profile runtime-only-test forbids TASK.md materialization.",
    );
    expect(existsSync(join(taskDir, "TASK.md"))).toBe(false);
  });
});
