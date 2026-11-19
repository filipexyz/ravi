import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ENV_FILE_BYTES } from "../../cron/shell-executor.js";
import { shellEnvFileInsideStateDir, shellEnvFileRefusal } from "../shell-env-file.js";

let root: string | null = null;

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "ravi-shell-env-file-"));
  return root;
}

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
    writeFileSync(join(base, "own.env"), "TICKET_QUEUE=ops\n");

    expect(shellEnvFileInsideStateDir(join(base, "innocent.env"), stateDir)).toBe(false);
    expect(shellEnvFileRefusal(join(base, "innocent.env"), stateDir)).toBe("hard_link");
    expect(shellEnvFileRefusal(join(base, "own.env"), stateDir)).toBeNull();
    expect(shellEnvFileRefusal(join(stateDir, ".env"), stateDir)).toBe("in_state_dir");
  });

  it("refuses a FIFO without opening it, also below a FIFO, and never blocks", () => {
    // Bun's realpathSync opens the path on macOS; on a FIFO that would block until a writer shows up.
    const base = makeRoot();
    const stateDir = join(base, ".ravi");
    mkdirSync(stateDir);
    const fifo = join(base, "pipe.env");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

    const started = performance.now();
    expect(shellEnvFileRefusal(fifo, stateDir)).toBe("not_regular_file");
    expect(shellEnvFileInsideStateDir(fifo, stateDir)).toBe(false);
    // A missing path under a FIFO: no realpath of the FIFO while walking up.
    expect(shellEnvFileRefusal(join(fifo, "child.env"), stateDir)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

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
    writeFileSync(join(base, "at-limit.env"), "x".repeat(MAX_ENV_FILE_BYTES));
    writeFileSync(join(base, "over-limit.env"), "x".repeat(MAX_ENV_FILE_BYTES + 1));

    expect(shellEnvFileRefusal(join(base, "at-limit.env"), stateDir)).toBeNull();
    expect(shellEnvFileRefusal(join(base, "over-limit.env"), stateDir)).toBe("too_large");
  });
});
