import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrCommands } from "./pr.js";
import { buildRegistry } from "../registry-snapshot.js";
import { runWithContext, type ToolContext } from "../context.js";
import { ContractError } from "../agent-contract.js";
import { enforceCliCommandAuthorization } from "../command-access.js";
import { resolvePublicationContext } from "../../pr/context.js";
import { PUBLICATION_CONTEXT_REQUIRED_MESSAGE } from "../../pr/contracts.js";
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
    expect(entry.access).toMatchObject({
      kind: "mutate",
      resource: "pr",
      action: "publish",
      risk: "high",
      localOperator: true,
    });
    expect(entry.options.find((opt) => opt.name === "execute")?.index).toBe(8);
    expect(entry.options.find((opt) => opt.name === "replySession")?.index).toBe(5);
  });
  it("admits the operator's terminal at command admission, and still no unresolved runtime principal", () => {
    const entry = buildRegistry([PrCommands]).commands[0]!;
    const admit = (source: "cli" | "gateway") =>
      runWithContext({}, () =>
        enforceCliCommandAuthorization({
          group: "pr",
          command: "publish",
          scope: "open",
          access: entry.access,
          source,
          input: { repo: "o/r", base: "dev", replySession: "publisher", execute: true },
        }),
      );
    expect(admit("cli").allowed).toBe(true);
    expect(admit("gateway").allowed).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it("refuses a runtime context with no authenticated session before any IO, whatever --reply-session names", async () => {
    let effects = 0;
    const unexpected = () => {
      effects++;
      throw new Error("unexpected IO");
    };
    const guarded = new PrCommands({
      context: unexpected,
      github: unexpected,
      health: unexpected,
      execute: unexpected,
    });
    const authenticated = context();
    const invalid: ToolContext[] = [
      { transport: "gateway" },
      { transport: "tool", agentId: "test", sessionKey: "agent:test:publisher" },
      // A gateway context that holds the publish capability but belongs to no session.
      { ...authenticated, context: { ...authenticated.context!, sessionKey: undefined, sessionName: undefined } },
    ];
    process.env.RAVI_AGENT_ID = "test";
    process.env.RAVI_SESSION_KEY = "agent:test:publisher";
    for (const candidate of invalid) {
      for (const replySession of [undefined, "publisher", "agent:test:publisher"]) {
        for (const execute of [false, true]) {
          await expect(
            runWithContext(candidate, () =>
              guarded.publish(
                "o/r",
                "dev",
                "Test",
                "/does-not-exist/body.md",
                undefined,
                replySession,
                false,
                true,
                execute,
              ),
            ),
          ).rejects.toMatchObject({
            code: "PERMISSION_DENIED",
            exitCode: 1,
            message: PUBLICATION_CONTEXT_REQUIRED_MESSAGE,
          });
        }
      }
    }
    expect(effects).toBe(0);
    expect(f.calls).toHaveLength(0);
    expect(f.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(0);
    expect(f.triggers).toHaveLength(0);
  });
  it("refuses the terminal with no destination, or a destination that is not there, before body, GitHub, health or journal IO", async () => {
    let effects = 0;
    const unexpected = () => {
      effects++;
      throw new Error("unexpected IO");
    };
    const guarded = new PrCommands({
      context: resolvePublicationContext,
      github: unexpected,
      health: unexpected,
      execute: unexpected,
    });
    const authenticated = context();
    // No transport: the terminal, with or without a stored default credential.
    // Session names left in the environment or in that credential are not a destination.
    const terminals: ToolContext[] = [
      {},
      { ...authenticated, transport: undefined, contextOrigin: "default-credential" },
    ];
    process.env.RAVI_AGENT_ID = "test";
    process.env.RAVI_SESSION_KEY = "agent:test:publisher";
    for (const terminal of terminals) {
      for (const execute of [false, true]) {
        await expect(
          runWithContext(terminal, () =>
            guarded.publish(
              "o/r",
              "dev",
              "Test",
              "/does-not-exist/body.md",
              undefined,
              undefined,
              false,
              true,
              execute,
            ),
          ),
        ).rejects.toMatchObject({ code: "PUBLICATION_SESSION_REQUIRED", exitCode: 2 });
        await expect(
          runWithContext(terminal, () =>
            guarded.publish(
              "o/r",
              "dev",
              "Test",
              "/does-not-exist/body.md",
              undefined,
              "no-such-session",
              false,
              true,
              execute,
            ),
          ),
        ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND", exitCode: 1 });
      }
    }
    expect(effects).toBe(0);
    expect(f.calls).toHaveLength(0);
    expect(f.triggers).toHaveLength(0);
  });
  it("publishes from the operator's terminal into the session it names, recorded as the local operator", async () => {
    const bodyPath = join(f.root, "body.md");
    writeFileSync(bodyPath, "Validation: focused tests.\n");
    const terminal: ToolContext = { cwd: f.cwd };
    const publish = (execute: boolean) =>
      runWithContext(terminal, () =>
        command().publish("o/r", "dev", "Fix publication", "../body.md", f.sha(), "publisher", false, true, execute),
      );

    await expect(publish(false)).rejects.toMatchObject({ exitCode: 3, details: { dryRun: true } });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);

    const result = await publish(true);
    expect(result).toMatchObject({ localSha: f.sha(), pr: { ready: true }, follow: { replySession: "publisher" } });
    const event = f.db.query("SELECT detail_json FROM pr_publication_events ORDER BY id LIMIT 1").get() as {
      detail_json: string;
    };
    expect(JSON.parse(event.detail_json)).toMatchObject({
      contextId: null,
      actor: "local-operator",
      executorAgentId: null,
      sessionKey: "agent:test:publisher",
    });
  });
  it("refuses expired and revoked session contexts before publication IO", async () => {
    for (const ended of [{ expiresAt: 1 }, { revokedAt: 1 }]) {
      const authenticated = context();
      await expect(
        runWithContext({ ...authenticated, context: { ...authenticated.context!, ...ended } }, () =>
          command().publish("o/r", "dev", "Test", "/does-not-exist/body.md", undefined, undefined, false, true, true),
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    expect(f.calls).toHaveLength(0);
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
    const event = f.db.query("SELECT detail_json FROM pr_publication_events ORDER BY id LIMIT 1").get() as {
      detail_json: string;
    };
    expect(JSON.parse(event.detail_json)).toMatchObject({
      contextId: "ctx_pr_test",
      actor: "agent:test",
      executorAgentId: "test",
      sessionKey: "agent:test:publisher",
    });
    expect(event.detail_json).not.toContain("rctx_");
  });
});
