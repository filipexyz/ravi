import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath, isWithin, needsIsolatedState } from "./state-isolation.js";

const repoRoot = join(import.meta.dir, "..", "..");
const sandboxes: string[] = [];

function sandbox(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("needsIsolatedState", () => {
  it("replaces an unset, blank or real state directory and keeps an explicit isolated one", () => {
    const home = sandbox("ravi-iso-home-");
    mkdirSync(join(home, ".ravi", "nested"), { recursive: true });
    mkdirSync(join(home, "ravi-ci-state"));
    expect(needsIsolatedState({}, home)).toBe(true);
    expect(needsIsolatedState({ RAVI_STATE_DIR: "   " }, home)).toBe(true);
    expect(needsIsolatedState({ RAVI_STATE_DIR: join(home, ".ravi") }, home)).toBe(true);
    expect(needsIsolatedState({ RAVI_STATE_DIR: join(home, ".ravi", "nested") }, home)).toBe(true);
    // CI's shape: a directory inside the home that is not the real state.
    expect(needsIsolatedState({ RAVI_STATE_DIR: join(home, "ravi-ci-state") }, home)).toBe(false);
    expect(needsIsolatedState({ RAVI_STATE_DIR: sandbox("ravi-iso-other-") }, home)).toBe(false);
  });

  it("sees through a symlink that points into the real state", () => {
    const home = sandbox("ravi-iso-home-");
    mkdirSync(join(home, ".ravi"));
    const alias = join(home, "innocent-looking");
    symlinkSync(join(home, ".ravi"), alias);
    expect(needsIsolatedState({ RAVI_STATE_DIR: alias }, home)).toBe(true);
  });
});

describe("the bunfig preload", () => {
  it("leaves this process with a state directory outside the real one", () => {
    const dir = process.env.RAVI_STATE_DIR;
    expect(dir).toBeTruthy();
    expect(isWithin(canonicalPath(dir!), canonicalPath(join(homedir(), ".ravi")))).toBe(false);
  });

  /** A child `bun test` from the repo root, as a contributor or the ravi-stress container would run it. */
  function runChild(home: string, stateDir: string | undefined) {
    const marker = join(home, "marker.txt");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("RAVI_")) env[key] = value;
    }
    env.HOME = home;
    env.RAVI_STATE_ISOLATION_MARKER = marker;
    if (stateDir !== undefined) env.RAVI_STATE_DIR = stateDir;
    const result = Bun.spawnSync([process.execPath, "test", "src/test/state-isolation.child.test.ts"], {
      cwd: repoRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    return { exitCode: result.exitCode, output, used: existsSync(marker) ? readFileSync(marker, "utf8") : null };
  }

  it("isolates a process that sets no RAVI_STATE_DIR, without touching its home", () => {
    const home = sandbox("ravi-iso-home-");
    const child = runChild(home, undefined);
    expect(child.exitCode, child.output).toBe(0);
    expect(child.used).toBeTruthy();
    expect(isWithin(canonicalPath(child.used!), canonicalPath(join(home, ".ravi")))).toBe(false);
    expect(existsSync(join(home, ".ravi"))).toBe(false);
    // The generated directory is removed when the child exits.
    expect(existsSync(child.used!)).toBe(false);
  });

  it("replaces a RAVI_STATE_DIR that points at the real state", () => {
    const home = sandbox("ravi-iso-home-");
    const real = join(home, ".ravi");
    const child = runChild(home, real);
    expect(child.exitCode, child.output).toBe(0);
    expect(child.used).toBeTruthy();
    expect(child.used).not.toBe(real);
    expect(existsSync(real)).toBe(false);
  });

  it("keeps the isolated directory the caller chose, as CI does", () => {
    const home = sandbox("ravi-iso-home-");
    const chosen = join(home, "ravi-ci-state");
    mkdirSync(chosen);
    const child = runChild(home, chosen);
    expect(child.exitCode, child.output).toBe(0);
    expect(canonicalPath(child.used!)).toBe(canonicalPath(chosen));
    expect(existsSync(chosen)).toBe(true);
  });
});
