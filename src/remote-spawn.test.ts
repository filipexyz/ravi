import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync, type ChildProcess } from "node:child_process";
import { buildRemoteEnvSetup, createRemoteSpawn, type RemoteSpawnImpl } from "./remote-spawn.js";

const OAUTH = "sk-ant-oat01-secret-oauth-'quoted'";
const API_KEY = "sk-ant-secret-api";

type SpawnCall = { command: string; args: string[]; env: Record<string, string> };

function createFakeSpawn() {
  const calls: SpawnCall[] = [];
  const stdinChunks: string[] = [];

  const spawnImpl: RemoteSpawnImpl = (command, args, options) => {
    calls.push({ command, args, env: { ...(options.env as Record<string, string>) } });
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdin = new PassThrough();
    stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk.toString()));
    Object.assign(child, {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 4242,
      kill: () => true,
    });
    return child;
  };

  return { spawnImpl, calls, stdinChunks };
}

function spawnOptions(env: Record<string, string | undefined>) {
  return {
    command: "bun",
    args: ["/local/cli.js", "--model", "sonnet", "--plugin-dir", "/local/plugins"],
    cwd: "/srv/work",
    env,
    signal: new AbortController().signal,
  } as any;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("createRemoteSpawn credentials", () => {
  it("never puts credential values in the ssh argv or child env", () => {
    const { spawnImpl, calls } = createFakeSpawn();
    createRemoteSpawn(
      "201",
      "root",
      spawnImpl,
      {},
    )(spawnOptions({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: API_KEY, HOME: "/home/test" }));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("ssh");
    expect(call.args).toContain("root@10.10.10.201");
    for (const arg of call.args) {
      expect(arg).not.toContain("sk-ant");
    }
    expect(JSON.stringify(call.env)).not.toContain("sk-ant");

    const remoteCmd = call.args[call.args.length - 1]!;
    expect(remoteCmd).toBe(
      "cd '/srv/work' && " +
        "IFS= read -r CLAUDE_CODE_OAUTH_TOKEN && export CLAUDE_CODE_OAUTH_TOKEN && " +
        "IFS= read -r ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY && " +
        "claude '--model' 'sonnet'",
    );
  });

  it("writes credential values to stdin first, in key order, before SDK writes", async () => {
    const { spawnImpl, stdinChunks } = createFakeSpawn();
    const child = createRemoteSpawn(
      "vm.example",
      "ravi",
      spawnImpl,
      {},
    )(spawnOptions({ ANTHROPIC_API_KEY: API_KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH }));

    child.stdin.write('{"type":"user"}\n');
    await flush();

    expect(stdinChunks.join("")).toBe(`${OAUTH}\n${API_KEY}\n{"type":"user"}\n`);
  });

  it("refuses to spawn when a credential value contains a newline or carriage return", () => {
    for (const bad of ["tok\nen", "tok\ren"]) {
      const { spawnImpl, calls } = createFakeSpawn();
      const spawnFn = createRemoteSpawn("201", "root", spawnImpl, {});
      expect(() => spawnFn(spawnOptions({ CLAUDE_CODE_OAUTH_TOKEN: bad }))).toThrow(/newline/);
      expect(calls).toHaveLength(0);
    }
  });

  it("adds no read prefix and writes nothing when no credentials are present", async () => {
    const { spawnImpl, calls, stdinChunks } = createFakeSpawn();
    createRemoteSpawn("201", "root", spawnImpl, {})(spawnOptions({ HOME: "/home/test" }));
    await flush();

    const remoteCmd = calls[0]!.args[calls[0]!.args.length - 1]!;
    expect(remoteCmd).not.toContain("read -r");
    expect(remoteCmd).toBe("cd '/srv/work' && claude '--model' 'sonnet'");
    expect(stdinChunks).toEqual([]);
  });

  it("sends scoped context and the gateway URL over stdin too, never argv", async () => {
    const { spawnImpl, calls, stdinChunks } = createFakeSpawn();
    createRemoteSpawn("localhost", "root", spawnImpl, { RAVI_HTTP_PORT: "7777" })(
      spawnOptions({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH, RAVI_CONTEXT_KEY: "rctx_secret-context" }),
    );
    await flush();

    const remoteCmd = calls[0]!.args[calls[0]!.args.length - 1]!;
    expect(remoteCmd).toBe(
      "cd '/srv/work' && " +
        "IFS= read -r CLAUDE_CODE_OAUTH_TOKEN && export CLAUDE_CODE_OAUTH_TOKEN && " +
        "IFS= read -r RAVI_CONTEXT_KEY && export RAVI_CONTEXT_KEY && " +
        "IFS= read -r RAVI_GATEWAY_URL && export RAVI_GATEWAY_URL && " +
        "claude '--model' 'sonnet'",
    );
    for (const arg of calls[0]!.args) {
      expect(arg).not.toContain("rctx_secret-context");
      expect(arg).not.toContain("7777");
    }
    expect(stdinChunks.join("")).toBe(`${OAUTH}\nrctx_secret-context\nhttp://127.0.0.1:7777\n`);
  });
});

const keys = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "RAVI_CONTEXT_KEY", "RAVI_GATEWAY_URL"];

