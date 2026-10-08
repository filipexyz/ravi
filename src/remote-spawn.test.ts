import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createRemoteSpawn, type RemoteSpawnImpl } from "./remote-spawn.js";

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
    )(spawnOptions({ ANTHROPIC_API_KEY: API_KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH }));

    child.stdin.write('{"type":"user"}\n');
    await flush();

    expect(stdinChunks.join("")).toBe(`${OAUTH}\n${API_KEY}\n{"type":"user"}\n`);
  });

  it("refuses to spawn when a credential value contains a newline or carriage return", () => {
    for (const bad of ["tok\nen", "tok\ren"]) {
      const { spawnImpl, calls } = createFakeSpawn();
      const spawnFn = createRemoteSpawn("201", "root", spawnImpl);
      expect(() => spawnFn(spawnOptions({ CLAUDE_CODE_OAUTH_TOKEN: bad }))).toThrow(/newline/);
      expect(calls).toHaveLength(0);
    }
  });

  it("adds no read prefix and writes nothing when no credentials are present", async () => {
    const { spawnImpl, calls, stdinChunks } = createFakeSpawn();
    createRemoteSpawn("201", "root", spawnImpl)(spawnOptions({ HOME: "/home/test" }));
    await flush();

    const remoteCmd = calls[0]!.args[calls[0]!.args.length - 1]!;
    expect(remoteCmd).not.toContain("read -r");
    expect(remoteCmd).toBe("cd '/srv/work' && claude '--model' 'sonnet'");
    expect(stdinChunks).toEqual([]);
  });
});
