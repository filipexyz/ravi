import { expect, it } from "bun:test";
import { YAML } from "bun";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type WorkflowJob = {
  env?: Record<string, string>;
  steps: Array<{ run?: string; env?: Record<string, string> }>;
};

for (const [workflow, jobName, command] of [
  ["ci.yml", "quality-gate", "bun run test"],
  ["version.yml", "version-and-publish", "git push origin"],
] as const) {
  it(`${workflow} supplies temporary state to the suite and Git hooks`, () => {
    const document = YAML.parse(
      readFileSync(resolve(import.meta.dir, "../../.github/workflows", workflow), "utf8"),
    ) as {
      jobs: Record<string, WorkflowJob>;
    };
    const job = document.jobs[jobName]!;
    const selection = job.env?.RAVI_STATE_DIR;
    expect(selection).toMatch(/^\$\{\{ runner\.temp \}\}\/ravi-[a-z-]+$/);
    const checkSteps = job.steps.filter((step) => step.run?.includes(command));
    expect(checkSteps.length).toBeGreaterThan(0);
    for (const step of job.steps) {
      expect(step.env?.RAVI_STATE_DIR ?? selection).toBe(selection);
    }

    const dir = mkdtempSync(join(tmpdir(), "ravi-workflow-state-"));
    try {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression, not JavaScript interpolation.
      const stateDir = selection!.replace("${{ runner.temp }}", dir);
      const log = join(dir, "checks");
      // Exercise the real hook with a cheap checker in place of Bun. A hook
      // that drops/overwrites the workflow's selection must fail here.
      writeFileSync(
        join(dir, "bun"),
        `#!/bin/sh
set -eu
test "\${RAVI_STATE_DIR:-}" = "$EXPECTED_STATE_DIR"
mkdir -p "$RAVI_STATE_DIR"
printf '%s\\n' "$*" >> "$HOOK_CALL_LOG"
`,
        { mode: 0o755 },
      );
      const result = spawnSync("bash", [resolve(import.meta.dir, "../../.githooks/pre-push")], {
        cwd: resolve(import.meta.dir, "../.."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          RAVI_STATE_DIR: stateDir,
          EXPECTED_STATE_DIR: stateDir,
          HOOK_CALL_LOG: log,
        },
        timeout: 10_000,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "run sdk:check",
        "run build",
        "run typecheck",
        "run test",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

it("does not leak the hook's Git repository or Ravi runtime identity into checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "ravi-pre-push-env-"));
  try {
    const log = join(dir, "calls");
    writeFileSync(
      join(dir, "bun"),
      `#!/bin/sh
if env | grep -Eq '^(GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)|RAVI_CONTEXT_KEY|RAVI_SESSION_NAME)='; then
  exit 42
fi
printf '%s\\n' "$*" >> "$HOOK_CALL_LOG"
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [resolve(import.meta.dir, "../../.githooks/pre-push")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        HOOK_CALL_LOG: log,
        GIT_DIR: join(dir, "wrong.git"),
        GIT_WORK_TREE: join(dir, "wrong-worktree"),
        GIT_INDEX_FILE: join(dir, "wrong-index"),
        GIT_COMMON_DIR: join(dir, "wrong-common"),
        GIT_PREFIX: "wrong-prefix/",
        RAVI_CONTEXT_KEY: "synthetic-context",
        RAVI_SESSION_NAME: "synthetic-session",
      },
      timeout: 10_000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "run sdk:check",
      "run build",
      "run typecheck",
      "run test",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
