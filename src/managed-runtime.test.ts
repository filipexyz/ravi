import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManagedRuntimeIdentity,
  managedRuntimeMatchesTarget,
  resolveManagedRuntimeTargetFromPackageRoot,
} from "./managed-runtime.js";
import type { Pm2Process } from "./pm2.js";

function createPackage(version: string) {
  const cwd = mkdtempSync(join(tmpdir(), "ravi-managed-runtime-"));
  const bundlePath = join(cwd, "dist", "bundle", "index.js");
  mkdirSync(join(bundlePath, ".."), { recursive: true });
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "ravi.bot", version }), "utf8");
  writeFileSync(bundlePath, "", "utf8");
  return {
    cwd: realpathSync(cwd),
    bundlePath: realpathSync(bundlePath),
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function pm2Process(
  name: "ravi" | "ravi-channels",
  bundlePath: string,
  cwd: string,
  overrides: Partial<Pm2Process> = {},
): Pm2Process {
  return {
    name,
    pm_id: name === "ravi" ? 1 : 2,
    pid: name === "ravi" ? 100 : 200,
    status: "online",
    cpu: 0,
    memory: 0,
    execPath: name === "ravi" ? bundlePath : "/usr/local/bin/bun",
    cwd,
    args: name === "ravi" ? ["daemon", "run"] : [bundlePath, "channels", "run"],
    createdAt: 10,
    ...overrides,
  };
}

describe("managed runtime identity", () => {
  it("reports one aligned version across CLI, daemon, and channels", () => {
    const pkg = createPackage("3.1.0");
    try {
      const identity = buildManagedRuntimeIdentity(
        [pm2Process("ravi", pkg.bundlePath, pkg.cwd), pm2Process("ravi-channels", pkg.bundlePath, pkg.cwd)],
        pkg.bundlePath,
        999,
      );
      expect(identity).toMatchObject({
        alignment: "aligned",
        cli: { version: "3.1.0" },
        daemon: { version: "3.1.0", matchesCli: true },
        channels: { version: "3.1.0", matchesCli: true },
      });
    } finally {
      pkg.cleanup();
    }
  });

  it("makes divergent installations explicit even when versions match", () => {
    const cli = createPackage("3.1.0");
    const stale = createPackage("3.1.0");
    try {
      const identity = buildManagedRuntimeIdentity(
        [pm2Process("ravi", stale.bundlePath, stale.cwd), pm2Process("ravi-channels", stale.bundlePath, stale.cwd)],
        cli.bundlePath,
        999,
      );
      expect(identity.alignment).toBe("drifted");
      expect(identity.daemon.matchesCli).toBe(false);
      expect(identity.channels.matchesCli).toBe(false);
    } finally {
      cli.cleanup();
      stale.cleanup();
    }
  });

  it("includes stopped managed entries when detecting persisted drift", () => {
    const current = createPackage("3.2.0");
    const stale = createPackage("3.1.0");
    try {
      const identity = buildManagedRuntimeIdentity(
        [
          pm2Process("ravi", current.bundlePath, current.cwd),
          pm2Process("ravi-channels", stale.bundlePath, stale.cwd, { status: "stopped", pid: 0 }),
        ],
        current.bundlePath,
        999,
      );
      expect(identity.alignment).toBe("drifted");
      expect(identity.channels).toMatchObject({ online: false, version: "3.1.0", matchesCli: false });
    } finally {
      current.cleanup();
      stale.cleanup();
    }
  });
});

describe("managed runtime target verification", () => {
  it("requires recreated online processes to use the target bundle and cwd", () => {
    const targetPackage = createPackage("3.2.0");
    try {
      const target = resolveManagedRuntimeTargetFromPackageRoot(targetPackage.cwd)!;
      const previous = [
        { name: "ravi", status: "online", pid: 10, createdAt: 1 },
        { name: "ravi-channels", status: "online", pid: 20, createdAt: 1 },
      ];
      const current = [
        pm2Process("ravi", target.bundlePath, target.cwd, { pid: 11, createdAt: 2 }),
        pm2Process("ravi-channels", target.bundlePath, target.cwd, { pid: 21, createdAt: 2 }),
      ];

      expect(managedRuntimeMatchesTarget(previous, current, target)).toBe(true);
      expect(managedRuntimeMatchesTarget(previous, [current[0]!, { ...current[1]!, cwd: "/tmp/old" }], target)).toBe(
        false,
      );
      expect(managedRuntimeMatchesTarget(previous, [current[0]!], target)).toBe(false);
      expect(
        managedRuntimeMatchesTarget(
          [{ name: "ravi", status: "online", pid: 11, createdAt: null }],
          [current[0]!],
          target,
        ),
      ).toBe(false);
    } finally {
      targetPackage.cleanup();
    }
  });

  it("requires stale stopped entries to be removed from PM2", () => {
    const targetPackage = createPackage("3.2.0");
    try {
      const target = resolveManagedRuntimeTargetFromPackageRoot(targetPackage.cwd)!;
      expect(
        managedRuntimeMatchesTarget([{ name: "ravi-channels", status: "stopped", pid: 0, createdAt: 1 }], [], target),
      ).toBe(true);
      expect(
        managedRuntimeMatchesTarget(
          [{ name: "ravi-channels", status: "stopped", pid: 0, createdAt: 1 }],
          [pm2Process("ravi-channels", target.bundlePath, target.cwd, { status: "stopped" })],
          target,
        ),
      ).toBe(false);
    } finally {
      targetPackage.cleanup();
    }
  });
});
