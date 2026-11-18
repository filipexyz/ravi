import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellEnvFileInsideStateDir } from "../shell-env-file.js";

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
});
