import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { ContextCredentialsCommands } from "./commands/context.js";
import * as operatorRuntime from "./operator-runtime.js";
import { registerCommands } from "./registry.js";

let stateDir: string | null = null;
let clientPath: string;
let savedEnv: NodeJS.ProcessEnv;
let output: string[];

beforeEach(async () => {
  savedEnv = { ...process.env };
  stateDir = await createIsolatedRaviState("ravi-cc-offline-");
  clientPath = join(stateDir, "client-credentials.json");
  for (const key of ["RAVI_CONTEXT_KEY", "RAVI_GATEWAY_URL", "RAVI_SESSION_KEY", "RAVI_SESSION_NAME", "RAVI_AGENT_ID"])
    delete process.env[key];
  process.env.RAVI_CREDENTIALS_PATH = clientPath;
  process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
  // The operator's terminal on the state this fixture selected. Provenance is covered in operator-runtime.test.ts.
  spyOn(operatorRuntime, "usesOperatorRecoveryPath").mockImplementation(() => true);
  output = [];
  spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
  spyOn(console, "error").mockImplementation((value) => output.push(String(value)));
  spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`fixture_exit_${code}`);
  });
});

afterEach(async () => {
  mock.restore();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function add(contextKey: string) {
  const program = new CommanderCommand();
  program.exitOverride();
  registerCommands(program, [ContextCredentialsCommands]);
  return program.parseAsync([
    "bun",
    "fixture",
    "context",
    "credentials",
    "add",
    contextKey,
    "--label",
    "terminal",
    "--set-default",
    "--json",
  ]);
}

describe("the operator's terminal adds a credential with the daemon stopped", () => {
  it("checks the key against the state on this machine and stores it in the client file", async () => {
    // No gateway socket in this state directory: the daemon is not running.
    const record = createRuntimeContext({ kind: "admin-bootstrap", agentId: "main", ttlMs: 0 });

    await add(record.contextKey);

    const store = JSON.parse(readFileSync(clientPath, "utf8"));
    expect(store.default).toBe(record.contextKey);
    expect(store.contexts[record.contextKey]).toMatchObject({
      context_id: record.contextId,
      agent_id: "main",
      label: "terminal",
      kind: "admin-bootstrap",
    });
  });

  it("stores nothing for a key this machine does not know, and never prints it", async () => {
    const unknown = "rctx_never_issued_here";
    await expect(add(unknown)).rejects.toThrow("fixture_exit_1");
    expect(() => readFileSync(clientPath, "utf8")).toThrow();
    expect(output.join("\n")).not.toContain(unknown);
  });
});
