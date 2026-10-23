import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CloudWorkerRunner, type StartEnvironmentWorkerInput } from "./worker-runner.js";
import {
  cloudWorkerWorkdir,
  getCloudWorkersDir,
  isCloudWorkerKey,
  listCloudWorkerKeyIds,
  readCloudWorkerKey,
  readCloudWorkerRuntime,
  readCloudWorkerState,
  removeCloudWorkerKey,
  writeCloudWorkerKey,
  writeCloudWorkerState,
} from "./worker-store.js";
import { createFakeProductConsole, fakeCloudWorker } from "./test-fixtures-product.js";
import { fakeCloudSessionOpener } from "./test-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "ravi-cloud-worker-"));
  tempDirs.push(dir);
  return { RAVI_STATE_DIR: dir };
}

/** A fake EnvironmentWorker: runs until aborted, or fails when told to. */
function fakeStarter() {
  const starts: StartEnvironmentWorkerInput[] = [];
  const failures = new Map<string, (error: Error) => void>();
  const start = (input: StartEnvironmentWorkerInput) => {
    starts.push(input);
    return new Promise<void>((resolve, reject) => {
      input.signal.addEventListener("abort", () => resolve());
      failures.set(input.environmentId, reject);
    });
  };
  return { start, starts, fail: (environmentId: string, error: Error) => failures.get(environmentId)?.(error) };
}

describe("cloud worker store", () => {
  it("keeps keys 0600 under the state dir, never readable for a bad id", () => {
    const env = stateEnv();
    writeCloudWorkerKey("wrk_1", "env-key-1", env);
    const path = join(getCloudWorkersDir(env), "keys", "wrk_1.key");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(getCloudWorkersDir(env), "keys")).mode & 0o777).toBe(0o700);
    expect(readCloudWorkerKey("wrk_1", env)).toBe("env-key-1");
    expect(readCloudWorkerKey("../wrk_1", env)).toBeNull();
    expect(() => writeCloudWorkerKey("../x", "k", env)).toThrow();
    expect(listCloudWorkerKeyIds(env)).toEqual(["wrk_1"]);
    expect(removeCloudWorkerKey("wrk_1", env)).toBe(true);
    expect(readCloudWorkerKey("wrk_1", env)).toBeNull();
    expect(isCloudWorkerKey("has space")).toBe(false);
  });

  it("state defaults to disabled; the workdir is per agent and sanitized", () => {
    const env = stateEnv();
    expect(readCloudWorkerState(env)).toEqual({ enabled: false, enabledAt: null });
    writeCloudWorkerState({ enabled: true, enabledAt: "2026-10-23T10:00:00.000Z" }, env);
    expect(readCloudWorkerState(env).enabled).toBe(true);
    expect(cloudWorkerWorkdir("ca_1", env)).toBe(join(getCloudWorkersDir(env), "ca_1", "work"));
    expect(cloudWorkerWorkdir("../../etc", env)).toBe(join(getCloudWorkersDir(env), "______etc", "work"));
  });
});

