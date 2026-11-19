import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ENV_FILE_BYTES } from "../../cron/shell-executor.js";
import { shellEnvFileInsideStateDir, shellEnvFileRefusal } from "../shell-env-file.js";

let root: string | null = null;

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "ravi-shell-env-file-"));
  return root;
}

/**
 * Runs `code` in a child bun with a time limit. A check that opens a FIFO
 * blocks until a writer shows up; in the child it is killed there and fails the
 * test, instead of hanging the whole run.
 */
function runInChild(code: string): { status: number | null; signal: NodeJS.Signals | null; stdout: string } {
  const result = spawnSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout };
}

/** A regular file with one link that another user owns and nobody else can write, when there is one (not as root). */
const foreignFile = ["/etc/hosts", "/etc/passwd"].find((path) => {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats?.isFile() && stats.nlink === 1 && stats.uid !== process.getuid?.() && (stats.mode & 0o022) === 0;
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("shell trigger env file location", () => {
  it("refuses a file inside the state dir, whether or not it exists yet", () => {
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, ".env"), "RAVI_ADMIN_TOKEN=canary\n");

    expect(shellEnvFileInsideStateDir(join(stateDir, ".env"), stateDir)).toBe(true);
    expect(shellEnvFileInsideStateDir(join(stateDir, "nested", "later.env"), stateDir)).toBe(true);
  });

  it("refuses a path that reaches the state dir through a symlink", () => {
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, ".env"), "RAVI_ADMIN_TOKEN=canary\n");
    symlinkSync(stateDir, join(base, "innocent"));

    expect(shellEnvFileInsideStateDir(join(base, "innocent", ".env"), stateDir)).toBe(true);
  });

  it("accepts a file outside the state dir, including a sibling with a similar name", () => {
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    mkdirSync(join(base, ".ravi-trigger"));
    writeFileSync(join(base, ".ravi-trigger", "ticket.env"), "TICKET_QUEUE=ops\n");

    expect(shellEnvFileInsideStateDir(join(base, ".ravi-trigger", "ticket.env"), stateDir)).toBe(false);
    expect(shellEnvFileInsideStateDir(join(base, "ticket.env"), stateDir)).toBe(false);
  });

  it("refuses a .. that the OS applies after following a symlink into the state dir", () => {
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(join(stateDir, "sub"), { recursive: true });
    writeFileSync(join(stateDir, ".env"), "RAVI_ADMIN_TOKEN=canary\n");
    // base/link -> base/.ravi/sub, so base/link/../.env opens base/.ravi/.env (Devin, PR #881).
    symlinkSync(join(stateDir, "sub"), join(base, "link"));

    expect(shellEnvFileInsideStateDir(`${base}/link/../.env`, stateDir)).toBe(true);
    // Any .. segment is refused, even one a lexical check would place outside.
    expect(shellEnvFileInsideStateDir(`${base}/elsewhere/../ticket.env`, stateDir)).toBe(true);
  });

  it("treats a child whose name starts with two dots as inside (CodeRabbit, PR #881)", () => {
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "..secrets.env"), "RAVI_ADMIN_TOKEN=canary\n");

    expect(shellEnvFileInsideStateDir(join(stateDir, "..secrets.env"), stateDir)).toBe(true);
    // The parent and a sibling next to the state dir stay outside.
    expect(shellEnvFileInsideStateDir(join(base, "ticket.env"), stateDir)).toBe(false);
  });

  it("refuses a hard link, which a path check cannot follow", () => {
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, ".env"), "RAVI_ADMIN_TOKEN=canary\n");
    linkSync(join(stateDir, ".env"), join(base, "innocent.env"));
    writeFileSync(join(base, "own.env"), "TICKET_QUEUE=ops\n", { mode: 0o600 });

    expect(shellEnvFileInsideStateDir(join(base, "innocent.env"), stateDir)).toBe(false);
    expect(shellEnvFileRefusal(join(base, "innocent.env"), stateDir)).toBe("hard_link");
    expect(shellEnvFileRefusal(join(base, "own.env"), stateDir)).toBeNull();
    expect(shellEnvFileRefusal(join(stateDir, ".env"), stateDir)).toBe("in_state_dir");
  });

  it("refuses a FIFO without opening it, also below a FIFO, in a child process with a time limit", () => {
    // Bun's realpathSync opens the path on macOS; on a FIFO that would block until a writer shows up.
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    const fifo = join(base, "pipe.env");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

    const child = runInChild(`
      const { shellEnvFileInsideStateDir, shellEnvFileRefusal } = await import(${JSON.stringify(join(import.meta.dir, "..", "shell-env-file.ts"))});
      const fifo = ${JSON.stringify(fifo)};
      const stateDir = ${JSON.stringify(stateDir)};
      console.log(JSON.stringify({
        refusal: shellEnvFileRefusal(fifo, stateDir),
        inside: shellEnvFileInsideStateDir(fifo, stateDir),
        // A missing path under a FIFO (ENOTDIR): no realpath of the FIFO while walking up.
        below: shellEnvFileRefusal(fifo + "/child.env", stateDir),
      }));
    `);
    // A check that opened the FIFO ends at the time limit with SIGKILL and no output.
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ refusal: "not_regular_file", inside: false, below: null });
  }, 20_000);

  it("refuses a device and a directory as not a regular file, not as a hard link", () => {
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    mkdirSync(join(base, "a-directory"));

    expect(shellEnvFileRefusal("/dev/zero", stateDir)).toBe("not_regular_file");
    expect(shellEnvFileRefusal(join(base, "a-directory"), stateDir)).toBe("not_regular_file");
  });

  it("refuses a regular file over the loader's limit and accepts one at the limit (CodeRabbit, PR #884)", () => {
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    writeFileSync(join(base, "at-limit.env"), "x".repeat(MAX_ENV_FILE_BYTES), { mode: 0o600 });
    writeFileSync(join(base, "over-limit.env"), "x".repeat(MAX_ENV_FILE_BYTES + 1), { mode: 0o600 });

    expect(shellEnvFileRefusal(join(base, "at-limit.env"), stateDir)).toBeNull();
    expect(shellEnvFileRefusal(join(base, "over-limit.env"), stateDir)).toBe("too_large");
  });

  it("refuses a file its group or others can write, as the loader does, so the error comes on create (review of #884)", () => {
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    const envFile = join(base, "ticket.env");
    writeFileSync(envFile, "TICKET_QUEUE=ops\n", { mode: 0o600 });

    expect(shellEnvFileRefusal(envFile, stateDir)).toBeNull();
    for (const mode of [0o666, 0o620, 0o602]) {
      chmodSync(envFile, mode);
      expect(shellEnvFileRefusal(envFile, stateDir)).toBe("writable_by_others");
    }
    chmodSync(envFile, 0o644);
    expect(shellEnvFileRefusal(envFile, stateDir)).toBeNull();
  });

  it.skipIf(!foreignFile)("refuses a file another user owns", () => {
    const stateDir = join(makeRoot(), ".ravi");
    mkdirSync(stateDir);

    expect(shellEnvFileRefusal(foreignFile!, stateDir)).toBe("not_owned");
  });

  it("refuses a symlink loop as unverifiable instead of throwing ELOOP (review of #888)", () => {
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    symlinkSync(join(base, "loop-b.env"), join(base, "loop-a.env"));
    symlinkSync(join(base, "loop-a.env"), join(base, "loop-b.env"));

    expect(shellEnvFileRefusal(join(base, "loop-a.env"), stateDir)).toBe("unverifiable");
    // Also a path that would sit below the loop.
    expect(shellEnvFileRefusal(join(base, "loop-a.env", "child.env"), stateDir)).toBe("unverifiable");
  });

  // Root reads and searches anything, so there is no EACCES to see.
  it.skipIf(process.getuid?.() === 0)(
    "refuses a file in a directory Ravi may not search, or one it may not read, as unverifiable instead of throwing EACCES",
    () => {
      const base = makeRoot();
      const stateDir = join(base, ".ravi");
      mkdirSync(stateDir);
      const locked = join(base, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "ticket.env"), "TICKET_QUEUE=ops\n", { mode: 0o600 });
      writeFileSync(join(base, "write-only.env"), "TICKET_QUEUE=ops\n", { mode: 0o600 });
      chmodSync(join(base, "write-only.env"), 0o200);
      chmodSync(locked, 0o000);
      try {
        expect(shellEnvFileRefusal(join(locked, "ticket.env"), stateDir)).toBe("unverifiable");
        // Readable by nobody: realpath fails on macOS, access(R_OK) on Linux.
        expect(shellEnvFileRefusal(join(base, "write-only.env"), stateDir)).toBe("unverifiable");
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});
