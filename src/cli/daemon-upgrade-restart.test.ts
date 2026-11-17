import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  performUpgradeRestart,
  type UpgradeRestartHost,
  type UpgradeRestartProcess,
} from "./daemon-upgrade-restart.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { processes?: UpgradeRestartProcess[]; onDaemonStart?: (stateDir: string) => void } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-upgrade-restart-"));
  roots.push(stateDir);
  new Database(join(stateDir, "ravi.db")).exec("CREATE TABLE legacy (id TEXT)");
  let processes: UpgradeRestartProcess[] = options.processes ?? [
    { name: "ravi", pid: 101, status: "online" },
    { name: "ravi-channels", pid: 102, status: "online" },
  ];
  const exited = new Set<number>();
  const calls: string[] = [];
  let clock = 0;
  const host: UpgradeRestartHost = {
    stateDir,
    list: () => processes.map((entry) => ({ ...entry })),
    stop: (name) => {
      calls.push(`stop ${name}`);
      for (const entry of processes.filter((candidate) => candidate.name === name)) {
        exited.add(entry.pid);
        entry.status = "stopped";
      }
      return 0;
    },
    start: (name) => {
      calls.push(`start ${name}`);
      processes = processes.map((entry) => (entry.name === name ? { ...entry, pid: 200, status: "online" } : entry));
      if (name === "ravi") options.onDaemonStart?.(stateDir);
      return 0;
    },
    startNew: () => {
      calls.push("start new");
      processes.push({ name: "ravi", pid: 200, status: "online" });
      options.onDaemonStart?.(stateDir);
      return 0;
    },
    exitState: (pid) => (exited.has(pid) ? "exited" : "present"),
    wait: async () => {
      clock += 1_000;
    },
    now: () => clock,
    timeoutMs: 5_000,
  };
  return { stateDir, host, calls };
}

/** What a daemon that adopted at its entry leaves behind: the fence table and no maintenance record. */
const adopt = (stateDir: string) =>
  new Database(join(stateDir, "ravi.db")).exec("CREATE TABLE thread_schema_fence (id INTEGER)");

describe("restart onto a pre-fence database", () => {
  it("stops channels then the daemon, starts the daemon, waits for its adoption and starts channels again", async () => {
    const f = fixture({ onDaemonStart: adopt });
    const outcome = await performUpgradeRestart(f.host);
    expect(outcome).toMatchObject({ ok: true, code: "THREAD_FENCE_ADOPTED", channelsStarted: true });
    expect(f.calls).toEqual(["stop ravi-channels", "stop ravi", "start ravi", "start ravi-channels"]);
  });

  it("reports the daemon's own refusal as soon as it is written, without waiting for the timeout", async () => {
    const f = fixture({
      onDaemonStart: (stateDir) => {
        mkdirSync(join(stateDir, "runtime-maintenance"), { recursive: true });
        writeFileSync(
          join(stateDir, "runtime-maintenance", "upgrade-failure.json"),
          JSON.stringify({
            at: 0,
            pid: 200,
            failure: "THREAD_FENCE_UPGRADE_BLOCKED: accepted work with unknown outcome",
          }),
        );
      },
    });
    const outcome = await performUpgradeRestart(f.host);
    expect(outcome).toMatchObject({ ok: false, code: "THREAD_FENCE_UPGRADE_BLOCKED" });
    expect(outcome.message).toContain("unknown outcome");
    expect(f.calls).not.toContain("start ravi-channels");
  });

  it("times out with a pointer to the daemon log when no adoption and no refusal arrives", async () => {
    const f = fixture();
    const outcome = await performUpgradeRestart(f.host);
    expect(outcome).toMatchObject({ ok: false, code: "THREAD_FENCE_UPGRADE_TIMEOUT" });
    expect(outcome.message).toContain("pm2 logs ravi");
  });

  it("with nothing registered it creates the daemon, and leaves an absent channel runner absent", async () => {
    const f = fixture({ processes: [], onDaemonStart: adopt });
    expect(await performUpgradeRestart(f.host)).toMatchObject({ ok: true, channelsStarted: false });
    expect(f.calls).toEqual(["start new"]);
  });

  it("a channel runner the operator stopped stays stopped", async () => {
    const f = fixture({
      processes: [
        { name: "ravi", pid: 101, status: "online" },
        { name: "ravi-channels", pid: 0, status: "stopped" },
      ],
      onDaemonStart: adopt,
    });
    expect(await performUpgradeRestart(f.host)).toMatchObject({ ok: true, channelsStarted: false });
    expect(f.calls).toEqual(["stop ravi", "start ravi"]);
  });

  it("refuses duplicate daemon registrations before stopping anything", async () => {
    const f = fixture({
      processes: [
        { name: "ravi", pid: 101, status: "online" },
        { name: "ravi", pid: 103, status: "online" },
      ],
    });
    expect(await performUpgradeRestart(f.host)).toMatchObject({ ok: false, code: "PM2_FAILED" });
    expect(f.calls).toEqual([]);
  });
});
