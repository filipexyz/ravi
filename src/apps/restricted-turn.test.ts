import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { which } from "bun";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIsolatedRaviState, cleanupIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent, dbCreateContext, dbUpdateAgent, type ContextRecord } from "../router/router-db.js";
import { authorizeRestrictedAppCommand, hasCallableRestrictedApp, restrictedAppArgv } from "./restricted-turn.js";
import { getAppManifest } from "./service.js";
import { isAppTrusted, trustApp, untrustApp } from "./trust.js";
import { AppsCommands } from "../cli/commands/apps.js";
import { runWithContext } from "../cli/context.js";
import { createBashPermissionHook, createToolPermissionHook } from "../bash/hook.js";
import { logger } from "../utils/logger.js";
import { createCodexRuntimeProvider } from "../runtime/codex-provider.js";
import { ContractError } from "../cli/agent-contract.js";
import { restrictedCodexApprovalCommand, restrictedCodexApprovalPolicy } from "../runtime/codex-provider.js";

let dir: string;
let context: ContextRecord;
let manifestPath: string;
let raviBin: string;
let env: NodeJS.ProcessEnv;
const oldEnv = { ...process.env };
const oldCwd = process.cwd();
const oldArgv = process.argv[1];
const caps = [
  { permission: "use", objectType: "app", objectId: "sample" },
  { permission: "deny_execute", objectType: "executable", objectId: "*" },
];
const key = "rctx_restricted_app_fixture";
function record() {
  return getAppManifest("sample", { cwd: dir, env });
}
function call(command = "ravi apps run sample read --json") {
  return authorizeRestrictedAppCommand(command, context, { cwd: dir, env, raviBin });
}

beforeEach(async () => {
  logger.setLevel("error");
  dir = await createIsolatedRaviState("ravi-restricted-app-");
  process.chdir(dir);
  for (const name of ["RAVI_CONTEXT_KEY", "RAVI_AGENT_ID", "RAVI_SESSION_NAME", "RAVI_SESSION_KEY"])
    delete process.env[name];
  mkdirSync(join(dir, "src/apps/sample"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "dist/bundle"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}');
  raviBin = join(dir, "bin/ravi");
  writeFileSync(raviBin, "#!/bin/sh\nexit 0\n");
  chmodSync(raviBin, 0o700);
  process.argv[1] = join(dir, "src/cli/index.ts");
  env = { ...process.env, HOME: dir, PATH: join(dir, "bin"), RAVI_STATE_DIR: dir, RAVI_CONTEXT_KEY: key };
  manifestPath = join(dir, "src/apps/sample/ravi.app.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: "ravi.app/v1",
      id: "sample",
      name: "Sample",
      version: "1.0.0",
      description: "Fixture",
      interfaces: { cli: { command: "sample" } },
      context: { allow: [] },
      permissions: { required: [], optional: [], mutating: [] },
      sandbox: { callableFromRestrictedTurns: true },
    }),
  );
  dbCreateAgent({ id: "held-app", cwd: dir });
  dbUpdateAgent("held-app", { defaults: { runtimePermissions: { capabilities: ["use:app:sample"] } } });
  context = dbCreateContext({
    contextId: "ctx_held_app",
    contextKey: key,
    kind: "turn-runtime",
    agentId: "held-app",
    capabilities: caps,
    metadata: {
      authorityMode: "delegated",
      actorResolution: "resolved",
      actorAuthorizationMode: "user-overlay",
      userOverlay: "active",
    },
    createdAt: Date.now(),
  });
});
afterEach(async () => {
  process.chdir(oldCwd);
  process.argv[1] = oldArgv!;
  await cleanupIsolatedRaviState(dir);
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  process.exitCode = undefined;
  logger.setLevel("info");
});

