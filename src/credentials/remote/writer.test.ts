import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Destination } from "./destinations.js";
import { preflightRemote, remoteRequestStatus, storeRemoteSecret, type RemoteSshSpawn } from "./ssh.js";
import { REMOTE_CREDENTIAL_WRITER_PYTHON } from "./writer-source.js";

const PROFILE = "dotenv-single-line-v1";
const CANARY = "synthetic-secret-never-real-0123456789";
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
type Frame = Record<string, unknown>;
type Fixture = ReturnType<typeof fixture>;

function fixture(initial: string | null = "KEEP=original\n") {
  // The receiver rejects writable ancestors, including /tmp. Use a private,
  // physically resolved home child without weakening the production policy.
  const root = mkdtempSync(join(realpathSync(homedir()), ".ravi-writer-test-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const envPath = join(root, ".env");
  if (initial !== null) writeFileSync(envPath, initial, { mode: 0o600 });
  const policyPath = join(root, "policy.json");
  const policy = {
    version: 1,
    stateDir,
    targets: [{ id: "project", envPath, keys: ["TOKEN", "OTHER"], profile: PROFILE }],
  };
  writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const source = join(root, "writer.py");
  writeFileSync(source, REMOTE_CREDENTIAL_WRITER_PYTHON, { mode: 0o600 });
  const base = { v: 1, target: "project", envPath, profile: PROFILE };
  return { root, stateDir, envPath, policyPath, policy, source, base };
}

function args(f: Fixture, hook = "", timeout = 0.8) {
  const program = `import runpy, sys, os\nm = runpy.run_path(sys.argv[1], run_name='writer_test')\nm['main'].__globals__['TIMEOUT'] = ${timeout}\ndef hook(point):\n    ${hook || "pass"}\nsys.exit(m['main'](sys.argv[2], hook))\n`;
  return ["-u", "-c", program, f.source, f.policyPath];
}

function single(f: Fixture, frame: Frame | string, hook = "") {
  const result = spawnSync("/usr/bin/python3", args(f, hook), {
    input: typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`,
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: "/usr/bin:/bin" },
  });
  expect(result.stderr).toBe("");
  expect(result.error).toBeUndefined();
  const response = JSON.parse(result.stdout.trim()) as Frame;
  expect(result.stdout).not.toContain(CANARY);
  return response;
}

function client(f: Fixture, hook = "", timeout = 0.8) {
  const child = spawn("/usr/bin/python3", args(f, hook, timeout), { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe" });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    child,
    exit,
    send(frame: Frame) {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    async next() {
      const item = await lines.next();
      if (item.done) return null;
      expect(item.value).not.toContain(CANARY);
      return JSON.parse(item.value) as Frame;
    },
    async done() {
      const code = await exit;
      expect(stderr).toBe("");
      return code;
    },
  };
}

function preflight(f: Fixture, key = "TOKEN") {
  return single(f, { ...f.base, op: "preflight", key });
}

function preparation(f: Fixture, version: unknown, overrides: Frame = {}) {
  return {
    ...f.base,
    op: "prepare",
    key: "TOKEN",
    requestId: randomUUID(),
    expectedVersion: version,
    expiresAt: Date.now() + 60_000,
    destinationVersion: randomUUID(),
    ...overrides,
  };
}

async function store(f: Fixture, request: Frame, secret = CANARY, hook = "") {
  const c = client(f, hook);
  c.send(request);
  const ready = await c.next();
  if (!ready) throw new Error("Writer closed before READY");
  if (ready?.status !== "ready") {
    await c.done();
    return ready;
  }
  c.send({ v: 1, op: "commit", nonce: ready.nonce, secret });
  const result = await c.next();
  await c.done();
  if (!result) throw new Error("Writer closed without a result");
  return result;
}

function status(f: Fixture, requestId: unknown) {
  return single(f, { ...f.base, op: "status", requestId });
}

function state(f: Fixture) {
  return JSON.parse(
    readFileSync(join(f.stateDir, readdirSync(f.stateDir).find((name) => name.endsWith(".json"))!), "utf8"),
  );
}

function transportFixture(f: Fixture, hook = "") {
  const identityFile = join(f.root, "synthetic-transport-key");
  writeFileSync(identityFile, "TEST_ONLY_NOT_A_REAL_PRIVATE_KEY", { mode: 0o600 });
  const key = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, 7),
  ]);
  const destination: Destination = {
    id: "project",
    version: randomUUID(),
    label: "Synthetic project",
    sshAlias: "synthetic-alias",
    host: "192.0.2.10",
    port: 22,
    user: "credential_writer",
    identityFile,
    hostKey: `ssh-ed25519 ${key.toString("base64")}`,
    envPath: f.envPath,
    remoteTarget: "project",
    keys: ["TOKEN", "OTHER"],
    profile: PROFILE,
  };
  const spawnShim: RemoteSshSpawn = (command, argv, options) => {
    expect(command).toBe("/usr/bin/ssh");
    expect(JSON.stringify(argv)).not.toContain(CANARY);
    // No network: preserve the real stdin/stdout protocol while replacing SSH
    // with the exact exported Python source under an isolated synthetic policy.
    const child = spawn("/usr/bin/python3", args(f, hook, 2), {
      ...options,
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    child.stderr.on("data", () => {
      throw new Error("Unexpected receiver stderr");
    });
    return child;
  };
  return { destination, options: { spawn: spawnShim, timeoutMs: 4000 } };
}

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("restricted remote credential writer", () => {
  test("appends one key, preserves bytes and keeps private state without the secret", async () => {
    const original = "# preserved unicode café\r\nKEEP=original\r\nEMPTY=\r\n";
    const f = fixture(original);
    const before = preflight(f);
    expect(before).toMatchObject({ v: 1, status: "ready" });
    expect(before.version).toMatch(/^[a-f0-9]{64}$/);
    expect(preflight(f).version).toBe(before.version);
    const request = preparation(f, before.version);
    const saved = await store(f, request);
    expect(saved).toMatchObject({ v: 1, status: "stored" });
    expect(saved?.receipt).toMatch(/^[a-f0-9]{64}$/);
    expect(saved?.version).not.toBe(before.version);
    expect(readFileSync(f.envPath, "utf8")).toBe(`${original}TOKEN=${CANARY}\r\n`);
    expect(statSync(f.envPath).mode & 0o777).toBe(0o600);
    expect(status(f, request.requestId)).toEqual(saved);
    const metadata = state(f);
    expect(JSON.stringify(metadata)).not.toContain(CANARY);
    expect(metadata.requests[request.requestId as string].phase).toBe("stored");
    for (const name of readdirSync(f.stateDir)) expect(statSync(join(f.stateDir, name)).mode & 0o777).toBe(0o600);
  });

  test("creates a missing env file and adds a missing line ending without normalizing siblings", async () => {
    for (const initial of [null, "KEEP=original"]) {
      const f = fixture(initial);
      expect((await store(f, preparation(f, preflight(f).version)))?.status).toBe("stored");
      expect(readFileSync(f.envPath, "utf8")).toBe(`${initial ? `${initial}\n` : ""}TOKEN=${CANARY}\n`);
    }
  });

  test("refuses present empty keys, duplicates, quotes, interpolation and malformed files", () => {
    for (const initial of [
      "TOKEN=\n",
      "TOKEN=one\nTOKEN=two\n",
      'KEEP="quoted"\n',
      "KEEP=$OTHER\n",
      "KEEP=one # comment\n",
      "KEEP=one\rBAD=two",
    ]) {
      const f = fixture(initial);
      expect(preflight(f).status).toBe("error");
      expect(readFileSync(f.envPath, "utf8")).toBe(initial);
    }
  });

  test("rejects unknown target/key, path/profile mismatch and duplicate file policies", () => {
    const f = fixture();
    expect(single(f, { ...f.base, op: "preflight", key: "NOPE" }).code).toBe("KEY_NOT_ALLOWED");
    expect(single(f, { ...f.base, target: "unknown", op: "preflight", key: "TOKEN" }).code).toBe("TARGET_NOT_ALLOWED");
    expect(single(f, { ...f.base, envPath: join(f.root, "other.env"), op: "preflight", key: "TOKEN" }).code).toBe(
      "TARGET_NOT_ALLOWED",
    );
    expect(single(f, { ...f.base, profile: "other", op: "preflight", key: "TOKEN" }).code).toBe("INVALID_REQUEST");
    f.policy.targets.push({ ...f.policy.targets[0]!, id: "alias" });
    writeFileSync(f.policyPath, JSON.stringify(f.policy));
    expect(preflight(f).code).toBe("INVALID_POLICY");
  });

  test("rejects file/parent symlinks, hardlinks and unsafe permissions", () => {
    for (const kind of [
      "file-symlink",
      "parent-symlink",
      "hardlink",
      "file-mode",
      "state-mode",
      "parent-mode",
      "policy-mode",
    ]) {
      const f = fixture();
      if (kind === "file-symlink") {
        rmSync(f.envPath);
        const other = join(f.root, "other");
        writeFileSync(other, "KEEP=safe\n", { mode: 0o600 });
        symlinkSync(other, f.envPath);
      }
      if (kind === "parent-symlink") {
        const alias = join(f.root, "alias");
        symlinkSync(f.root, alias);
        f.policy.targets[0]!.envPath = join(alias, ".env");
        f.base.envPath = join(alias, ".env");
        writeFileSync(f.policyPath, JSON.stringify(f.policy));
      }
      if (kind === "hardlink") linkSync(f.envPath, join(f.root, "hardlink"));
      if (kind === "file-mode") chmodSync(f.envPath, 0o644);
      if (kind === "state-mode") chmodSync(f.stateDir, 0o755);
      if (kind === "parent-mode") chmodSync(f.root, 0o777);
      if (kind === "policy-mode") chmodSync(f.policyPath, 0o666);
      expect(preflight(f).code).toBe("UNSAFE_PATH");
    }
  });

  test("detects file drift and policy drift after READY without applying the secret", async () => {
    for (const kind of ["env", "policy"]) {
      const f = fixture();
      const c = client(f);
      c.send(preparation(f, preflight(f).version));
      const ready = await c.next();
      expect(ready?.status).toBe("ready");
      if (kind === "env") writeFileSync(f.envPath, "KEEP=changed\n");
      else {
        f.policy.targets[0]!.keys = ["OTHER"];
        writeFileSync(f.policyPath, JSON.stringify(f.policy));
      }
      c.send({ v: 1, op: "commit", nonce: ready?.nonce, secret: CANARY });
      expect((await c.next())?.code).toBe("VERSION_CONFLICT");
      await c.done();
      expect(readFileSync(f.envPath, "utf8")).not.toContain(CANARY);
    }
  });

  test("stored replay returns the same receipt without sending another secret", async () => {
    const f = fixture();
    const request = preparation(f, preflight(f).version);
    const result = await store(f, request);
    const content = readFileSync(f.envPath);
    expect(single(f, request)).toEqual(result);
    expect(single(f, { ...request, key: "OTHER" }).code).toBe("REQUEST_CONFLICT");
    expect(readFileSync(f.envPath)).toEqual(content);
  });

  test("rejects stale versions, expired requests, long TTL, wrong nonce and invalid secret", async () => {
    const f = fixture();
    const version = preflight(f).version;
    for (const overrides of [
      { expectedVersion: "0".repeat(64) },
      { expiresAt: Date.now() - 1 },
      { expiresAt: Date.now() + 700_000 },
    ]) {
      expect(single(f, preparation(f, version, overrides)).status).toBe("error");
    }
    for (const bad of ["with space", "one\ntwo", "$VAR", "`cmd`", "", "a".repeat(8193)]) {
      expect((await store(f, preparation(f, version), bad))?.code).toBe("SECRET_INVALID");
    }
    const c = client(f);
    c.send(preparation(f, version));
    await c.next();
    c.send({ v: 1, op: "commit", nonce: "0".repeat(64), secret: CANARY });
    expect((await c.next())?.code).toBe("INVALID_NONCE");
    await c.done();
    expect(readFileSync(f.envPath, "utf8")).toBe("KEEP=original\n");
  });

  test("concurrent different keys cannot lose an update; stale second writer conflicts", async () => {
    const f = fixture();
    const version = preflight(f).version;
    const firstRequest = preparation(f, version);
    const secondRequest = preparation(f, version, { key: "OTHER" });
    const a = client(f);
    a.send(firstRequest);
    const ready = await a.next();
    const b = client(f);
    b.send(secondRequest);
    a.send({ v: 1, op: "commit", nonce: ready?.nonce, secret: CANARY });
    expect((await a.next())?.status).toBe("stored");
    await a.done();
    expect((await b.next())?.code).toBe("VERSION_CONFLICT");
    await b.done();
    const fresh = preparation(f, preflight(f, "OTHER").version, { key: "OTHER" });
    expect((await store(f, fresh, "second-token"))?.status).toBe("stored");
    expect(readFileSync(f.envPath, "utf8")).toBe(`KEEP=original\nTOKEN=${CANARY}\nOTHER=second-token\n`);
  });

  test("status waits for the writer lock and never reports absence while it can still commit", async () => {
    const f = fixture();
    const request = preparation(f, preflight(f).version);
    const a = client(f, "", 2);
    a.send(request);
    const ready = await a.next();
    const b = client(f, "", 0.15);
    b.send({ ...f.base, op: "status", requestId: request.requestId });
    expect((await b.next())?.code).toBe("LOCK_TIMEOUT");
    await b.done();
    a.send({ v: 1, op: "commit", nonce: ready?.nonce, secret: CANARY });
    expect((await a.next())?.status).toBe("stored");
    await a.done();
  });

  test("negative status fences a late prepare and an abandoned reservation", async () => {
    const f = fixture();
    const version = preflight(f).version;
    const missing = preparation(f, version);
    expect(status(f, missing.requestId)).toEqual({ v: 1, status: "not_found" });
    expect(single(f, missing).code).toBe("REQUEST_CONFLICT");
    const reserved = preparation(f, version);
    const c = client(f);
    c.send(reserved);
    expect((await c.next())?.status).toBe("ready");
    c.child.stdin.end();
    expect((await c.next())?.status).toBe("error");
    await c.done();
    expect(status(f, reserved.requestId).status).toBe("not_found");
    expect(single(f, reserved).code).toBe("REQUEST_CONFLICT");
  });

  for (const point of [
    "after_prepare",
    "after_temp_fsync",
    "before_rename",
    "after_rename",
    "after_directory_fsync",
    "after_finalize",
  ]) {
    test(`recovers crash at ${point} without repeating a write`, async () => {
      const f = fixture();
      const request = preparation(f, preflight(f).version);
      const c = client(f, `\n    if point == ${JSON.stringify(point)}: os._exit(71)`);
      c.send(request);
      const ready = await c.next();
      c.send({ v: 1, op: "commit", nonce: ready?.nonce, secret: CANARY });
      expect(await c.done()).toBe(71);
      const expectedStored = ["after_rename", "after_directory_fsync", "after_finalize"].includes(point);
      const recovered = status(f, request.requestId);
      expect(recovered.status).toBe(expectedStored ? "stored" : "not_found");
      expect(readFileSync(f.envPath, "utf8").includes(CANARY)).toBe(expectedStored);
      expect(readdirSync(f.root).some((name) => name.startsWith(".ravi-") && name.endsWith(".tmp"))).toBe(false);
      if (expectedStored) expect(single(f, request)).toEqual(recovered);
      else expect(single(f, request).code).toBe("REQUEST_CONFLICT");
    });
  }

  test("unknown post-crash content stays uncertain and blocks new mutations", async () => {
    const f = fixture();
    const request = preparation(f, preflight(f).version);
    const c = client(f, "\n    if point == 'after_rename': os._exit(71)");
    c.send(request);
    const ready = await c.next();
    c.send({ v: 1, op: "commit", nonce: ready?.nonce, secret: CANARY });
    await c.done();
    writeFileSync(f.envPath, "KEEP=external-drift\n");
    expect(status(f, request.requestId)).toEqual({ v: 1, status: "uncertain" });
    expect(preflight(f, "OTHER").code).toBe("UNCERTAIN");
    expect(readFileSync(f.envPath, "utf8")).toBe("KEEP=external-drift\n");
  });

  test("IO failure after rename is uncertain and diagnostics never expose the canary", async () => {
    const f = fixture();
    const request = preparation(f, preflight(f).version);
    const result = await store(
      f,
      request,
      CANARY,
      `\n    if point == 'after_rename': raise OSError(${JSON.stringify(CANARY)})`,
    );
    expect(result).toEqual({ v: 1, status: "error", code: "UNCERTAIN" });
    expect(status(f, request.requestId).status).toBe("stored");
  });

  test("recovery syncs the env directory before acknowledging a post-rename commit", async () => {
    for (const failSync of [false, true]) {
      const f = fixture();
      const request = preparation(f, preflight(f).version);
      const c = client(f, "\n    if point == 'after_rename': os._exit(71)");
      c.send(request);
      const ready = await c.next();
      c.send({ v: 1, op: "commit", nonce: ready?.nonce, secret: CANARY });
      expect(await c.done()).toBe(71);
      const marker = join(f.root, "directory-fsynced");
      const program = `import runpy, sys, os\nm=runpy.run_path(sys.argv[1],run_name='writer_test')\noriginal=os.fsync\nroot=os.stat(sys.argv[3])\ndef tracked(fd):\n    info=os.fstat(fd)\n    if (info.st_dev,info.st_ino)==(root.st_dev,root.st_ino):\n        open(sys.argv[4],'w').write('called')\n        ${failSync ? "raise OSError('synthetic fsync failure')" : "pass"}\n    return original(fd)\nos.fsync=tracked\nsys.exit(m['main'](sys.argv[2]))\n`;
      const run = spawnSync("/usr/bin/python3", ["-u", "-c", program, f.source, f.policyPath, f.root, marker], {
        input: `${JSON.stringify({ ...f.base, op: "status", requestId: request.requestId })}\n`,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
        timeout: 5000,
      });
      expect(run.stderr).toBe("");
      expect(readFileSync(marker, "utf8")).toBe("called");
      const result = JSON.parse(run.stdout);
      if (failSync) {
        expect(result).toEqual({ v: 1, status: "error", code: "UNCERTAIN" });
        expect(state(f).requests[request.requestId as string].phase).toBe("prepared");
        expect(status(f, request.requestId).status).toBe("stored");
      } else expect(result.status).toBe("stored");
    }
  });

  test("real TypeScript transport and Python receiver agree on preflight, commit, status and replay", async () => {
    const f = fixture();
    const { destination, options } = transportFixture(f);
    const before = await preflightRemote(destination, "TOKEN", options);
    const input = {
      requestId: randomUUID(),
      key: "TOKEN",
      expectedVersion: before.version,
      expiresAt: Date.now() + 60_000,
      destinationVersion: destination.version,
    };
    let checks = 0;
    const saved = await storeRemoteSecret(destination, input, CANARY, {
      ...options,
      beforeCommit: () => {
        checks++;
      },
    });
    expect(saved.status).toBe("stored");
    expect(await remoteRequestStatus(destination, input.requestId, options)).toEqual(saved);
    expect(
      await storeRemoteSecret(destination, input, CANARY, {
        ...options,
        beforeCommit: () => {
          checks++;
        },
      }),
    ).toEqual(saved);
    expect(checks).toBe(2);
    expect(readFileSync(f.envPath, "utf8")).toBe(`KEEP=original\nTOKEN=${CANARY}\n`);
  });

  test("real transport recovers a lost ACK through status without another write", async () => {
    const f = fixture();
    const { destination, options } = transportFixture(f, "\n    if point == 'after_finalize': os._exit(71)");
    const before = await preflightRemote(destination, "TOKEN", options);
    const input = {
      requestId: randomUUID(),
      key: "TOKEN",
      expectedVersion: before.version,
      expiresAt: Date.now() + 60_000,
      destinationVersion: destination.version,
    };
    await expect(
      storeRemoteSecret(destination, input, CANARY, { ...options, beforeCommit: () => {} }),
    ).rejects.toMatchObject({ code: "REMOTE_UNCERTAIN" });
    const recovered = await remoteRequestStatus(destination, input.requestId, options);
    expect(recovered.status).toBe("stored");
    if (recovered.status !== "stored") throw new Error("Expected recovered receipt");
    expect(readFileSync(f.envPath, "utf8")).toBe(`KEEP=original\nTOKEN=${CANARY}\n`);
    expect(await storeRemoteSecret(destination, input, CANARY, { ...options, beforeCommit: () => {} })).toEqual(
      recovered,
    );
  });

  test("real transport binds the env path and enforces reauthorization before sending the secret", async () => {
    const f = fixture();
    const { destination, options } = transportFixture(f);
    await expect(
      preflightRemote({ ...destination, envPath: join(f.root, "different.env") }, "TOKEN", options),
    ).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
    const before = await preflightRemote(destination, "TOKEN", options);
    const input = {
      requestId: randomUUID(),
      key: "TOKEN",
      expectedVersion: before.version,
      expiresAt: Date.now() + 60_000,
      destinationVersion: destination.version,
    };
    await expect(
      storeRemoteSecret(destination, input, CANARY, {
        ...options,
        beforeCommit: () => {
          throw new Error("denied");
        },
      }),
    ).rejects.toMatchObject({ code: "REMOTE_AUTHORIZATION_DENIED" });
    expect(await remoteRequestStatus(destination, input.requestId, options)).toEqual({ v: 1, status: "not_found" });
    expect(readFileSync(f.envPath, "utf8")).toBe("KEEP=original\n");
  });

  test("failure before rename preserves the original and becomes a fenced negative result", async () => {
    const f = fixture();
    const request = preparation(f, preflight(f).version);
    const result = await store(
      f,
      request,
      CANARY,
      `\n    if point == 'after_temp_fsync': raise OSError(${JSON.stringify(CANARY)})`,
    );
    expect(result).toEqual({ v: 1, status: "error", code: "IO_ERROR" });
    expect(readFileSync(f.envPath, "utf8")).toBe("KEEP=original\n");
    expect(status(f, request.requestId).status).toBe("not_found");
    expect(single(f, request).code).toBe("REQUEST_CONFLICT");
  });

  test("bounds the env file and refuses corrupted private state without exposing it", () => {
    const oversized = fixture(`KEEP=${"a".repeat(1024 * 1024)}\n`);
    expect(preflight(oversized).code).toBe("FILE_TOO_LARGE");
    const f = fixture();
    preflight(f);
    const stateName = readdirSync(f.stateDir).find((name) => name.endsWith(".json"))!;
    writeFileSync(join(f.stateDir, stateName), CANARY);
    expect(preflight(f).code).toBe("UNCERTAIN");
  });

  test("read timeouts release locks and a status query fences the abandoned request", async () => {
    const f = fixture();
    const empty = client(f, "", 0.1);
    expect((await empty.next())?.code).toBe("READ_TIMEOUT");
    await empty.done();
    const request = preparation(f, preflight(f).version);
    const waiting = client(f, "", 0.1);
    waiting.send(request);
    expect((await waiting.next())?.status).toBe("ready");
    expect((await waiting.next())?.code).toBe("READ_TIMEOUT");
    await waiting.done();
    expect(status(f, request.requestId).status).toBe("not_found");
    expect(single(f, request).code).toBe("REQUEST_CONFLICT");
  });

  test("bounds input, rejects duplicate fields and keeps production policy fixed", () => {
    const f = fixture();
    expect(single(f, `{"v":1,"v":1,"op":"status"}\n`).code).toBe("INVALID_REQUEST");
    expect(single(f, `${"x".repeat(20001)}\n`).code).toBe("INVALID_REQUEST");
    expect(single(f, "{}").code).toBe("INVALID_REQUEST");
    const result = spawnSync("/usr/bin/python3", [f.source, f.policyPath], {
      input: `${JSON.stringify({ ...f.base, op: "preflight", key: "TOKEN" })}\n`,
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: "/usr/bin:/bin", RAVI_WRITER_POLICY: f.policyPath },
    });
    expect(JSON.parse(result.stdout).code).toBe("INVALID_REQUEST");
    expect(result.stderr).toBe("");
  });
});
