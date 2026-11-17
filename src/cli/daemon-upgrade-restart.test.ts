import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChannelsStoppedForUpgrade, resumeChannelsAfterUpgrade } from "../threads/fence-adoption.js";
import {
  performUpgradeRestart,
  type UpgradeRestartHost,
  type UpgradeRestartProcess,
} from "./daemon-upgrade-restart.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BUNDLE = "/release/dist/bundle/index.js";
type Behavior = "adopt" | "refuse" | "silent";

/**
 * PM2 plus a simulated daemon of this release: on start it adopts (fence table,
 * no maintenance record) or refuses (failure note), and once ready it runs the
 * real `resumeChannelsAfterUpgrade`, which is what `startDaemon` does after
 * "Daemon ready".
 */
function fixture(options: { processes?: UpgradeRestartProcess[]; behavior?: Behavior } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-upgrade-restart-"));
  roots.push(stateDir);
  new Database(join(stateDir, "ravi.db")).exec("CREATE TABLE legacy (id TEXT)");
  const state = {
    behavior: options.behavior ?? ("adopt" as Behavior),
    processes: (options.processes ?? [
      { name: "ravi", pid: 101, status: "online", onTarget: true },
      { name: "ravi-channels", pid: 102, status: "online", onTarget: true },
    ]) as UpgradeRestartProcess[],
    ready: false,
  };
  const exited = new Set<number>();
  const calls: string[] = [];
  let clock = 0;
  let nextPid = 200;

  const setProcess = (name: string, patch: Partial<UpgradeRestartProcess>) => {
    const index = state.processes.findIndex((entry) => entry.name === name);
    const entry: UpgradeRestartProcess = Object.assign(
      { name, pid: 0, status: "stopped", onTarget: true },
      state.processes[index],
      patch,
    );
    if (index >= 0) state.processes[index] = entry;
    else state.processes.push(entry);
  };
  /** One daemon start, as PM2 runs it: adopt or refuse at the entry, then ready. */
  const daemonStarts = () => {
    state.ready = false;
    if (state.behavior === "refuse") {
      mkdirSync(join(stateDir, "runtime-maintenance"), { recursive: true });
      writeFileSync(
        join(stateDir, "runtime-maintenance", "upgrade-failure.json"),
        JSON.stringify({
          at: clock + 1,
          pid: 200,
          failure: "THREAD_FENCE_UPGRADE_BLOCKED: the message broker is unreachable",
        }),
      );
      return;
    }
    if (state.behavior === "silent") return;
    new Database(join(stateDir, "ravi.db")).exec("CREATE TABLE IF NOT EXISTS thread_schema_fence (id INTEGER)");
  };
  /** After "Daemon ready": the real consumer of the intent, against these PM2 registrations. */
  const daemonReady = () => {
    state.ready = true;
    resumeChannelsAfterUpgrade({
      stateDir,
      databasePath: join(stateDir, "ravi.db"),
      ownBundlePath: BUNDLE,
      registry: () =>
        state.processes.map((entry) => ({
          name: entry.name,
          pid: entry.pid,
          startedAt: 1,
          online: entry.status === "online",
          scriptPath: entry.onTarget ? BUNDLE : "/old/dist/bundle/index.js",
          status: entry.status,
        })),
      startExisting: () => {
        calls.push("daemon starts ravi-channels");
        setProcess("ravi-channels", { pid: nextPid++, status: "online" });
        return 0;
      },
      recreate: () => {
        calls.push("daemon recreates ravi-channels");
        setProcess("ravi-channels", { pid: nextPid++, status: "online", onTarget: true });
        return 0;
      },
    });
  };

  const host: UpgradeRestartHost = {
    stateDir,
    list: () => state.processes.map((entry) => ({ ...entry })),
    stop: (name) => {
      calls.push(`stop ${name}`);
      for (const entry of state.processes.filter((candidate) => candidate.name === name)) {
        exited.add(entry.pid);
        entry.status = "stopped";
      }
      return 0;
    },
    start: (name) => {
      calls.push(`start ${name}`);
      setProcess(name, { pid: nextPid++, status: "online" });
      daemonStarts();
      return 0;
    },
    remove: (name) => {
      calls.push(`remove ${name}`);
      state.processes = state.processes.filter((entry) => entry.name !== name);
      return 0;
    },
    startNew: () => {
      calls.push("start new");
      setProcess("ravi", { pid: nextPid++, status: "online", onTarget: true });
      daemonStarts();
      return 0;
    },
    daemonReady: () => {
      // Readiness comes one poll after the adoption, as initialization takes a while.
      const fenced = state.behavior === "adopt";
      if (fenced && !state.ready) {
        daemonReady();
        return false;
      }
      return fenced && state.ready;
    },
    exitState: (pid) => (exited.has(pid) ? "exited" : "present"),
    wait: async () => {
      clock += 1_000;
    },
    now: () => clock,
    timeoutMs: 5_000,
    channelsTimeoutMs: 3_000,
  };
  return { stateDir, host, calls, state, daemonStarts, daemonReady };
}

