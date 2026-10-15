import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { dbDeleteSetting, dbSetSetting } from "../router/router-db.js";
import { dbGetListenerArmed } from "../sandbox/tunnel-state.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  TEST_ACCESS_AUD,
  TEST_ACCESS_CLIENT_ID,
  TEST_ACCESS_TEAM_DOMAIN,
  TEST_INSTALLATION_A,
} from "../test/sandbox-grant-tokens.js";
import {
  type ReadSandboxListenerConfigResult,
  SANDBOX_LISTENER_SETTINGS,
  type SandboxListenerConfig,
} from "./config.js";
import type { SandboxListenerHandle } from "./server.js";
import { SandboxListenerSupervisor, watchSandboxListenerConfig } from "./supervisor.js";

const config = (patch: Partial<SandboxListenerConfig> = {}): SandboxListenerConfig => ({
  port: 47000,
  accessTeamDomain: TEST_ACCESS_TEAM_DOMAIN,
  accessAud: TEST_ACCESS_AUD,
  accessClientId: TEST_ACCESS_CLIENT_ID,
  installationId: TEST_INSTALLATION_A,
  consoleIssuer: "https://console.ravi.bot",
  tunnelHostname: `${TEST_INSTALLATION_A}.tun.ravi.bot`,
  ...patch,
});

function fakeStart() {
  const started: SandboxListenerConfig[] = [];
  const stopped: number[] = [];
  const start = async (cfg: SandboxListenerConfig): Promise<SandboxListenerHandle> => {
    started.push(cfg);
    return {
      host: "127.0.0.1",
      port: cfg.port,
      url: `http://127.0.0.1:${cfg.port}`,
      startedAt: 0,
      tunnelGate: () => ({ open: false, reason: "no_successful_poll" }),
      stop: async () => {
        stopped.push(cfg.port);
      },
    };
  };
  return { start, started, stopped };
}

describe("SandboxListenerSupervisor (fake listener)", () => {
  test("starts, keeps, restarts on any change and stops when the settings go", async () => {
    let read: ReadSandboxListenerConfigResult = { enabled: false, reason: "not_configured" };
    const fake = fakeStart();
    const supervisor = new SandboxListenerSupervisor({ readConfig: () => read, start: fake.start });

    expect(await supervisor.reconcile("boot")).toEqual({ action: "unchanged", enabled: false, port: null });
    read = { enabled: true, config: config() };
    expect(await supervisor.reconcile("config_changed")).toEqual({ action: "started", enabled: true, port: 47000 });
    expect(await supervisor.reconcile("config_changed")).toMatchObject({ action: "unchanged" });
    read = { enabled: true, config: config({ accessAud: "b".repeat(64) }) };
    expect(await supervisor.reconcile("config_changed")).toMatchObject({ action: "restarted", port: 47000 });
    read = { enabled: true, config: config({ port: 47001 }) };
    expect(await supervisor.reconcile("config_changed")).toMatchObject({ action: "restarted", port: 47001 });
    read = { enabled: false, reason: "config_invalid", invalid: ["accessAud"] };
    expect(await supervisor.reconcile("config_changed")).toEqual({ action: "stopped", enabled: false, port: null });
    expect(fake.started.map((cfg) => cfg.port)).toEqual([47000, 47000, 47001]);
    expect(fake.stopped).toEqual([47000, 47000, 47001]);
  });

  test("a failed start leaves it stopped and the next reconcile retries", async () => {
    let fail = true;
    const fake = fakeStart();
    const supervisor = new SandboxListenerSupervisor({
      readConfig: () => ({ enabled: true, config: config() }),
      start: async (cfg) => {
        if (fail) throw new Error("EADDRINUSE");
        return fake.start(cfg);
      },
    });
    expect(await supervisor.reconcile("boot")).toMatchObject({ action: "failed", enabled: false });
    fail = false;
    expect(await supervisor.reconcile("timer")).toMatchObject({ action: "started", enabled: true });
  });

  test("reconciles on every ravi.config.changed event", async () => {
    let read: ReadSandboxListenerConfigResult = { enabled: false, reason: "not_configured" };
    const fake = fakeStart();
    const supervisor = new SandboxListenerSupervisor({ readConfig: () => read, start: fake.start });
    const subjects: string[] = [];
    let push: () => void = () => {};
    async function* events() {
      for (;;) {
        await new Promise<void>((resolve) => (push = resolve));
        yield {};
      }
    }
    const stop = watchSandboxListenerConfig(supervisor, {
      subscribe: (subject) => {
        subjects.push(subject);
        return events();
      },
      intervalMs: 60_000,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      read = { enabled: true, config: config() };
      push();
      for (let i = 0; i < 100 && fake.started.length === 0; i += 1) await new Promise((r) => setTimeout(r, 2));
      expect(subjects).toEqual(["ravi.config.changed"]);
      expect(fake.started).toHaveLength(1);
    } finally {
      stop();
      await supervisor.stop();
    }
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function listening(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
    return response.headers.get("x-ravi-listener") === "1";
  } catch {
    return false;
  }
}

describe("SandboxListenerSupervisor (real listener, settings in ravi.db)", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-listener-supervisor-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
  });

  test("a gateway.listener.port change moves the listener without a daemon restart", async () => {
    const [first, second] = [await freePort(), await freePort()];
    const settings: Record<string, string> = {
      [SANDBOX_LISTENER_SETTINGS.port]: String(first),
      [SANDBOX_LISTENER_SETTINGS.accessTeamDomain]: TEST_ACCESS_TEAM_DOMAIN,
      [SANDBOX_LISTENER_SETTINGS.accessAud]: TEST_ACCESS_AUD,
      [SANDBOX_LISTENER_SETTINGS.accessClientId]: TEST_ACCESS_CLIENT_ID,
      [SANDBOX_LISTENER_SETTINGS.installationId]: TEST_INSTALLATION_A,
      [SANDBOX_LISTENER_SETTINGS.consoleUrl]: "https://console.ravi.bot",
      [SANDBOX_LISTENER_SETTINGS.tunnelHostname]: `${TEST_INSTALLATION_A}.tun.ravi.bot`,
    };
    for (const [key, value] of Object.entries(settings)) dbSetSetting(key, value);
    const supervisor = new SandboxListenerSupervisor();
    try {
      expect(await supervisor.reconcile("boot")).toMatchObject({ action: "started", port: first });
      expect(await listening(first)).toBe(true);
      expect(dbGetListenerArmed()).toMatchObject({ port: first, pid: process.pid });

      dbSetSetting(SANDBOX_LISTENER_SETTINGS.port, String(second));
      expect(await supervisor.reconcile("config_changed")).toMatchObject({ action: "restarted", port: second });
      expect(await listening(first)).toBe(false);
      expect(await listening(second)).toBe(true);
      expect(dbGetListenerArmed()).toMatchObject({ port: second });

      dbDeleteSetting(SANDBOX_LISTENER_SETTINGS.port);
      expect(await supervisor.reconcile("config_changed")).toMatchObject({ action: "stopped" });
      expect(await listening(second)).toBe(false);
      expect(dbGetListenerArmed()).toBeNull();
    } finally {
      await supervisor.stop();
    }
  });
});
