import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { type Destination } from "./destinations.js";
import {
  preflightRemote,
  remoteRequestStatus,
  storeRemoteSecret,
  type RemoteSshProcess,
  type RemoteSshSpawn,
  type RemoteStoreInput,
} from "./ssh.js";

const canary = 'TEST_ONLY_REMOTE_SECRET_"$\\_CANARY';
const version = "a".repeat(64);
const nonce = "b".repeat(64);
const receipt = "c".repeat(64);
const stored = { v: 1, status: "stored", receipt, version: "d".repeat(64) } as const;
let root: string;
let dest: Destination;
let request: RemoteStoreInput;

class FakeSsh extends EventEmitter implements RemoteSshProcess {
  stdout = new PassThrough();
  stdin: Writable;
  frames: Record<string, unknown>[] = [];
  killed = false;
  pending = "";
  constructor(handle: (frame: Record<string, unknown>, process: FakeSsh) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.pending += chunk.toString();
        let end = this.pending.indexOf("\n");
        while (end !== -1) {
          const frame = JSON.parse(this.pending.slice(0, end));
          this.pending = this.pending.slice(end + 1);
          this.frames.push(frame);
          queueMicrotask(() => handle(frame, this));
          end = this.pending.indexOf("\n");
        }
        callback();
      },
    });
  }
  reply(value: unknown) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
  close(code = 0) {
    this.emit("close", code);
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.close(137));
    return true;
  }
}
function fixture(handle: (frame: Record<string, unknown>, process: FakeSsh) => void) {
  const child = new FakeSsh(handle);
  let command: string | undefined;
  let args: readonly string[] = [];
  let settings: Parameters<RemoteSshSpawn>[2] | undefined;
  let pin = "";
  let pinMode = 0;
  let knownHosts = "";
  const spawn: RemoteSshSpawn = (file, argv, options) => {
    command = file;
    args = argv;
    settings = options;
    knownHosts = argv.find((arg) => arg.startsWith("UserKnownHostsFile="))!.slice("UserKnownHostsFile=".length);
    pin = readFileSync(knownHosts, "utf8");
    pinMode = statSync(knownHosts).mode & 0o777;
    return child;
  };
  return { child, spawn, inspected: () => ({ command, args, settings, pin, pinMode, knownHosts }) };
}
async function failure(operation: Promise<unknown>, code: string) {
  const result = await operation.then(
    () => null,
    (error: unknown) => error,
  );
  expect(result).toMatchObject({ code });
  expect((result as Error).cause).toBeUndefined();
  expect(String(result)).not.toContain(canary);
  expect(JSON.stringify(result)).not.toContain(canary);
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ravi-ssh-test-")));
  const identityFile = join(root, "synthetic-key");
  writeFileSync(identityFile, "TEST_ONLY_NOT_A_REAL_SSH_KEY", { mode: 0o600 });
  const key = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, 7),
  ]);
  dest = {
    id: "billing",
    version: "3e7888c9-b7ee-44c0-ab1c-4a65c8c9ad6f",
    label: "Billing",
    sshAlias: "billing-personal",
    host: "192.0.2.10",
    port: 2222,
    user: "credential_writer",
    identityFile,
    hostKey: `ssh-ed25519 ${key.toString("base64")}`,
    envPath: "/srv/billing/.env",
    remoteTarget: "billing",
    keys: ["BILLING_TOKEN"],
    profile: "dotenv-single-line-v1",
  };
  request = {
    requestId: "request-synthetic",
    key: "BILLING_TOKEN",
    expectedVersion: version,
    expiresAt: Date.now() + 60_000,
    destinationVersion: dest.version,
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("restricted SSH credential transport", () => {
  it("preflights with pinned host and path/profile, no personal config, no inherited context, no secret", async () => {
    const f = fixture((_frame, child) => {
      child.reply({ v: 1, status: "ready", version });
      child.close();
    });
    expect(await preflightRemote(dest, "BILLING_TOKEN", { spawn: f.spawn })).toEqual({
      v: 1,
      status: "ready",
      version,
    });
    expect(f.child.frames).toEqual([
      { v: 1, op: "preflight", target: "billing", envPath: dest.envPath, profile: dest.profile, key: "BILLING_TOKEN" },
    ]);
    const seen = f.inspected();
    expect(seen.command).toBe("/usr/bin/ssh");
    expect(seen.args.slice(0, 5)).toEqual(["-F", "none", "-S", "none", "-T"]);
    for (const option of [
      "BatchMode=yes",
      "IdentityAgent=none",
      "IdentitiesOnly=yes",
      "StrictHostKeyChecking=yes",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "ClearAllForwardings=yes",
      "ForwardAgent=no",
      "ProxyCommand=none",
      "ProxyJump=none",
      "ConnectTimeout=10",
    ])
      expect(seen.args).toContain(option);
    expect(seen.args.at(-1)).toBe("/usr/local/libexec/ravi-credential-writer");
    expect(seen.args).not.toContain(dest.sshAlias);
    expect(seen.settings!.env).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" });
    expect(seen.settings!.stdio).toEqual(["pipe", "pipe", "ignore"]);
    expect(seen.pin).toBe(`ravi-credential-destination ${dest.hostKey}\n`);
    expect(seen.pinMode).toBe(0o600);
    expect(existsSync(seen.knownHosts)).toBe(false);
  });
  it("sends a secret only in the commit stdin after prepare and authorization", async () => {
    let approved = false;
    const f = fixture((frame, child) => {
      if (frame.op === "prepare") {
        expect(JSON.stringify(frame)).not.toContain(canary);
        child.reply({ v: 1, status: "ready", nonce });
      } else {
        expect(approved).toBe(true);
        expect(frame).toEqual({ v: 1, op: "commit", nonce, secret: canary });
        child.reply(stored);
        child.close();
      }
    });
    expect(
      await storeRemoteSecret(dest, request, canary, {
        spawn: f.spawn,
        beforeCommit: async () => {
          approved = true;
        },
      }),
    ).toEqual(stored);
    expect(f.child.frames[0]).toEqual({
      v: 1,
      op: "prepare",
      target: dest.remoteTarget,
      envPath: dest.envPath,
      profile: dest.profile,
      ...request,
    });
    expect(JSON.stringify(f.inspected())).not.toContain(canary);
  });
  it("revalidates a stored replay and returns its original receipt without sending a secret, even after TTL", async () => {
    let checks = 0;
    const f = fixture((_frame, child) => {
      child.reply(stored);
      child.close();
    });
    expect(
      await storeRemoteSecret(dest, { ...request, expiresAt: 1 }, canary, {
        spawn: f.spawn,
        beforeCommit: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          checks++;
        },
      }),
    ).toEqual(stored);
    expect(checks).toBe(1);
    expect(f.child.frames).toHaveLength(1);
    expect(JSON.stringify(f.child.frames)).not.toContain(canary);
  });
  it("returns stored, not_found and uncertain status without secret input", async () => {
    for (const response of [stored, { v: 1, status: "not_found" }, { v: 1, status: "uncertain" }] as const) {
      const f = fixture((_frame, child) => {
        child.reply(response);
        child.close();
      });
      expect(await remoteRequestStatus(dest, request.requestId, { spawn: f.spawn })).toEqual(response);
      expect(f.child.frames).toEqual([
        {
          v: 1,
          op: "status",
          target: dest.remoteTarget,
          envPath: dest.envPath,
          profile: dest.profile,
          requestId: request.requestId,
        },
      ]);
    }
  });
  it("kills before secret delivery when authorization throws raw sensitive diagnostics", async () => {
    const f = fixture((_frame, child) => child.reply({ v: 1, status: "ready", nonce }));
    await failure(
      storeRemoteSecret(dest, request, canary, {
        spawn: f.spawn,
        beforeCommit: () => {
          throw new Error(canary);
        },
      }),
      "REMOTE_AUTHORIZATION_DENIED",
    );
    expect(f.child.killed).toBe(true);
    expect(f.child.frames).toHaveLength(1);
  });
  it("requires reauthorization even when prepare reports a completed replay", async () => {
    const f = fixture((_frame, child) => {
      child.reply(stored);
      child.close();
    });
    await failure(
      storeRemoteSecret(dest, request, canary, {
        spawn: f.spawn,
        beforeCommit: () => {
          throw new Error(canary);
        },
      }),
      "REMOTE_AUTHORIZATION_DENIED",
    );
    expect(f.child.frames).toHaveLength(1);
  });
  it("does not send a secret after expiry or after disconnection while authorizing", async () => {
    const f = fixture((_frame, child) => child.reply({ v: 1, status: "ready", nonce }));
    await failure(
      storeRemoteSecret(dest, { ...request, expiresAt: 1 }, canary, { spawn: f.spawn, beforeCommit() {} }),
      "REQUEST_EXPIRED",
    );
    expect(f.child.frames).toHaveLength(1);
    const g = fixture((_frame, child) => child.reply({ v: 1, status: "ready", nonce }));
    await failure(
      storeRemoteSecret(dest, request, canary, {
        spawn: g.spawn,
        beforeCommit: async () => {
          g.child.close(255);
        },
      }),
      "REMOTE_UNAVAILABLE",
    );
    expect(g.child.frames).toHaveLength(1);
  });
  it("has a total deadline including a hung authorization callback", async () => {
    const f = fixture((_frame, child) => child.reply({ v: 1, status: "ready", nonce }));
    await failure(
      storeRemoteSecret(dest, request, canary, {
        spawn: f.spawn,
        timeoutMs: 10,
        beforeCommit: () => new Promise(() => {}),
      }),
      "REMOTE_UNAVAILABLE",
    );
    expect(f.child.killed).toBe(true);
    expect(f.child.frames).toHaveLength(1);
  });
  it("classifies timeout before commit as unavailable and after commit as uncertain", async () => {
    const f = fixture(() => {});
    await failure(preflightRemote(dest, "BILLING_TOKEN", { spawn: f.spawn, timeoutMs: 10 }), "REMOTE_UNAVAILABLE");
    const g = fixture((frame, child) => {
      if (frame.op === "prepare") child.reply({ v: 1, status: "ready", nonce });
    });
    await failure(
      storeRemoteSecret(dest, request, canary, { spawn: g.spawn, timeoutMs: 10, beforeCommit() {} }),
      "REMOTE_UNCERTAIN",
    );
    expect(g.child.frames).toHaveLength(2);
  });
  it("treats all ambiguous post-commit exits, malformed output and helper IO failures as uncertain", async () => {
    for (const finish of [
      (child: FakeSsh) => child.close(255),
      (child: FakeSsh) => child.stdout.write(`${canary}\n`),
      (child: FakeSsh) => child.reply({ v: 1, status: "error", code: "IO_ERROR" }),
      (child: FakeSsh) => child.emit("error", new Error(canary)),
    ]) {
      const f = fixture((frame, child) => {
        if (frame.op === "prepare") child.reply({ v: 1, status: "ready", nonce });
        else finish(child);
      });
      await failure(
        storeRemoteSecret(dest, request, canary, { spawn: f.spawn, beforeCommit() {} }),
        "REMOTE_UNCERTAIN",
      );
    }
  });
  it("allows only fixed helper errors and exact response shapes before secret delivery", async () => {
    const f = fixture((_frame, child) => child.reply({ v: 1, status: "error", code: "VERSION_CONFLICT" }));
    await failure(storeRemoteSecret(dest, request, canary, { spawn: f.spawn, beforeCommit() {} }), "VERSION_CONFLICT");
    for (const response of [
      { v: 1, status: "error", code: canary },
      { v: 1, status: "ready", nonce, secret: canary },
      { v: 2, status: "ready", nonce },
      { v: 1, status: "ready", nonce: canary },
      { v: 1, status: "ready", version },
      [stored],
    ]) {
      const g = fixture((_frame, child) => child.reply(response));
      await failure(
        storeRemoteSecret(dest, request, canary, { spawn: g.spawn, beforeCommit() {} }),
        "REMOTE_PROTOCOL_ERROR",
      );
      expect(g.child.frames).toHaveLength(1);
    }
  });
  it("caps output and rejects unsolicited extra frames without exposing content", async () => {
    for (const output of [
      "x".repeat(8193),
      `${canary}\n`,
      `${JSON.stringify({ v: 1, status: "ready", nonce })}\n${JSON.stringify(stored)}\n`,
    ]) {
      const f = fixture((_frame, child) => child.stdout.write(output));
      await failure(
        storeRemoteSecret(dest, request, canary, { spawn: f.spawn, beforeCommit: () => new Promise(() => {}) }),
        "REMOTE_PROTOCOL_ERROR",
      );
    }
  });
  it("refuses unsafe identity files before spawning", async () => {
    let calls = 0;
    const spawn: RemoteSshSpawn = () => {
      calls++;
      throw new Error(canary);
    };
    chmodSync(dest.identityFile, 0o644);
    await failure(preflightRemote(dest, "BILLING_TOKEN", { spawn }), "REMOTE_UNAVAILABLE");
    chmodSync(dest.identityFile, 0o600);
    const alias = join(root, "alias-key");
    symlinkSync(dest.identityFile, alias);
    await failure(preflightRemote({ ...dest, identityFile: alias }, "BILLING_TOKEN", { spawn }), "REMOTE_UNAVAILABLE");
    expect(calls).toBe(0);
  });
  it("refuses a FIFO identity before spawning without blocking the event loop", () => {
    rmSync(dest.identityFile);
    expect(spawnSync("/usr/bin/mkfifo", ["-m", "600", dest.identityFile], { timeout: 1000 }).status).toBe(0);
    const code = `import {preflightRemote} from ${JSON.stringify(new URL("./ssh.ts", import.meta.url).href)}; try { await preflightRemote(${JSON.stringify(dest)}, "BILLING_TOKEN", {timeoutMs:10,spawn:()=>{process.exit(4)}}); process.exit(2); } catch(error) { process.exit(error.code === "REMOTE_UNAVAILABLE" ? 0 : 3); }`;
    const child = spawnSync(process.execPath, ["--no-env-file", "--eval", code], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      timeout: 2000,
      encoding: "utf8",
    });
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
  });
  it("rejects invalid request/key/secret and missing callback without spawning", async () => {
    let calls = 0;
    const spawn: RemoteSshSpawn = () => {
      calls++;
      throw new Error(canary);
    };
    await failure(preflightRemote(dest, "UNKNOWN", { spawn }), "KEY_NOT_ALLOWED");
    await failure(remoteRequestStatus(dest, "../path", { spawn }), "INVALID_REQUEST");
    await failure(
      storeRemoteSecret(dest, { ...request, destinationVersion: "other" }, canary, { spawn, beforeCommit() {} }),
      "INVALID_REQUEST",
    );
    for (const secret of ["", "a\nb", "a\u0000b", "x".repeat(8193)])
      await failure(storeRemoteSecret(dest, request, secret, { spawn, beforeCommit() {} }), "SECRET_INVALID");
    await failure(storeRemoteSecret(dest, request, canary, { spawn } as never), "INVALID_REQUEST");
    expect(calls).toBe(0);
  });
  it("scrubs a spawn failure with a canary and removes temporary host metadata", async () => {
    let directory = "";
    await failure(
      preflightRemote(dest, "BILLING_TOKEN", {
        spawn: (_cmd, _args, options) => {
          directory = String(options.cwd);
          throw new Error(canary);
        },
      }),
      "REMOTE_UNAVAILABLE",
    );
    expect(existsSync(directory)).toBe(false);
  });
});
