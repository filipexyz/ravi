/**
 * Production TaskProbe: reads task state read-only from `ravi.db` and applies
 * the strict Git safety proof before a terminal task worktree can become a
 * candidate. Removal is delegated to `git worktree remove` (the canonical Git
 * lifecycle); the storage engine never deletes a worktree directly.
 *
 * Fail-closed: missing DB, unreadable row, missing path, non-secondary
 * worktree, dirty tree, stash, detached HEAD, no upstream or any unpushed
 * commit all preserve the worktree.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { Database } from "bun:sqlite";
import { getRaviStateDir } from "../utils/paths.js";
import type { TaskProbe, TaskWorktreeAssessment, TaskWorktreeRecord } from "./task-probe.js";

const GIT_TIMEOUT_MS = 15_000;

interface TaskRow {
  id: string;
  status: string;
  task_dir: string | null;
  worktree_path: string;
  worktree_branch: string | null;
  updated_at: number;
  completed_at: number | null;
  archived_at: number | null;
}

function preserved(reason: string): TaskWorktreeAssessment {
  return { decision: "preserved", reason };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out ?? "" };
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) };
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function worktreeEntries(path: string): string[] {
  const res = git(path, ["worktree", "list", "--porcelain"]);
  if (!res.ok) return [];
  return res.out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => safeRealpath(line.slice("worktree ".length).trim()));
}

export function createRaviTaskProbe(env: NodeJS.ProcessEnv = process.env): TaskProbe {
  const listWorktreeTasks = (): { records: TaskWorktreeRecord[]; error?: string } => {
    const dbPath = join(getRaviStateDir(env), "ravi.db");
    if (!existsSync(dbPath)) return { records: [], error: "task database not present" };
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const rows = db
        .query(
          "SELECT id, status, task_dir, worktree_path, worktree_branch, updated_at, completed_at, archived_at FROM tasks WHERE worktree_path IS NOT NULL AND TRIM(worktree_path) <> ''",
        )
        .all() as TaskRow[];
      return {
        records: rows.map((row) => ({
          taskId: row.id,
          status: row.status,
          taskDir: row.task_dir,
          worktreePath: row.worktree_path,
          worktreeBranch: row.worktree_branch,
          updatedAt: row.updated_at,
          completedAt: row.completed_at,
          archivedAt: row.archived_at,
        })),
      };
    } catch (error) {
      return { records: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
      db?.close();
    }
  };

  const assess = (record: TaskWorktreeRecord): TaskWorktreeAssessment => {
    const path = record.worktreePath;
    const real = safeRealpath(path);
    if (!existsSync(path)) return preserved("worktree path does not exist");
    const cwd = safeRealpath(process.cwd());
    const pathWithSep = real.endsWith(sep) ? real : `${real}${sep}`;
    if (cwd === real || cwd.startsWith(pathWithSep)) {
      return preserved("current process cwd is inside the worktree");
    }

    const entries = worktreeEntries(path);
    if (entries.length === 0) return preserved("not a registered Git worktree");
    if (entries.length < 2) return preserved("not a secondary Git worktree");
    if (!entries.includes(real)) return preserved("path is not registered in the repository worktree list");
    if (entries[0] === real) return preserved("path is the main working tree, not a secondary worktree");

    const branch = git(path, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!branch.ok || branch.out.trim() === "") return preserved("detached HEAD");
    if (record.worktreeBranch && branch.out.trim() !== record.worktreeBranch) {
      return preserved(`branch mismatch (expected ${record.worktreeBranch})`);
    }

    const status = git(path, ["status", "--porcelain", "--untracked-files=all"]);
    if (!status.ok) return preserved("git status failed");
    if (status.out.trim() !== "") return preserved("worktree is dirty or has untracked files");

    const stash = git(path, ["stash", "list"]);
    if (!stash.ok) return preserved("git stash list failed");
    if (stash.out.trim() !== "") return preserved("repository has stashed changes");

    const upstream = git(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (!upstream.ok || upstream.out.trim() === "") return preserved("branch has no upstream (unpushed risk)");

    const ahead = git(path, ["rev-list", "--count", "@{u}..HEAD"]);
    if (!ahead.ok) return preserved("could not count unpushed commits");
    const aheadCount = Number.parseInt(ahead.out.trim(), 10);
    if (!Number.isFinite(aheadCount)) return preserved("could not count unpushed commits");
    if (aheadCount > 0) return preserved(`${aheadCount} unpushed commit(s)`);

    return { decision: "candidate", reason: "terminal task worktree: clean, no stash, fully pushed" };
  };

  const remove = (record: TaskWorktreeRecord): { ok: true } | { ok: false; error: string } => {
    const entries = worktreeEntries(record.worktreePath);
    const main = entries[0];
    if (!main) return { ok: false, error: "could not resolve the main working tree" };
    const res = git(main, ["worktree", "remove", record.worktreePath]);
    if (!res.ok) return { ok: false, error: res.out.split("\n")[0] ?? "git worktree remove failed" };
    return { ok: true };
  };

  return { listWorktreeTasks, assess, remove };
}
