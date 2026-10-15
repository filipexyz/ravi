import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
