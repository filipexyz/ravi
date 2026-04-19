import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSourceProjectRoot, resolveDaemonRuntimeTarget } from "./daemon.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePackageRoot(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ravi.bot" }), "utf8");
}

function clearDaemonRuntimeEnv(): void {
  delete process.env.RAVI_REPO;
  delete process.env.RAVI_BUNDLE;
  delete process.env.RAVI_DAEMON_CWD;
}

beforeEach(clearDaemonRuntimeEnv);
afterEach(clearDaemonRuntimeEnv);

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("daemon runtime target", () => {
  it("restarts the installed runtime from any operator cwd without requiring a source project root", () => {
    const tempRoot = makeTempDir("ravi-daemon-runtime-");
    const bundlePath = join(tempRoot, "install", "global", "node_modules", "ravi.bot", "dist", "bundle", "index.js");
    const operatorHome = join(tempRoot, "home", "ravi");

    mkdirSync(join(bundlePath, ".."), { recursive: true });
    mkdirSync(operatorHome, { recursive: true });
    writeFileSync(bundlePath, "", "utf8");

    expect(
      resolveDaemonRuntimeTarget({
        cwd: operatorHome,
        argvEntry: bundlePath,
        daemonCwd: operatorHome,
      }),
    ).toEqual({
      bundlePath: realpathSync(bundlePath),
      cwd: operatorHome,
    });
  });

  it("infers daemon cwd from the bundle project root when no explicit cwd is configured", () => {
    const tempRoot = makeTempDir("ravi-daemon-bundle-root-");
    const sourceRoot = join(tempRoot, "source");
    const bundlePath = join(sourceRoot, "dist", "bundle", "index.js");
    const operatorHome = join(tempRoot, "home", "ravi");

    writePackageRoot(sourceRoot);
    mkdirSync(join(bundlePath, ".."), { recursive: true });
    mkdirSync(operatorHome, { recursive: true });
    writeFileSync(bundlePath, "", "utf8");

    expect(
      resolveDaemonRuntimeTarget({
        cwd: operatorHome,
        argvEntry: bundlePath,
      }),
    ).toEqual({
      bundlePath: realpathSync(bundlePath),
      cwd: realpathSync(sourceRoot),
    });
  });

  it("uses a source project root only for build/dev flows", () => {
    const tempRoot = makeTempDir("ravi-daemon-source-root-");
    const sourceRoot = join(tempRoot, "source");
    const operatorHome = join(tempRoot, "home", "ravi");

    writePackageRoot(sourceRoot);
    mkdirSync(operatorHome, { recursive: true });

    expect(findSourceProjectRoot({ configuredPath: null, cwd: operatorHome })).toBeNull();
    expect(
      resolveDaemonRuntimeTarget({
        build: true,
        configuredPath: sourceRoot,
        cwd: operatorHome,
      }),
    ).toEqual({
      bundlePath: join(realpathSync(sourceRoot), "dist", "bundle", "index.js"),
      cwd: realpathSync(sourceRoot),
      sourceProjectRoot: realpathSync(sourceRoot),
    });
  });
});
