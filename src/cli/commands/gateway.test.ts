/**
 * `ravi gateway`: the hidden, CLI-only `tunnel-run` PM2 entry point and the
 * `ravi-gateway` PM2 registration. The runner itself (credentials only in
 * cloudflared's env, drift latch) is covered in
 * `src/gateway-expose/tunnel-runner.test.ts`; here the command wiring runs for
 * real against an isolated state dir and must refuse without settings or
 * credentials, never spawning anything.
 */
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { buildPm2Env, GATEWAY_PM2_PROCESS_NAME } from "../../pm2.js";
import {
  buildGatewayRunnerPm2Args,
  GATEWAY_PM2_KILL_TIMEOUT_MS,
  startGatewayRunnerPm2,
} from "../../gateway-expose/pm2.js";
import { TUNNEL_RUNNER_EXIT_REFUSED } from "../../gateway-expose/tunnel-runner.js";
import { buildRouteTable } from "../../sdk/gateway/route-table.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { buildRegistry } from "../registry-snapshot.js";
import { registerCommands } from "../registry.js";
import { GatewayCommands } from "./gateway.js";

let stateDir: string;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gateway-cmd-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

describe("gateway tunnel-run registration", () => {
  test("is CLI-only (no SDK route), admin-scoped and hidden from help", () => {
    const registry = buildRegistry([GatewayCommands]);
    const entry = registry.commands.find((command) => command.fullName === "gateway.tunnel-run");
    expect(entry).toMatchObject({ cliOnly: true, scope: "admin", access: { resource: "gateway", risk: "high" } });
    expect(buildRouteTable(registry).byPath.size).toBe(0);

    const program = new CommanderCommand("ravi");
    registerCommands(program, [GatewayCommands]);
    const group = program.commands.find((command) => command.name() === "gateway")!;
    expect(group.commands.map((command) => command.name())).toContain("tunnel-run");
    expect(group.helpInformation()).not.toContain("tunnel-run");
  });

  test("refuses with exit 78 when the gateway is not configured, without spawning cloudflared", async () => {
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(new GatewayCommands().tunnelRun()).rejects.toThrow(`exit:${TUNNEL_RUNNER_EXIT_REFUSED}`);
      expect(errors.mock.calls.flat().join(" ")).toContain("gateway_not_configured");
    } finally {
      exit.mockRestore();
      errors.mockRestore();
    }
  });
});

describe("ravi-gateway PM2 registration", () => {
  test("starts `gateway tunnel-run` with a stop code and kill timeout, and no credentials in argv or env", () => {
    const calls: Array<{ args: string[]; env: Record<string, string>; cwd?: string }> = [];
    const result = startGatewayRunnerPm2(
      { bundlePath: "/opt/ravi/dist/bundle/index.js", cwd: "/opt/ravi" },
      {
        exists: () => true,
        baseEnv: {
          PATH: "/usr/bin",
          TUNNEL_TOKEN: "eyJ-token",
          TUNNEL_CRED_CONTENTS: '{"TunnelSecret":"s3cr3t"}',
          RAVI_CONTEXT_KEY: "rctx_x",
        },
        runPm2: (args, options) => {
          calls.push({ args, env: options.env, cwd: options.cwd });
          return { status: 0 };
        },
      },
    );
    expect(result).toEqual({ status: 0, saveStatus: 0 });
    expect(calls.map((call) => call.args)).toEqual([
      ["delete", GATEWAY_PM2_PROCESS_NAME],
      buildGatewayRunnerPm2Args({ bundlePath: "/opt/ravi/dist/bundle/index.js" }),
      ["save", "--force"],
    ]);
    expect(calls[1]!.args).toEqual([
      "start",
      "bun",
      "--name",
      "ravi-gateway",
      "--kill-timeout",
      String(GATEWAY_PM2_KILL_TIMEOUT_MS),
      "--stop-exit-codes",
      "78",
      "--",
      "/opt/ravi/dist/bundle/index.js",
      "gateway",
      "tunnel-run",
    ]);
    expect(calls[1]!.cwd).toBe("/opt/ravi");
    for (const call of calls) {
      expect(call.env.TUNNEL_TOKEN).toBeUndefined();
      expect(call.env.TUNNEL_CRED_CONTENTS).toBeUndefined();
      expect(call.env.RAVI_CONTEXT_KEY).toBeUndefined();
      expect(JSON.stringify(call)).not.toContain("s3cr3t");
    }
  });

  test("buildPm2Env drops tunnel credentials from any PM2 entry", () => {
    const env = buildPm2Env(undefined, { PATH: "/bin", TUNNEL_TOKEN: "t", TUNNEL_CRED_CONTENTS: "c" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
