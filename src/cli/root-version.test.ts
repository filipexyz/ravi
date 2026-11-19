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

/** Runs the CLI as a process, with no runtime identity and a state directory of its own. */
function runCli(args: string[], name: string) {
  const stateDir = join(tmpdir(), `ravi-root-${name}-${process.pid}`);
  const result = spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: testEnv(stateDir),
  });
  rmSync(stateDir, { recursive: true, force: true });
  return result;
}

// Every test below starts the CLI, 1.4 s to 4 s each on a CI runner and several times in some of them, against Bun's
// 5 s default timeout. Each one says how long it may take; the CI segment that runs the file keeps the default.
describe("CLI root version", () => {
  it("prints version only for the root invocation", () => {
    const result = spawnSync("bun", ["src/cli/index.ts", "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv(join(tmpdir(), `ravi-root-version-${process.pid}-root`)),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

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
    expect(root.stdout).not.toContain("--endpoint");
  }, 20_000);

  it("exposes ambient ravi link without identity flags", () => {
    const stateDir = join(tmpdir(), `ravi-root-link-help-${process.pid}`);
    const link = spawnSync("bun", ["src/cli/index.ts", "link", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: testEnv(stateDir),
    });
    const unlink = spawnSync("bun", ["src/cli/index.ts", "unlink", "--help"], {
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

    expect(link.status).toBe(0);
    expect(link.stdout).toContain("--json");
    expect(link.stdout).not.toContain("--contact");
    expect(link.stdout).not.toContain("--user");
    expect(link.stdout).not.toContain("--endpoint");
    expect(unlink.status).toBe(0);
    expect(unlink.stdout).toContain("--json");
    expect(unlink.stdout).not.toContain("--contact");
    expect(root.status).toBe(0);
    expect(root.stdout).toContain("link [options]");
    expect(root.stdout).toContain("unlink [options]");
  }, 20_000);

  it("suggests the plural tasks command for the singular task command, with or without a help flag", () => {
    // `ravi task --help` used to print the root help and exit 0: Commander looks for help before it looks for an
    // unknown command. The usage contract makes it the same usage error as `ravi task`.
    for (const args of [["task"], ["task", "--help"]]) {
      const result = runCli(args, "task-suggestion");

      const command = `ravi ${args.join(" ")}`;
      expect(result.status, command).toBe(2);
      expect(result.stdout, command).not.toContain("Usage: ravi [options] [command]");
      expect(result.stderr, command).toContain("unknown command 'task'");
      expect(result.stderr, command).toContain("(Did you mean tasks?)");
    }
  }, 20_000);

  it("suggests the subcommand of a group when a help flag follows a misspelled one, at any depth", () => {
    // `ravi tasks lsit --help` used to print the help of `tasks` and exit 0, the same as `ravi task --help` at the root.
    for (const args of [
      ["tasks", "lsit", "--help"],
      ["tasks", "profiles", "lsit", "-h"],
    ]) {
      const result = runCli(args, "group-suggestion");

      const command = `ravi ${args.join(" ")}`;
      expect(result.status, command).toBe(2);
      expect(result.stdout, command).not.toContain("Usage: ravi tasks");
      expect(result.stderr, command).toContain("unknown command 'lsit'");
      expect(result.stderr, command).toContain("(Did you mean list?)");
    }
  }, 20_000);

  it("does not let an unknown option or the end-of-options marker hide an unknown command behind a help flag", () => {
    const marker = runCli(["task", "--foo", "--", "--help"], "unknown-command-marker");
    expect(marker.status).toBe(2);
    expect(marker.stdout).not.toContain("Usage: ravi [options] [command]");
    expect(marker.stderr).toContain("unknown command 'task'");

    // The root declares no `--json`: without the help flag the parser reports it, and with the flag it still does.
    const option = runCli(["--json", "task", "--help"], "unknown-option-help");
    expect(option.status).toBe(2);
    expect(option.stdout).not.toContain("Usage: ravi [options] [command]");
    expect(option.stdout).toContain('"code": "USAGE_ERROR"');
    expect(option.stdout).toContain("unknown option '--json'");
  }, 20_000);

  it("still prints the help of a group, of one of its commands and of a group that takes its own argument", () => {
    for (const [args, usage] of [
      [["tasks", "--help"], "Usage: ravi tasks [options] [command]"],
      [["tasks", "list", "--help"], "Usage: ravi tasks list [options]"],
      [["crm", "contact", "someid", "--help"], "Usage: ravi crm contact [options] [command] <contact>"],
    ] as const) {
      const result = runCli([...args], "known-help");

      const command = `ravi ${args.join(" ")}`;
      expect(result.status, command).toBe(0);
      expect(result.stdout, command).toContain(usage);
    }
  }, 20_000);
});