const runnerOnline = (f: ReturnType<typeof fixture>) =>
  f.state.processes.some((entry) => entry.name === "ravi-channels" && entry.status === "online");

describe("restart onto a pre-fence database", () => {
  it("stops channels then the daemon, starts it, and reports success only once the daemon is ready and the runner is back", async () => {
    const f = fixture();
    const outcome = await performUpgradeRestart(f.host);
    expect(outcome).toMatchObject({ ok: true, code: "THREAD_FENCE_ADOPTED", channelsStarted: true });
    expect(f.calls).toEqual(["stop ravi-channels", "stop ravi", "start ravi", "daemon starts ravi-channels"]);
    expect(f.state.ready).toBe(true);
    expect(readChannelsStoppedForUpgrade(f.stateDir)).toBeNull();
  });

  it("a refusal keeps the runner's intent; PM2's later adopting start brings the runner back", async () => {
    const f = fixture({ behavior: "refuse" });
    const outcome = await performUpgradeRestart(f.host);
    expect(outcome).toMatchObject({ ok: false, code: "THREAD_FENCE_UPGRADE_BLOCKED" });
    expect(outcome.message).toContain("broker is unreachable");
    expect(outcome.message).toContain("PM2 retries");
    expect(runnerOnline(f)).toBe(false);
    expect(readChannelsStoppedForUpgrade(f.stateDir)).toMatchObject({ by: "daemon restart" });
    // PM2 restarts the daemon; the cause is gone and this start adopts, with no CLI around.
    f.state.behavior = "adopt";
    f.daemonStarts();
    f.daemonReady();
    expect(runnerOnline(f)).toBe(true);
    expect(readChannelsStoppedForUpgrade(f.stateDir)).toBeNull();
  });

  it("a refusal followed by the operator repeating the restart brings the runner back and says so", async () => {
    const f = fixture({ behavior: "refuse" });
    expect(await performUpgradeRestart(f.host)).toMatchObject({ ok: false });
    f.state.behavior = "adopt";
    await f.host.wait(); // the operator fixes the cause; time passes
    const second = await performUpgradeRestart(f.host);
    expect(second).toMatchObject({ ok: true, channelsStarted: true });
    expect(second.message).toContain("channel runner started");
    expect(runnerOnline(f)).toBe(true);
  });

  it("a 'ravi' registration on another bundle is replaced, so the legacy never starts again", async () => {
    const f = fixture({
      processes: [
        { name: "ravi", pid: 101, status: "online", onTarget: false },
        { name: "ravi-channels", pid: 102, status: "online", onTarget: false },
      ],
    });
    expect(await performUpgradeRestart(f.host)).toMatchObject({ ok: true, channelsStarted: true });
    expect(f.calls).toEqual([
      "stop ravi-channels",
      "stop ravi",
      "remove ravi",
      "start new",
      "daemon recreates ravi-channels",
    ]);
  });

  it("says when the runner did not come back, without calling the upgrade a failure", async () => {
    const f = fixture();
    f.host.daemonReady = () => {
      f.state.ready = true;
      return true;
    };
    const outcome = await performUpgradeRestart(f.host);
    expect(outcome).toMatchObject({ ok: true, channelsStarted: false });
    expect(outcome.message).toContain("run 'ravi channels start'");
  });

  it("times out with a pointer to the daemon logs when no adoption and no refusal arrives", async () => {
    const f = fixture({ behavior: "silent" });
    const outcome = await performUpgradeRestart(f.host);
    expect(outcome).toMatchObject({ ok: false, code: "THREAD_FENCE_UPGRADE_TIMEOUT" });
    expect(outcome.message).toContain("ravi daemon logs");
  });

  it("with nothing registered it creates the daemon, and leaves an absent channel runner absent", async () => {
    const f = fixture({ processes: [] });
    expect(await performUpgradeRestart(f.host)).toMatchObject({ ok: true, channelsStarted: false });
    expect(f.calls).toEqual(["start new"]);
  });

  it("a channel runner the operator stopped stays stopped", async () => {
    const f = fixture({
      processes: [
        { name: "ravi", pid: 101, status: "online", onTarget: true },
        { name: "ravi-channels", pid: 0, status: "stopped", onTarget: true },
      ],
    });
    expect(await performUpgradeRestart(f.host)).toMatchObject({ ok: true, channelsStarted: false });
    expect(f.calls).toEqual(["stop ravi", "start ravi"]);
    expect(readChannelsStoppedForUpgrade(f.stateDir)).toBeNull();
  });

  it("refuses duplicate daemon registrations before stopping anything", async () => {
    const f = fixture({
      processes: [
        { name: "ravi", pid: 101, status: "online", onTarget: true },
        { name: "ravi", pid: 103, status: "online", onTarget: true },
      ],
    });
    expect(await performUpgradeRestart(f.host)).toMatchObject({ ok: false, code: "PM2_FAILED" });
    expect(f.calls).toEqual([]);
  });
});
