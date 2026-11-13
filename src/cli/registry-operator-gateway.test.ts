import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_CLI_GATEWAY_ENV, HOST_CLI_GATEWAY_INTERNAL_ENV } from "../isolation/execution-plane.js";
import { nats } from "../nats.js";
import * as pm2 from "../pm2.js";
import { ChannelsCommands } from "./commands/channels.js";
import { DaemonCommands } from "./commands/daemon.js";
import { getContext } from "./context.js";
import { Command, CommandAccess, Group, Option } from "./decorators.js";
import * as operatorRuntime from "./operator-runtime.js";
import { registerCommands } from "./registry.js";

let stateDir: string;
let server: Server | undefined;
let handlerCalls: string[];
let output: string[];
let savedEnv: NodeJS.ProcessEnv;

@Group({ name: "tasks", description: "Stateful fixture", scope: "admin" })
class StatefulCommands {
  @Command({ name: "list", description: "List through gateway" })
  @CommandAccess({ kind: "read", resource: "tasks", action: "list", risk: "low" })
  list(@Option({ flags: "--json", description: "JSON output" }) _json?: boolean) {
    handlerCalls.push("stateful");
    throw new Error("Stateful commands must run in the daemon");
  }
}

@Group({ name: "daemon", description: "Recovery fixture", scope: "admin" })
class RecoveryCommands {
  @Command({ name: "status", description: "Inspect without a database" })
  @CommandAccess({ kind: "read", resource: "daemon", action: "status", risk: "low" })
  status(@Option({ flags: "--json", description: "JSON output" }) _json?: boolean) {
    handlerCalls.push("status");
    expect(getContext()).toEqual({});
  }

  @Command({ name: "restart", description: "Recovery execution fixture" })
  @CommandAccess({ kind: "mutate", resource: "daemon", action: "restart", risk: "high" })
  restart(@Option({ flags: "--json", description: "JSON output" }) _json?: boolean) {
    handlerCalls.push("restart");
    expect(getContext()).toEqual({});
  }
}

beforeEach(() => {
  savedEnv = { ...process.env };
  stateDir = mkdtempSync(join(tmpdir(), "ravi-operator-gateway-"));
  process.env.RAVI_STATE_DIR = stateDir;
  process.env.RAVI_CREDENTIALS_PATH = join(stateDir, "credentials.json");
  process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
  for (const key of ["RAVI_CONTEXT_KEY", "RAVI_GATEWAY_URL", HOST_CLI_GATEWAY_ENV, HOST_CLI_GATEWAY_INTERNAL_ENV]) {
    delete process.env[key];
  }
  writeFileSync(
    process.env.RAVI_CREDENTIALS_PATH,
    JSON.stringify({
      version: 1,
      default: "rctx_operator_fixture",
      contexts: {
        rctx_operator_fixture: {
          context_id: "ctx_fixture",
          agent_id: "fixture",
          label: "fixture",
          kind: "admin-bootstrap",
          issued_at: 0,
          expires_at: null,
        },
      },
    }),
    { mode: 0o600 },
  );
  // Provenance and real-state selection are covered separately; exercise the
  // installed routing branch with an isolated socket and credential here.
  spyOn(operatorRuntime, "usesInstalledOperatorTransport").mockImplementation(
    () => !process.env.RAVI_CONTEXT_KEY && !process.env.RAVI_GATEWAY_URL,
  );
  handlerCalls = [];
  output = [];
  spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
  spyOn(console, "error").mockImplementation((value) => output.push(String(value)));
  spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`fixture_exit_${code}`);
  });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
  mock.restore();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(stateDir, { recursive: true, force: true });
});

function execute(group: string, command: string) {
  const program = new CommanderCommand();
  program.exitOverride();
  registerCommands(program, [StatefulCommands, RecoveryCommands]);
  return program.parseAsync(["bun", "fixture", group, command, "--json"]);
}

describe("installed operator gateway and offline recovery", () => {
  it.each(["daemon", "channels"])("runs the real %s status handler offline without SQLite", async (group) => {
    const pm2Available = spyOn(pm2, "isPm2Available").mockReturnValue(false);
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [DaemonCommands, ChannelsCommands]);
    await program.parseAsync(["bun", "fixture", group, "status", "--json"]);
    expect(pm2Available).toHaveBeenCalled();
    expect(output.join("\n")).toContain('"pm2Available": false');
    expect(existsSync(join(stateDir, "ravi.db"))).toBe(false);
  });

  it("uses the existing credential on the Unix gateway without opening local state", async () => {
    let requests = 0;
    server = createServer((request, response) => {
      requests++;
      expect(request.url).toBe("/api/v1/tasks/list");
      expect(request.headers.authorization).toBe("Bearer rctx_operator_fixture");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ items: [] }));
    });
    await new Promise<void>((resolve) => server!.listen(join(stateDir, "cli-gateway.sock"), resolve));
    await execute("tasks", "list");
    expect(requests).toBe(1);
    expect(handlerCalls).toEqual([]);
    expect(existsSync(join(stateDir, "ravi.db"))).toBe(false);
  });

  it.each(["status", "restart"])("keeps daemon %s available offline without SQLite", async (command) => {
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const emit = spyOn(nats, "emit").mockResolvedValue(undefined);
    spyOn(nats, "close").mockResolvedValue(undefined);
    await execute("daemon", command);
    expect(handlerCalls).toEqual([command]);
    expect(emit).toHaveBeenCalledWith(
      `ravi._cli.cli.daemon.${command}`,
      expect.objectContaining({ outcome: "succeeded", cliInvocation: expect.any(Object) }),
      { quietConnect: true },
    );
    expect(existsSync(join(stateDir, "ravi.db"))).toBe(false);
  });

  it("preserves gateway authorization denial without trying the local handler", async () => {
    server = createServer((_request, response) => {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          success: false,
          op: "tasks list",
          exitCode: 1,
          outcome: "denied",
          error: { code: "PERMISSION_DENIED", message: "Denied", retryable: false },
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(join(stateDir, "cli-gateway.sock"), resolve));
    await expect(execute("tasks", "list")).rejects.toThrow("fixture_exit_1");
    expect(output.join("\n")).toContain("PERMISSION_DENIED");
    expect(handlerCalls).toEqual([]);
    expect(existsSync(join(stateDir, "ravi.db"))).toBe(false);
  });

  it("fails stateful commands closed when the installed gateway is absent", async () => {
    await expect(execute("tasks", "list")).rejects.toThrow("fixture_exit_1");
    expect(output.join("\n")).toContain("GATEWAY_REQUIRED");
    expect(handlerCalls).toEqual([]);
    expect(existsSync(join(stateDir, "ravi.db"))).toBe(false);
  });

  it("never uses offline recovery for a runtime context", async () => {
    process.env.RAVI_CONTEXT_KEY = "rctx_runtime_fixture";
    await expect(execute("daemon", "restart")).rejects.toThrow("fixture_exit_1");
    expect(output.join("\n")).toContain("GATEWAY_REQUIRED");
    expect(handlerCalls).toEqual([]);
    expect(existsSync(join(stateDir, "ravi.db"))).toBe(false);
  });

  it("preserves an explicit gateway failure instead of falling back to local recovery", async () => {
    process.env.RAVI_GATEWAY_URL = `unix://${join(stateDir, "missing.sock")}`;
    await expect(execute("daemon", "restart")).rejects.toThrow("fixture_exit_1");
    expect(output.join("\n")).toContain("SERVER_UNAVAILABLE");
    expect(handlerCalls).toEqual([]);
    expect(existsSync(join(stateDir, "ravi.db"))).toBe(false);
  });
});