/** Run the remote read prefix in a real shell, feed its stdin, and read the forwarded values. */
function readRemoteEnv(
  env: Record<string, string>,
  host = "127.0.0.1",
  hostEnv: Record<string, string | undefined> = {},
) {
  const setup = buildRemoteEnvSetup(host, env, hostEnv);
  const probe = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]??null]))))`;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const result = spawnSync("/bin/sh", ["-c", `${setup.prefix}exec ${quote(process.execPath)} -e ${quote(probe)}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    input: setup.stdin,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string | null>;
}

describe("SSH remote runtime environment", () => {
  it("preserves a single credential without appending a literal newline escape", () => {
    expect(readRemoteEnv({ CLAUDE_CODE_OAUTH_TOKEN: "synthetic-token" }).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "synthetic-token",
    );
  });

  it("preserves auth, scoped context and gateway byte-for-byte through a real shell", () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: "  synthetic-'token' $HOME `false` $(false)\\n \\ trailing  ",
      ANTHROPIC_API_KEY: "synthetic-api-key",
      RAVI_CONTEXT_KEY: "synthetic-context",
      RAVI_GATEWAY_URL: "https://gateway.example:7777",
    };
    expect(readRemoteEnv(env)).toEqual(env);
  });

  it("refuses values that cannot be framed as one stdin line", () => {
    for (const key of keys) {
      expect(() => buildRemoteEnvSetup("worker.example", { [key]: "first\nsecond" }, {})).toThrow(/newline/);
    }
  });

  it("forwards only the allowlisted runtime variables and never puts values in the command", () => {
    const setup = buildRemoteEnvSetup(
      "worker.example",
      { RAVI_CONTEXT_KEY: "synthetic", UNRELATED_SECRET: "not-forwarded" },
      {},
    );
    expect(setup.prefix).toBe("IFS= read -r RAVI_CONTEXT_KEY && export RAVI_CONTEXT_KEY && ");
    expect(setup.prefix).not.toContain("synthetic");
    expect(setup.stdin).toBe("synthetic\n");
    expect(setup.prefix + setup.stdin).not.toContain("UNRELATED_SECRET");
    expect(setup.prefix + setup.stdin).not.toContain("not-forwarded");
    expect(buildRemoteEnvSetup("worker.example", { UNRELATED_SECRET: "not-forwarded" }, {})).toEqual({
      prefix: "",
      stdin: "",
      keys: [],
    });
  });

  it("derives a gateway only for loopback SSH hosts with an enabled HTTP server", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(readRemoteEnv({}, host, { RAVI_HTTP_PORT: "7777" }).RAVI_GATEWAY_URL).toBe("http://127.0.0.1:7777");
    }
    expect(readRemoteEnv({}, "worker.example", { RAVI_HTTP_PORT: "7777" }).RAVI_GATEWAY_URL).toBeNull();
    for (const port of ["", "0", "-1", "65536", "not-a-port"]) {
      expect(readRemoteEnv({}, "127.0.0.1", { RAVI_HTTP_PORT: port }).RAVI_GATEWAY_URL).toBeNull();
    }
  });

  it("respects explicit gateway URLs before deriving one from the daemon", () => {
    expect(
      readRemoteEnv({ RAVI_GATEWAY_URL: "https://explicit.example" }, "127.0.0.1", { RAVI_HTTP_PORT: "7777" })
        .RAVI_GATEWAY_URL,
    ).toBe("https://explicit.example");
    expect(readRemoteEnv({}, "worker.example", { RAVI_GATEWAY_URL: "https://daemon.example" }).RAVI_GATEWAY_URL).toBe(
      "https://daemon.example",
    );
    expect(
      readRemoteEnv({}, "localhost", { RAVI_WEBHOOK_PORT: "7777", RAVI_WEBHOOK_HOST: "::1" }).RAVI_GATEWAY_URL,
    ).toBe("http://[::1]:7777");
  });

  it("does not revive the webhook port alias when the HTTP port is explicitly disabled", () => {
    for (const port of ["", "   "]) {
      expect(
        readRemoteEnv({}, "localhost", { RAVI_HTTP_PORT: port, RAVI_WEBHOOK_PORT: "7777" }).RAVI_GATEWAY_URL,
      ).toBeNull();
    }
  });

  it("normalizes the preferred listener host and its alias before selecting IPv6", () => {
    for (const hostEnv of [
      { RAVI_HTTP_PORT: "7777", RAVI_HTTP_HOST: " ::1 " },
      { RAVI_HTTP_PORT: "7777", RAVI_WEBHOOK_HOST: " ::1 " },
      { RAVI_HTTP_PORT: "7777", RAVI_HTTP_HOST: "   ", RAVI_WEBHOOK_HOST: " ::1 " },
    ]) {
      expect(readRemoteEnv({}, "localhost", hostEnv).RAVI_GATEWAY_URL).toBe("http://[::1]:7777");
    }
  });
});
