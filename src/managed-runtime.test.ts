import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManagedRuntimeIdentity,
  managedRuntimeMatchesTarget,
  managedRuntimeWarnings,
  resolveManagedRuntimeTargetFromPackageRoot,
} from "./managed-runtime.js";
import { observeRuntimeBoot, writeRuntimeBootReceipt } from "./runtime-process-identity.js";
import type { Pm2Process } from "./pm2.js";

const START = 1_800_000_000_000;
function createPackage(version: string) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ravi-managed-runtime-")));
  const bundlePath = join(cwd, "dist", "bundle", "index.js");
  const envFile = join(cwd, ".env");
  mkdirSync(join(bundlePath, ".."), { recursive: true });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "ravi.bot", version }), "utf8");
  writeFileSync(bundlePath, "// original bundle", "utf8");
  utimesSync(bundlePath, (START - 1000) / 1000, (START - 1000) / 1000);
  const options = { stateDir: cwd, envFile };
  const observe = () => observeRuntimeBoot({ bundlePath, runningVersion: version, envFile, now: START + 100 });
  const boot = (process: Pm2Process) =>
    writeRuntimeBootReceipt(
      {
        ...observe(),
        schemaVersion: 1,
        name: process.name as "ravi" | "ravi-channels",
        pid: process.pid,
        startedAt: process.startedAt!,
      },
      cwd,
    );
  return { cwd, bundlePath, envFile, options, boot, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}
function pm2Process(
  name: "ravi" | "ravi-channels",
  pkg: ReturnType<typeof createPackage>,
  overrides: Partial<Pm2Process> = {},
): Pm2Process {
  return {
    name,
    pm_id: name === "ravi" ? 1 : 2,
    pid: name === "ravi" ? 100 : 200,
    status: "online",
    cpu: 0,
    memory: 0,
    execPath: name === "ravi" ? pkg.bundlePath : "/usr/local/bin/bun",
    cwd: pkg.cwd,
    args: name === "ravi" ? ["daemon", "run"] : [pkg.bundlePath, "channels", "run"],
    createdAt: START - 9000,
    startedAt: START,
    ...overrides,
  };
}

