import { afterAll, afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutRaviRuntimeContextEnv } from "../test/ravi-state.js";
import {
  enterHomeInvocation,
  getCliInvocationTarget,
  HOME_STATIC_COMMANDS,
  homeCommands,
  homeHelp,
  setCliInvocationTarget,
} from "./home-mode.js";

setDefaultTimeout(90_000);

afterEach(() => setCliInvocationTarget("local"));

describe("home invocation target", () => {
  it("pins the milestone 1 allowlist (Console SANDBOX_COMMAND_ALLOWLIST), without tasks.comment", () => {
    expect([...HOME_STATIC_COMMANDS]).toEqual([
      "tasks.block",
      "tasks.done",
      "tasks.fail",
      "tasks.report",
      "tasks.show",
    ]);
  });

  it("leaves any other invocation alone", () => {
    const argv = ["bun", "ravi", "tasks", "report", "t1"];
    expect(enterHomeInvocation(argv, {})).toBeNull();
    expect(argv).toEqual(["bun", "ravi", "tasks", "report", "t1"]);
    expect(getCliInvocationTarget()).toBe("local");
  });

  it("strips the home token and sets the target for an allowlisted command", () => {
    const argv = ["bun", "ravi", "home", "tasks", "report", "t1", "--message", "hi"];
    expect(enterHomeInvocation(argv, {})).toEqual({ kind: "dispatch", commandId: "tasks.report" });
    expect(argv).toEqual(["bun", "ravi", "tasks", "report", "t1", "--message", "hi"]);
    expect(getCliInvocationTarget()).toBe("home");
  });

  it("refuses tasks comment and anything outside the allowlist with exit 3, without touching argv", () => {
    for (const rest of [
      ["tasks", "comment", "t1", "hi"],
      ["agents", "list"],
      ["tasks"],
      ["tasks", "--help"],
      ["--x"],
    ]) {
      const argv = ["bun", "ravi", "home", ...rest];
      const result = enterHomeInvocation(argv, {});
      expect(result?.kind).toBe("refused");
      if (result?.kind !== "refused") continue;
      expect(result.error.exitCode).toBe(3);
      expect(result.error.code).toBe("HOME_COMMAND_NOT_ALLOWED");
      expect(argv).toEqual(["bun", "ravi", "home", ...rest]);
      expect(getCliInvocationTarget()).toBe("local");
    }
  });

  it("narrows with RAVI_HOME_COMMANDS and never widens past the static allowlist", () => {
    const env = { RAVI_HOME_COMMANDS: "tasks.report, tasks.comment agents.list" };
    expect(homeCommands(env)).toEqual(["tasks.report"]);
    expect(enterHomeInvocation(["b", "r", "home", "tasks", "done", "t1"], env)?.kind).toBe("refused");
    expect(enterHomeInvocation(["b", "r", "home", "tasks", "comment", "t1", "x"], env)?.kind).toBe("refused");
    expect(homeCommands({ RAVI_HOME_COMMANDS: " " })).toEqual([...HOME_STATIC_COMMANDS]);
  });

  it("answers help without the gateway URL value", () => {
    expect(enterHomeInvocation(["b", "r", "home"], {})).toEqual({ kind: "help", asJson: false });
    expect(enterHomeInvocation(["b", "r", "home", "--help"], {})).toEqual({ kind: "help", asJson: false });
    expect(enterHomeInvocation(["b", "r", "home", "--json"], {})).toEqual({ kind: "help", asJson: true });
    const help = homeHelp({ RAVI_HOME_GATEWAY_URL: "https://SENTINEL_HOST_4C/i/x", RAVI_HOME_COMMANDS: "tasks.show" });
    expect(help.text).toContain("ravi home tasks show");
    expect(help.text).not.toContain("tasks report");
    expect(help.text).not.toContain("SENTINEL_HOST");
    expect(help.json).toEqual({ success: true, commands: ["tasks.show"], gatewayConfigured: true });
  });
});

const processStateDir = mkdtempSync(join(tmpdir(), "ravi-home-mode-smoke-"));
afterAll(() => rmSync(processStateDir, { recursive: true, force: true }));

function runCli(args: string[], env: Record<string, string>): { status: number | null; output: string } {
  const result = spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...withoutRaviRuntimeContextEnv(),
      RAVI_STATE_DIR: processStateDir,
      RAVI_SUPPRESS_AUDIT_EVENTS: "1",
      ...env,
    },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("ravi home process contract", () => {
  const grant = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJzYW5kYm94In0.SENTINEL_GRANT_SIG_8M3P";

  it("exits 3 for tasks comment, even with a context key and a gateway URL set", () => {
    const run = runCli(["home", "tasks", "comment", "t1", "hello", "--json"], {
      RAVI_CONTEXT_KEY: "rctx_process_smoke",
      RAVI_GATEWAY_URL: "https://gateway.example.test",
      RAVI_HOME_GATEWAY_URL: "https://gw.example.test/i/x",
    });
    expect(run.status).toBe(3);
    expect(run.output).toContain("HOME_COMMAND_NOT_ALLOWED");
  });

  it("exits 0 for help and 2 for an http HOME URL", () => {
    expect(runCli(["home", "--help"], {}).status).toBe(0);
    const insecure = runCli(["home", "tasks", "report", "t1", "--json"], {
      RAVI_HOME_GATEWAY_URL: "http://gw.example.test/i/x",
    });
    expect(insecure.status).toBe(2);
    expect(insecure.output).toContain("HOME_GATEWAY_INSECURE");
  });

  it("never prints the grant, malformed or unreachable", () => {
    const malformed = runCli(["home", "tasks", "report", "t1", "--json"], {
      RAVI_HOME_GATEWAY_URL: "https://127.0.0.1:1/i/x",
      RAVI_SANDBOX_GRANT: `${grant} extra`,
    });
    expect(malformed.status).toBe(2);
    expect(malformed.output).toContain("HOME_GRANT_INVALID");
    expect(malformed.output).not.toContain("SENTINEL_GRANT_SIG");

    const unreachable = runCli(["home", "tasks", "report", "t1", "--json"], {
      RAVI_HOME_GATEWAY_URL: "https://127.0.0.1:1/i/x",
      RAVI_SANDBOX_GRANT: grant,
    });
    expect(unreachable.status).toBe(1);
    expect(unreachable.output).toContain("HOME_GATEWAY_UNREACHABLE");
    expect(unreachable.output).not.toContain("SENTINEL_GRANT_SIG");
  });
});