describe("restricted app sandbox exception", () => {
  it("requires operator trust and app authority; policy stays never for ordinary turns", () => {
    expect(call().approved).toBe(false);
    expect(restrictedCodexApprovalPolicy(true, env, dir)).toBe("never");
    trustApp(record(), env);
    expect(call().approved).toBe(true);
    expect(call("ravi apps show sample --json").approved).toBe(true);
    expect(call("ravi apps run sample read -- 'a; b | c'").approved).toBe(true);
    expect(hasCallableRestrictedApp(context, { cwd: dir, env })).toBe(true);
    expect(restrictedCodexApprovalPolicy(true, env, dir)).toBe("on-request");
    expect(restrictedCodexApprovalPolicy(false, env, dir)).toBe("never");
    expect(restrictedCodexApprovalPolicy(true, { ...env, RAVI_CONTEXT_KEY: "invalid" }, dir)).toBe("never");
    expect(
      authorizeRestrictedAppCommand(
        "ravi apps show sample",
        { ...context, capabilities: [caps[1]!] },
        { cwd: dir, env, raviBin },
      ).approved,
    ).toBe(false);
    expect(
      authorizeRestrictedAppCommand(
        "ravi apps show sample",
        { ...context, capabilities: [caps[0]!] },
        { cwd: dir, env, raviBin },
      ).approved,
    ).toBe(false);
  });

  it("revokes on manifest edits, explicit untrust, invalidation and path change", () => {
    const app = record();
    trustApp(app, env);
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8") + "\n");
    expect(isAppTrusted(app, env)).toBe(false);
    expect(call().approved).toBe(false);
    trustApp(record(), env);
    expect(call().approved).toBe(true);
    expect(isAppTrusted({ ...record(), path: join(dir, "other.json") }, env)).toBe(false);
    untrustApp("sample", env);
    expect(call().approved).toBe(false);
    const data = JSON.parse(readFileSync(manifestPath, "utf8"));
    data.sandbox.callableFromRestrictedTurns = false;
    writeFileSync(manifestPath, JSON.stringify(data));
    expect(() => trustApp(record(), env)).toThrow();
  });

  for (const command of [
    "ravi apps run sample read | cat",
    "ravi apps show sample > /tmp/out",
    "ravi apps show sample < /tmp/in",
    "ravi apps show sample; id",
    "ravi apps show sample && id",
    "ravi apps show sample || id",
    "ravi apps show sample &",
    "X=1 ravi apps show sample",
    "RAVI_CONTEXT_KEY=x ravi apps show sample",
    "env ravi apps show sample",
    "ravi sessions list",
    "ravi apps trust sample --execute",
    "ravi sample read",
    "ravi apps show other",
    "ravi apps run sample read $(id)",
    "(ravi apps show sample)",
    "ravi apps show sample\nid",
    "ravi apps show $APP",
    "ravi apps run sample read `id`",
    "ravi apps show sample # comment",
    "ravi apps show sample --help",
    "ravi apps run sample read *",
  ])
    it(`refuses ${JSON.stringify(command)}`, () => {
      trustApp(record(), env);
      expect(call(command).approved).toBe(false);
    });

  it("rejects a different executable with the same basename", () => {
    trustApp(record(), env);
    mkdirSync(join(dir, "fake"));
    const fake = join(dir, "fake/ravi");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o700);
    expect(call(`${fake} apps show sample`).approved).toBe(false);
    expect(
      restrictedAppArgv("ravi apps show sample", { env: { ...env, PATH: join(dir, "fake") }, cwd: dir, raviBin }),
    ).toBeNull();
  });

  it("rejects unknown sandbox keys and non-boolean declarations", () => {
    for (const sandbox of [{ callableFromRestrictedTurns: "true" }, { unexpected: true }, true]) {
      const data = JSON.parse(readFileSync(manifestPath, "utf8"));
      data.sandbox = sandbox;
      writeFileSync(manifestPath, JSON.stringify(data));
      expect(record().valid).toBe(false);
    }
  });

  it("only the local operator can trust; gateway and tools cannot mutate even with execute", async () => {
    process.env.RAVI_STATE_DIR = dir;
    const cli = new AppsCommands();
    for (const transport of ["tool", "gateway"] as const) {
      await expect(
        runWithContext({ transport, agentId: "held-app", context }, async () => cli.trust("sample", true, true)),
      ).rejects.toBeInstanceOf(ContractError);
      await expect(
        runWithContext({ transport, agentId: "held-app", context }, async () => cli.untrust("sample", true, true)),
      ).rejects.toBeInstanceOf(ContractError);
    }
    expect(isAppTrusted(record(), env)).toBe(false);
    process.env.RAVI_CONTEXT_KEY = key;
    expect(() => cli.trust("sample", true, true)).toThrow();
    delete process.env.RAVI_CONTEXT_KEY;
    expect(() => cli.trust("sample", false, true)).toThrow();
    expect(cli.trust("sample", true, true).trusted).toBe(true);
    expect(cli.untrust("sample", true, true).trusted).toBe(false);
  });

  it("does not flatten shell argv or accept extra shell arguments", () => {
    expect(restrictedCodexApprovalCommand(["/bin/bash", "-lc", "ravi apps show sample"])).toBe("ravi apps show sample");
    expect(restrictedCodexApprovalCommand(["/tmp/bash", "-lc", "ravi apps show sample"])).toBeNull();
    expect(restrictedCodexApprovalCommand(["/bin/bash", "-lc", "ravi apps show sample", "id"])).toBeNull();
  });
});