describe("managed runtime identity", () => {
  it("aligns verified live CLI, daemon and runner boot identities", () => {
    const pkg = createPackage("3.1.0");
    try {
      const processes = [pm2Process("ravi", pkg), pm2Process("ravi-channels", pkg)];
      processes.forEach(pkg.boot);
      expect(buildManagedRuntimeIdentity(processes, pkg.bundlePath, 999, pkg.options)).toMatchObject({
        alignment: "aligned",
        cli: { version: "3.1.0" },
        daemon: { runningVersion: "3.1.0", diskVersion: "3.1.0", startedAt: START, stale: false, matchesCli: true },
        channels: { runningVersion: "3.1.0", diskVersion: "3.1.0", stale: false, matchesCli: true },
      });
    } finally {
      pkg.cleanup();
    }
  });

  it("reports a process started before bundle mtime as stale without replacing its running version", () => {
    const pkg = createPackage("3.1.0");
    try {
      const process = pm2Process("ravi-channels", pkg);
      pkg.boot(process);
      writeFileSync(join(pkg.cwd, "package.json"), JSON.stringify({ name: "ravi.bot", version: "3.2.0" }));
      writeFileSync(pkg.bundlePath, "// new bundle");
      utimesSync(pkg.bundlePath, (START + 5000) / 1000, (START + 5000) / 1000);
      const identity = buildManagedRuntimeIdentity([process], pkg.bundlePath, 999, pkg.options);
      expect(identity.channels).toMatchObject({
        runningVersion: "3.1.0",
        diskVersion: "3.2.0",
        stale: true,
        codeStale: true,
        matchesCli: false,
      });
      expect(identity.alignment).toBe("drifted");
      expect(managedRuntimeWarnings(identity).join("\n")).toContain("ravi channels restart");
    } finally {
      pkg.cleanup();
    }
  });

  it("detects replaced code even with the same version, path and preserved mtime", () => {
    const pkg = createPackage("3.1.0");
    try {
      const process = pm2Process("ravi", pkg);
      pkg.boot(process);
      writeFileSync(pkg.bundlePath, "// changed under same version");
      utimesSync(pkg.bundlePath, (START - 1000) / 1000, (START - 1000) / 1000);
      expect(buildManagedRuntimeIdentity([process], pkg.bundlePath, 999, pkg.options).daemon).toMatchObject({
        runningVersion: "3.1.0",
        diskVersion: "3.1.0",
        stale: true,
        codeStale: true,
      });
    } finally {
      pkg.cleanup();
    }
  });

  it("never reports disk version as runningVersion for a live legacy process", () => {
    const pkg = createPackage("3.2.0");
    try {
      const process = pm2Process("ravi-channels", pkg);
      const identity = buildManagedRuntimeIdentity([process], pkg.bundlePath, 999, pkg.options);
      expect(identity.channels).toMatchObject({
        runningVersion: null,
        diskVersion: "3.2.0",
        identityVerified: false,
        matchesCli: null,
      });
      expect(identity.alignment).toBe("unknown");
    } finally {
      pkg.cleanup();
    }
  });

  it("proves legacy staleness from mtime even when the old version is unknown", () => {
    const pkg = createPackage("3.2.0");
    try {
      utimesSync(pkg.bundlePath, (START + 5000) / 1000, (START + 5000) / 1000);
      expect(
        buildManagedRuntimeIdentity([pm2Process("ravi-channels", pkg)], pkg.bundlePath, 999, pkg.options),
      ).toMatchObject({
        alignment: "drifted",
        channels: { runningVersion: null, stale: true, codeStale: true },
      });
    } finally {
      pkg.cleanup();
    }
  });

  it("warns about an env file newer than each process and keeps alignment drifted", () => {
    const pkg = createPackage("3.1.0");
    try {
      const processes = [pm2Process("ravi", pkg), pm2Process("ravi-channels", pkg)];
      processes.forEach(pkg.boot);
      writeFileSync(pkg.envFile, "EXAMPLE_KEY=secret-never-in-status");
      utimesSync(pkg.envFile, (START + 5000) / 1000, (START + 5000) / 1000);
      const identity = buildManagedRuntimeIdentity(processes, pkg.bundlePath, 999, pkg.options);
      expect(identity.alignment).toBe("drifted");
      expect(identity.channels).toMatchObject({ envStale: true, codeStale: false, stale: true });
      expect(managedRuntimeWarnings(identity).join("\n")).toContain("ravi-channels has a stale environment");
      expect(managedRuntimeWarnings(identity).join("\n")).toContain("ravi daemon restart");
      expect(JSON.stringify(identity)).not.toContain("secret-never-in-status");
    } finally {
      pkg.cleanup();
    }
  });

  it("does not call the runtime aligned when only the channel runner is stale", () => {
    const pkg = createPackage("3.1.0");
    try {
      const daemon = pm2Process("ravi", pkg);
      const channels = pm2Process("ravi-channels", pkg, { startedAt: START - 2000 });
      pkg.boot(daemon);
      pkg.boot(channels);
      const identity = buildManagedRuntimeIdentity([daemon, channels], pkg.bundlePath, 999, pkg.options);
      expect(identity.daemon.stale).toBe(false);
      expect(identity.channels.stale).toBe(true);
      expect(identity.alignment).toBe("drifted");
    } finally {
      pkg.cleanup();
    }
  });

  it("rejects a receipt after PID reuse or a restart with unchanged PM2 creation time", () => {
    const pkg = createPackage("3.1.0");
    try {
      const process = pm2Process("ravi", pkg);
      pkg.boot(process);
      for (const changed of [{ pid: 500 }, { startedAt: START + 1000 }]) {
        const identity = buildManagedRuntimeIdentity([{ ...process, ...changed }], pkg.bundlePath, 999, pkg.options);
        expect(identity.daemon.runningVersion).toBeNull();
        expect(identity.alignment).toBe("unknown");
      }
    } finally {
      pkg.cleanup();
    }
  });

  it("allows verified daemon-only installs without inventing a channel requirement", () => {
    const pkg = createPackage("3.1.0");
    try {
      const daemon = pm2Process("ravi", pkg);
      pkg.boot(daemon);
      expect(buildManagedRuntimeIdentity([daemon], pkg.bundlePath, 999, pkg.options).alignment).toBe("aligned");
    } finally {
      pkg.cleanup();
    }
  });

  it("does not certify alignment when only the channel runner is running", () => {
    const pkg = createPackage("3.1.0");
    try {
      const channels = pm2Process("ravi-channels", pkg);
      pkg.boot(channels);
      expect(buildManagedRuntimeIdentity([channels], pkg.bundlePath, 999, pkg.options).alignment).toBe("unknown");
    } finally {
      pkg.cleanup();
    }
  });

  it("detects different installations and stopped entries without labeling disk versions as running", () => {
    const cli = createPackage("3.1.0");
    const old = createPackage("3.1.0");
    try {
      const identity = buildManagedRuntimeIdentity(
        [pm2Process("ravi", old), pm2Process("ravi-channels", old, { status: "stopped", pid: 0 })],
        cli.bundlePath,
        999,
        cli.options,
      );
      expect(identity.alignment).toBe("drifted");
      expect(identity.daemon.matchesCli).toBe(false);
      expect(identity.channels).toMatchObject({ runningVersion: null, diskVersion: "3.1.0", matchesCli: false });
    } finally {
      cli.cleanup();
      old.cleanup();
    }
  });
});