describe("CloudWorkerRunner", () => {
  it("does nothing and calls nothing while disabled", async () => {
    const fake = createFakeProductConsole();
    const env = stateEnv();
    const starter = fakeStarter();
    const runner = new CloudWorkerRunner({
      env,
      openSession: fakeCloudSessionOpener(fake),
      startWorker: starter.start,
    });
    expect(await runner.tick()).toMatchObject({ status: "disabled", started: 0 });
    expect(fake.requests).toHaveLength(0);
    expect(starter.starts).toHaveLength(0);
  });

  it("waits for a key without a heartbeat, then runs the worker in its workdir and heartbeats online", async () => {
    const fake = createFakeProductConsole();
    const env = stateEnv();
    writeCloudWorkerState({ enabled: true, enabledAt: null }, env);
    const starter = fakeStarter();
    const runner = new CloudWorkerRunner({
      env,
      openSession: fakeCloudSessionOpener(fake),
      startWorker: starter.start,
    });

    expect(await runner.tick()).toMatchObject({ status: "ran", assignments: 1, waitingKey: 1, heartbeats: 0 });
    expect(fake.heartbeats).toHaveLength(0);
    expect(readCloudWorkerRuntime(env)?.workers.wrk_1?.state).toBe("waiting_key");

    writeCloudWorkerKey("wrk_1", "env-key-1", env);
    expect(await runner.tick()).toMatchObject({ started: 1, running: 1, heartbeats: 1 });
    expect(starter.starts[0]).toMatchObject({
      environmentId: "env_self_1",
      environmentKey: "env-key-1",
      workdir: cloudWorkerWorkdir("ca_1", env),
    });
    expect(fake.heartbeats).toEqual([{ id: "wrk_1", body: { status: "online" } }]);
    expect(JSON.stringify(fake.requests)).not.toContain("env-key-1");
    expect(runner.runningWorkerIds()).toEqual(["wrk_1"]);

    // A second tick keeps the same worker.
    expect(await runner.tick()).toMatchObject({ started: 0, running: 1, heartbeats: 1 });
    expect(starter.starts).toHaveLength(1);
    await runner.stop();
  });

  it("a failed worker heartbeats offline with its error during the backoff, then restarts", async () => {
    const fake = createFakeProductConsole();
    const env = stateEnv();
    writeCloudWorkerState({ enabled: true, enabledAt: null }, env);
    writeCloudWorkerKey("wrk_1", "env-key-1", env);
    const starter = fakeStarter();
    let now = 1_000_000;
    const runner = new CloudWorkerRunner({
      env,
      openSession: fakeCloudSessionOpener(fake),
      startWorker: starter.start,
      now: () => now,
    });
    await runner.tick();
    starter.fail("env_self_1", new Error("401 Unauthorized for key env-key-1"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runner.runningWorkerIds()).toEqual([]);

    const waiting = await runner.tick();
    expect(waiting).toMatchObject({ started: 0, backoff: 1, heartbeats: 1 });
    expect(fake.heartbeats.at(-1)).toEqual({
      id: "wrk_1",
      body: { status: "offline", error: "401 Unauthorized for key [key]" },
    });
    const local = readCloudWorkerRuntime(env)?.workers.wrk_1;
    expect(local?.state).toBe("backoff");
    expect(local?.error).toBe("401 Unauthorized for key [key]");

    now += 31_000;
    expect(await runner.tick()).toMatchObject({ started: 1, running: 1 });
    expect(starter.starts).toHaveLength(2);
    await runner.stop();
  });

  it("a changed key restarts the worker; a removed assignment stops it", async () => {
    const fake = createFakeProductConsole();
    const env = stateEnv();
    writeCloudWorkerState({ enabled: true, enabledAt: null }, env);
    writeCloudWorkerKey("wrk_1", "env-key-1", env);
    const starter = fakeStarter();
    const runner = new CloudWorkerRunner({
      env,
      openSession: fakeCloudSessionOpener(fake),
      startWorker: starter.start,
    });
    await runner.tick();
    writeCloudWorkerKey("wrk_1", "env-key-2", env);
    expect(await runner.tick()).toMatchObject({ stopped: 1, started: 1 });
    expect(starter.starts[1]!.environmentKey).toBe("env-key-2");
    expect(starter.starts[0]!.signal.aborted).toBe(true);
    fake.workers = [];
    expect(await runner.tick()).toMatchObject({ stopped: 1, running: 0 });
    await runner.stop();
  });

  it("disabling stops every worker and reports disabled to the Console once", async () => {
    const fake = createFakeProductConsole({ workers: [fakeCloudWorker({ status: "online" })] });
    const env = stateEnv();
    writeCloudWorkerState({ enabled: true, enabledAt: null }, env);
    writeCloudWorkerKey("wrk_1", "env-key-1", env);
    const starter = fakeStarter();
    const runner = new CloudWorkerRunner({
      env,
      openSession: fakeCloudSessionOpener(fake),
      startWorker: starter.start,
    });
    await runner.tick();
    writeCloudWorkerState({ enabled: false, enabledAt: null }, env);
    expect(await runner.tick()).toMatchObject({ status: "disabled", stopped: 1, heartbeats: 1 });
    expect(fake.heartbeats.at(-1)).toEqual({ id: "wrk_1", body: { status: "disabled" } });
    const requests = fake.requests.length;
    expect(await runner.tick()).toMatchObject({ status: "disabled", heartbeats: 0 });
    expect(fake.requests).toHaveLength(requests);

    // Enabled again: a worker the Console shows as disabled starts again.
    writeCloudWorkerState({ enabled: true, enabledAt: null }, env);
    expect(await runner.tick()).toMatchObject({ started: 1, heartbeats: 1 });
    expect(fake.heartbeats.at(-1)).toEqual({ id: "wrk_1", body: { status: "online" } });
    await runner.stop();
  });

  it("without a login it stops everything; a Console error keeps running workers", async () => {
    const fake = createFakeProductConsole();
    const env = stateEnv();
    writeCloudWorkerState({ enabled: true, enabledAt: null }, env);
    writeCloudWorkerKey("wrk_1", "env-key-1", env);
    const starter = fakeStarter();
    const runner = new CloudWorkerRunner({
      env,
      openSession: fakeCloudSessionOpener(fake),
      startWorker: starter.start,
    });
    await runner.tick();
    fake.failures.push({
      method: "GET",
      path: "/workers",
      status: 503,
      body: { error: { code: "unavailable" } },
      times: 1,
    });
    expect(await runner.tick()).toMatchObject({ status: "skipped", reason: "console_error", running: 1 });
    const loggedOut = new CloudWorkerRunner({
      env,
      openSession: fakeCloudSessionOpener(fake, { loggedIn: false }),
      startWorker: starter.start,
    });
    expect(await loggedOut.tick()).toMatchObject({ status: "skipped", reason: "no_login" });
    await runner.stop();
    expect(runner.runningWorkerIds()).toEqual([]);
  });
});
