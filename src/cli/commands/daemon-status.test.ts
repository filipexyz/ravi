import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pm2Process } from "../../pm2.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { buildDaemonStatusJson } from "./daemon.js";
import { daemonStatusReturnSchema } from "./operational-return-schemas.js";

let stateDir: string;
const startedAt = 1_800_000_000_000;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-daemon-freshness-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

function fixture() {
  const cwd = join(stateDir, "package");
  const bundlePath = join(cwd, "dist/bundle/index.js");
  mkdirSync(join(cwd, "dist/bundle"), { recursive: true });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "ravi.bot", version: "new-on-disk" }));
  writeFileSync(bundlePath, "// replaced after the runner started");
  utimesSync(bundlePath, new Date(startedAt + 60_000), new Date(startedAt + 60_000));
  const process = (name: string, pid: number): Pm2Process => ({
    name,
    pid,
    pm_id: pid,
    status: "online",
    cpu: 0,
    memory: 0,
    cwd,
    execPath: name === "ravi" ? bundlePath : "/usr/bin/bun",
    args: name === "ravi" ? ["daemon", "run"] : [bundlePath, "channels", "run"],
    startedAt,
    createdAt: startedAt - 86_400_000,
  });
  return { bundlePath, processes: [process("ravi", 110), process("ravi-channels", 220)] };
}

describe("daemon status process freshness", () => {
  it("never attributes today's disk version to legacy live processes", () => {
    const { bundlePath, processes } = fixture();
    const status = buildDaemonStatusJson(false, { pm2Available: true, processes, cliBundlePath: bundlePath });
    expect(daemonStatusReturnSchema.safeParse(status).success).toBe(true);
    expect(status.runtime.alignment).toBe("drifted");
    for (const member of [status.runtime.daemon, status.runtime.channels]) {
      expect(member).toMatchObject({
        runningVersion: null,
        diskVersion: "new-on-disk",
        startedAt,
        stale: true,
        codeStale: true,
      });
      expect(member).not.toHaveProperty("version");
      expect(member.matchesCli).not.toBe(true);
    }
    expect(status.ravi).toMatchObject({ runningVersion: null, stale: true });
  });

  it("names both unreloaded processes and explicit commands after an env write", () => {
    const { bundlePath, processes } = fixture();
    const envFile = join(stateDir, ".env");
    writeFileSync(envFile, "EXAMPLE_KEY=do-not-print-this\n");
    utimesSync(envFile, new Date(startedAt + 120_000), new Date(startedAt + 120_000));
    const status = buildDaemonStatusJson(false, { pm2Available: true, processes, cliBundlePath: bundlePath });
    expect(status.runtime.daemon.envStale).toBe(true);
    expect(status.runtime.channels.envStale).toBe(true);
    expect(status.warnings.join("\n")).toContain("ravi channels restart");
    expect(status.warnings.join("\n")).toContain("ravi daemon restart");
    expect(JSON.stringify(status)).not.toContain("do-not-print-this");
  });
});
