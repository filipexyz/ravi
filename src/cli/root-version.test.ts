import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

function testEnv(stateDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, RAVI_STATE_DIR: stateDir };
  delete env.RAVI_CONTEXT_KEY;
  delete env.RAVI_SESSION_KEY;
  delete env.RAVI_SESSION_NAME;
  delete env.RAVI_AGENT_ID;
  delete env.RAVI_CHANNEL;
  delete env.RAVI_ACCOUNT_ID;
  delete env.RAVI_CHAT_ID;
  return env;
}

describe("CLI root version", () => {
  it("prints version only for the root invocation", () => {
    const result = spawnSync("bun", ["src/cli/index.ts", "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv(join(tmpdir(), `ravi-root-version-${process.pid}-root`)),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("lets subcommands own their --version option", () => {
    const stateDir = join(tmpdir(), `ravi-root-version-${process.pid}-subcommand`);
    const result = spawnSync("bun", ["src/cli/index.ts", "artifacts", "restore", "art_missing", "--version", "1"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv(stateDir),
    });
    rmSync(stateDir, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).not.toBe(pkg.version);
    expect(result.stderr).toContain("Artifact not found: art_missing");
  });

  it("prints the live operational context in root help", () => {
    const stateDir = join(tmpdir(), `ravi-root-help-${process.pid}`);
    const result = spawnSync("bun", ["src/cli/index.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv(stateDir),
    });
    rmSync(stateDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Ravi Operational Context");
    expect(result.stdout).toContain("ravi self permissions --json");
    expect(result.stdout).toContain("ravi --help");
  });

  it("keeps root login scoped to Ravi Console", () => {
    const stateDir = join(tmpdir(), `ravi-root-login-help-${process.pid}`);
    const login = spawnSync("bun", ["src/cli/index.ts", "login", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv(stateDir),
    });
    const root = spawnSync("bun", ["src/cli/index.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv(stateDir),
    });
    rmSync(stateDir, { recursive: true, force: true });

    expect(login.status).toBe(0);
    expect(login.stdout).toContain("Console-compatible endpoint");
    expect(login.stdout).toContain("--console <url>");
    expect(login.stdout).toContain("https://console.ravi.bot");
    expect(login.stdout).not.toContain("--endpoint");
    expect(root.status).toBe(0);
    expect(root.stdout).not.toContain("link [options]");
  });

  it("suggests the plural tasks command for singular task help", () => {
    const stateDir = join(tmpdir(), `ravi-root-task-suggestion-${process.pid}`);
    const result = spawnSync("bun", ["src/cli/index.ts", "task", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv(stateDir),
    });
    rmSync(stateDir, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: ravi task");
    expect(result.stderr).toContain("Did you mean: ravi tasks --help?");
  });
});