describe("managed runtime target verification", () => {
  it("requires boot receipts, recreated processes, target bundle and cwd", () => {
    const pkg = createPackage("3.2.0");
    try {
      const target = resolveManagedRuntimeTargetFromPackageRoot(pkg.cwd)!;
      const previous = [
        { name: "ravi", status: "online", pid: 10, createdAt: 1 },
        { name: "ravi-channels", status: "online", pid: 20, createdAt: 1 },
      ];
      const current = [pm2Process("ravi", pkg), pm2Process("ravi-channels", pkg)];
      expect(managedRuntimeMatchesTarget(previous, current, target, pkg.options)).toBe(false);
      current.forEach(pkg.boot);
      expect(managedRuntimeMatchesTarget(previous, current, target, pkg.options)).toBe(true);
      expect(
        managedRuntimeMatchesTarget(previous, [current[0]!, { ...current[1]!, cwd: "/tmp/old" }], target, pkg.options),
      ).toBe(false);
      expect(managedRuntimeMatchesTarget(previous, [current[0]!], target, pkg.options)).toBe(false);
      expect(
        managedRuntimeMatchesTarget(
          [{ name: "ravi", status: "online", pid: current[0]!.pid, createdAt: null }],
          [current[0]!],
          target,
          pkg.options,
        ),
      ).toBe(false);
    } finally {
      pkg.cleanup();
    }
  });
  it("requires stale stopped entries to be removed", () => {
    const pkg = createPackage("3.2.0");
    try {
      const target = resolveManagedRuntimeTargetFromPackageRoot(pkg.cwd)!;
      const previous = [{ name: "ravi-channels", status: "stopped", pid: 0, createdAt: 1 }];
      expect(managedRuntimeMatchesTarget(previous, [], target, pkg.options)).toBe(true);
      expect(
        managedRuntimeMatchesTarget(
          previous,
          [pm2Process("ravi-channels", pkg, { status: "stopped" })],
          target,
          pkg.options,
        ),
      ).toBe(false);
    } finally {
      pkg.cleanup();
    }
  });
});
