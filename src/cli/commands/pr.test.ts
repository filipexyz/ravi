import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrCommands } from "./pr.js";
import { buildRegistry } from "../registry-snapshot.js";
import { runWithContext, type ToolContext } from "../context.js";
import { ContractError } from "../agent-contract.js";
import { executePublication } from "../../pr/service.js";
import { publicationFixture } from "../../pr/test-fixture.js";
import {
  createIsolatedRaviState,
  cleanupIsolatedRaviState,
  RAVI_RUNTIME_CONTEXT_ENV_KEYS,
} from "../../test/ravi-state.js";

let state: string | null = null;
let f: ReturnType<typeof publicationFixture>;
let savedEnv: Record<string, string | undefined>;
beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-pr-command-");
  savedEnv = Object.fromEntries(RAVI_RUNTIME_CONTEXT_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RAVI_RUNTIME_CONTEXT_ENV_KEYS) delete process.env[key];
  f = publicationFixture();
});
afterEach(async () => {
  f?.close();
  await cleanupIsolatedRaviState(state);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function context(allowed = true): ToolContext {
  const publisher = f.input().context;
  return {
    ...publisher,
    transport: "gateway",
    cwd: f.cwd,
    suppressCliOutput: true,
    context: {
      contextId: "ctx_pr_test",
      contextKey: "rctx_pr_test",
      kind: "turn-runtime",
      agentId: "test",
      sessionKey: publisher.sessionKey,
      createdAt: 0,
      capabilities: allowed
        ? [
            { permission: "execute", objectType: "group", objectId: "pr", source: "test" },
            { permission: "mutate", objectType: "pr", objectId: "publish", source: "test" },
            { permission: "use", objectType: "tool", objectId: "Read", source: "test" },
          ]
        : [],
    },
  };
}
function command() {
  return new PrCommands({
    context: () => f.input().context,
    github: () => f.request,
    health: async () => {},
    execute: (plan, request, options) => executePublication(plan, request, { ...f.options, ...options }),
  });
}
async function invoke(execute = false, dryRun = false, allowed = true) {
  const bodyPath = join(f.root, "body.md");
  writeFileSync(bodyPath, "Validation: focused tests.\n");
  // A path relative to the caller worktree, which differs from the daemon cwd.
  return runWithContext(context(allowed), () =>
    command().publish("o/r", "dev", "Fix publication", "../body.md", f.sha(), undefined, dryRun, true, execute),
  );
}

describe("pr publish CLI contract", () => {
  it("is a typed gateway command with explicit mutation authority and execute last", () => {
    const entry = buildRegistry([PrCommands]).commands[0]!;
    expect(entry.cliOnly).not.toBe(true);
    expect(entry.returns).toBeDefined();
    expect(entry.access).toMatchObject({ kind: "mutate", resource: "pr", action: "publish", risk: "high" });
    expect(entry.options.find((opt) => opt.name === "execute")?.index).toBe(8);
  });
  it("defaults to a typed exit-3 preview with no HTTP writes, journal, PR or follow", async () => {
    for (const dryRun of [false, true]) {
      const error = await invoke(false, dryRun).catch((error) => error);
      expect(error).toBeInstanceOf(ContractError);
      expect(error).toMatchObject({
        exitCode: 3,
        details: { dryRun: true, plan: { repo: "o/r", head: "fix/publish", localSha: f.sha() } },
      });
    }
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(f.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(0);
    expect(f.triggers).toHaveLength(0);
    expect(f.pr()).toBeNull();
  });
  it("denies before reading the worktree or performing HTTP, even with execute", async () => {
    await expect(invoke(true, false, false)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(f.calls).toHaveLength(0);
  });
  it("rejects conflicting flags and missing gateway cwd before IO", async () => {
    await expect(invoke(true, true)).rejects.toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    await expect(
      runWithContext({ ...context(), cwd: undefined }, () => command().publish("o/r", "dev")),
    ).rejects.toMatchObject({ code: "CALLER_CWD_REQUIRED" });
    expect(f.calls).toHaveLength(0);
  });
  it("executes the same flow through a gateway context and satisfies the registered return schema", async () => {
    const result = await invoke(true);
    const schema = buildRegistry([PrCommands]).commands[0]!.returns!;
    expect(schema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ localSha: f.sha(), pr: { ready: true }, follow: { replySession: "publisher" } });
    expect(f.triggers).toHaveLength(1);
  });
});