function hookDecision(result: Record<string, unknown> | undefined): string | undefined {
  return (result?.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision;
}

it("Bash hook makes only the exact trusted call usable without granting Bash", async () => {
  trustApp(record(), env);
  process.env.PATH = env.PATH;
  const hook = createToolPermissionHook({ getAgentId: () => "held-app" }).hooks[0]!;
  const bash = createBashPermissionHook({ getAgentId: () => "held-app" }).hooks[0]!;
  const check = (command: string, tool_name = "Bash") =>
    runWithContext({ agentId: "held-app", context }, async () => {
      const input = { hook_event_name: "PreToolUse", tool_name, tool_input: { command }, cwd: dir };
      const tool = await hook(input, null, { signal: new AbortController().signal });
      const shell = await bash(input, null, { signal: new AbortController().signal });
      return [tool, shell];
    });
  expect(await check("ravi apps show sample")).toEqual([{}, {}]);
  for (const command of ["ravi apps show sample; id", "ravi apps show other", "ravi sessions list"]) {
    expect(hookDecision((await check(command))[0])).toBe("deny");
  }
  expect(hookDecision((await check("ravi apps show sample", "Write"))[0])).toBe("deny");
  untrustApp("sample", env);
  expect(hookDecision((await check("ravi apps show sample"))[0])).toBe("deny");
});

it("Codex transport approves once, keeps read-only, and refuses unrelated requests even with a permissive fallback", async () => {
  trustApp(record(), env);
  const command = join(dir, "fake-app-server.mjs");
  const transcript = join(dir, "rpc.json");
  const node = which("node")!;
  writeFileSync(
    command,
    `#!${node}
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
const results = {}; let opened, started;
createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'initialize') return send({id:m.id,result:{}});
 if (m.method === 'thread/start') { opened=m.params; return send({id:m.id,result:{thread:{id:'t',turns:[]}}}); }
 if (m.method === 'turn/start') {
  started=m.params; send({id:m.id,result:{turn:{id:'u',status:'inProgress'}}});
  for (const [id,method,params] of [
   ['app','item/commandExecution/requestApproval',{command:['/bin/bash','-lc','ravi apps show sample']}],
   ['compound','item/commandExecution/requestApproval',{command:'ravi apps show sample; id'}],
   ['other','item/commandExecution/requestApproval',{command:'curl https://example.com'}],
   ['file','item/fileChange/requestApproval',{changes:[]}],
   ['permissions','item/permissions/requestApproval',{permissions:{network:true}}],
  ]) send({id,method,params:{threadId:'t',turnId:'u',...params}});
 }
 if (['app','compound','other','file','permissions'].includes(m.id)) {
  results[m.id]=m.result;
  if (Object.keys(results).length===5) {
   writeFileSync(${JSON.stringify(transcript)},JSON.stringify({opened,started,results}));
   send({method:'turn/completed',params:{threadId:'t',turn:{id:'u',status:'completed'}}});
  }
 }
});
`,
  );
  chmodSync(command, 0o700);
  const session = createCodexRuntimeProvider({ command }).startSession({
    cwd: dir,
    env: { ...env, RAVI_CODEX_TRANSPORT: "stdio", RAVI_TURN_HELD_BELOW_AGENT: "1" },
    prompt: (async function* () {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: "test" },
        session_id: "",
        parent_tool_use_id: null,
      };
    })(),
    systemPromptAppend: "",
    abortController: new AbortController(),
    approveRuntimeRequest: async () => ({ approved: true }),
  });
  for await (const _event of session.events) {
    /* drain the real transport */
  }
  const rpc = JSON.parse(readFileSync(transcript, "utf8"));
  expect(rpc.opened.approvalPolicy).toBe("on-request");
  expect(rpc.opened.sandbox).toBe("read-only");
  expect(rpc.started.sandboxPolicy).toEqual({ type: "readOnly" });
  expect(rpc.results.app.decision).toBe("accept");
  for (const id of ["compound", "other", "file"]) expect(rpc.results[id].decision).toBe("deny");
  expect(rpc.results.permissions.permissions).toEqual({});
}, 20_000);
