#!/usr/bin/env bun
/** Production-host publication: focused local checks, Git Data API, full PR CI. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TreeChange {
  path: string;
  mode: string;
  type: "blob";
  sha: string | null;
}
export interface PublishPlan {
  repository: string;
  branch: string;
  base: string;
  head: string;
  tree: string;
  baseTree: string;
  message: string;
  changes: TreeChange[];
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Buffer {
  const result = spawnSync(command, args, { ...options, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed: ${result.stderr.toString()}`);
  if (command === "bun") {
    // Bun writes its test summary to stderr. Keep a short receipt, not all logs.
    console.log(result.stderr.toString().trim().split("\n").slice(-6).join("\n"));
  }
  return result.stdout;
}

export function planPublication(branch: string, cwd = process.cwd()): PublishPlan {
  // This tool cannot publish release branches or tags, even with --execute.
  if (!/^(fix|feat|chore|docs|test|refactor|agent)\/[a-zA-Z0-9._/-]+$/.test(branch)) {
    throw new Error("Use a work branch under fix/, feat/, chore/, docs/, test/, refactor/ or agent/.");
  }
  const git = (...args: string[]) => run("git", args, { cwd }).toString().trim();
  git("check-ref-format", `refs/heads/${branch}`);
  if (git("status", "--porcelain")) throw new Error("Commit all changes before publishing; worktree must be clean.");
  const remote = git("remote", "get-url", "origin");
  const repository = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
  if (!repository) throw new Error("origin must be a github.com repository (without embedded credentials).");
  const base = git("rev-parse", "origin/dev");
  const head = git("rev-parse", "HEAD");
  git("merge-base", "--is-ancestor", base, head);
  git("diff", "--check", base, head);
  const entries = run("git", ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", base, head], { cwd })
    .toString()
    .split("\0");
  const changes: TreeChange[] = [];
  for (let i = 0; i < entries.length - 1; i += 2) {
    const [oldMode, newMode, , newSha, status] = entries[i].slice(1).split(" ");
    const mode = status === "D" ? oldMode : newMode;
    if (!["100644", "100755", "120000"].includes(mode)) throw new Error("Submodule/tree changes are not supported.");
    changes.push({ path: entries[i + 1], mode, type: "blob", sha: status === "D" ? null : newSha });
  }
  if (!changes.length) throw new Error("No committed changes against origin/dev.");
  return {
    repository,
    branch,
    base,
    head,
    changes,
    tree: git("rev-parse", "HEAD^{tree}"),
    baseTree: git("rev-parse", "origin/dev^{tree}"),
    message: `${git("log", "-1", "--format=%B")}\n\nLocal-Commit: ${head}\nPublication: Git Data API; full validation required in PR CI.`,
  };
}

export type GitApi = (method: "GET" | "POST", endpoint: string, body?: unknown) => unknown;

/** Create-only: existing refs and races fail, never update/force-push history. */
export function publishPlan(plan: PublishPlan, api: GitApi, readBlob: (sha: string) => Buffer): string {
  const root = `repos/${plan.repository}/git`;
  const refs = api("GET", `${root}/matching-refs/heads/${plan.branch}`) as Array<{ ref: string }>;
  if (refs.some((ref) => ref.ref === `refs/heads/${plan.branch}`))
    throw new Error("Remote branch exists; choose a new work branch.");
  const base = api("GET", `${root}/commits/${plan.base}`) as { tree: { sha: string } };
  if (base.tree.sha !== plan.baseTree) throw new Error("Remote base tree differs from local base.");
  for (const sha of new Set(plan.changes.flatMap((change) => (change.sha ? [change.sha] : [])))) {
    const blob = api("POST", `${root}/blobs`, { content: readBlob(sha).toString("base64"), encoding: "base64" }) as {
      sha: string;
    };
    if (blob.sha !== sha) throw new Error("Uploaded blob hash mismatch; no ref created.");
  }
  const tree = api("POST", `${root}/trees`, { base_tree: plan.baseTree, tree: plan.changes }) as { sha: string };
  if (tree.sha !== plan.tree) throw new Error("Published tree differs from checked HEAD; no ref created.");
  const commit = api("POST", `${root}/commits`, { message: plan.message, tree: tree.sha, parents: [plan.base] }) as {
    sha: string;
  };
  api("POST", `${root}/refs`, { ref: `refs/heads/${plan.branch}`, sha: commit.sha });
  return commit.sha;
}

export function runFocusedChecks(plan: PublishPlan, tests: string[], cwd = process.cwd()): void {
  if (!tests.length || tests.some((test) => !/^src\/[\w./-]+\.test\.ts$/.test(test) || test.includes(".."))) {
    throw new Error("Supply at least one exact focused test file with --test src/...test.ts.");
  }
  const state = mkdtempSync(join(tmpdir(), "ravi-publish-check-"));
  const env = { ...process.env };
  // Test/quality subprocesses must not inherit runtime authority or deployment confirmation.
  for (const key of Object.keys(env)) if (key.startsWith("RAVI_") || key.startsWith("GIT_")) delete env[key];
  delete env.CHANGED_FILES;
  delete env.QUALITY_GATE_REVERT;
  env.RAVI_STATE_DIR = state;
  env.GITHUB_BASE_REF = "dev";
  env.LOG_LEVEL = "error";
  try {
    console.log(run("bun", ["test", ...tests], { cwd, env }).toString());
    console.log(run("bun", ["src/ci/run-quality-gate.ts"], { cwd, env }).toString());
    // A check that edits tracked files invalidates the reviewed plan.
    const after = planPublication(plan.branch, cwd);
    if (after.head !== plan.head || after.tree !== plan.tree || after.base !== plan.base)
      throw new Error("Checkout changed during checks.");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

export function main(args = process.argv.slice(2)): void {
  try {
    let branch = "";
    let execute = false;
    const tests: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--branch") branch = args[++i] ?? "";
      else if (args[i] === "--test") tests.push(args[++i] ?? "");
      else if (args[i] === "--execute") execute = true;
      else
        throw new Error("Usage: bun scripts/publish-branch.ts --branch fix/name --test src/path.test.ts [--execute]");
    }
    const plan = planPublication(branch);
    console.log(
      JSON.stringify(
        {
          repository: plan.repository,
          branch,
          base: plan.base,
          head: plan.head,
          tree: plan.tree,
          files: plan.changes.map((c) => c.path),
          execute,
        },
        null,
        2,
      ),
    );
    runFocusedChecks(plan, tests);
    if (execute) {
      const api: GitApi = (method, endpoint, body) =>
        JSON.parse(
          run("gh", ["api", "--method", method, endpoint, ...(body ? ["--input", "-"] : [])], {
            input: body ? JSON.stringify(body) : undefined,
          }).toString(),
        );
      const commit = publishPlan(plan, api, (sha) => run("git", ["cat-file", "blob", sha]));
      console.log(
        JSON.stringify({
          branch,
          commit,
          tree: plan.tree,
          next: `Open a PR against dev and require CI: ${plan.repository}/compare/dev...${branch}`,
        }),
      );
    } else
      console.log(
        "Preview passed. Re-run with --execute to create the remote work branch; no hook settings are changed.",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
