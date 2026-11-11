import { expect, it } from "bun:test";
import { YAML } from "bun";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type WorkflowJob = {
  env?: Record<string, string>;
  steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
};

for (const [workflow, jobName, command, stateName] of [
  ["ci.yml", "quality-gate", "bun run test", "ravi-ci-state"],
  ["version.yml", "version-and-publish", "git push origin", "ravi-version-state"],
  ["sdk-release.yml", "release", "git push origin", "ravi-sdk-release-state"],
] as const) {
  it(`${workflow} supplies temporary state to the suite and Git hooks`, () => {
    const document = YAML.parse(
      readFileSync(resolve(import.meta.dir, "../../.github/workflows", workflow), "utf8"),
    ) as {
      jobs: Record<string, WorkflowJob>;
    };
    const job = document.jobs[jobName]!;
    const isolationIndex = job.steps.findIndex((step) => step.name === "Isolate Ravi state");
    expect(isolationIndex).toBeGreaterThanOrEqual(0);
    const isolation = job.steps[isolationIndex]!;
    expect(isolation.run).toBeDefined();
    expect(isolation).not.toHaveProperty("if");
    expect(isolation).not.toHaveProperty("continue-on-error");
    const firstSourceCommand = job.steps.findIndex((step) => /\bbun\b/.test(step.run ?? ""));
    expect(firstSourceCommand).toBeGreaterThan(isolationIndex);
    const checkSteps = job.steps.filter((step) => step.run?.includes(command));
    expect(checkSteps.length).toBeGreaterThan(0);
    expect(job.env?.RAVI_STATE_DIR).toBeUndefined();
    for (const step of job.steps) {
      expect(step.env?.RAVI_STATE_DIR).toBeUndefined();
    }

    const dir = mkdtempSync(join(tmpdir(), "ravi-workflow-state with space-"));
    try {
      const envFile = join(dir, "github-env");
      const stepEnv: NodeJS.ProcessEnv = { ...process.env, RUNNER_TEMP: dir, GITHUB_ENV: envFile };
      delete stepEnv.RAVI_STATE_DIR;
      const setup = spawnSync("bash", ["-e", "-c", isolation.run!], {
        encoding: "utf8",
        env: stepEnv,
        timeout: 10_000,
      });
      expect(setup.status).toBe(0);
      expect(setup.stderr).toBe("");
      // Load the output exactly as the runner does for later steps. A plain
      // shell export would not survive this step and must fail the regression.
      const assignments = readFileSync(envFile, "utf8").trim().split("\n");
      const expectedStateDir = join(dir, stateName);
      expect(assignments).toEqual([`RAVI_STATE_DIR=${expectedStateDir}`]);
      const stateDir = assignments[0]!.slice("RAVI_STATE_DIR=".length);
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
