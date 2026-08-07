import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { DaemonCommands, findSourceProjectRoot, resolveDaemonRuntimeTarget } from "./daemon.js";

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
  it("builds a CLI bundle that PM2 can synchronously require under Bun", () => {
    const tempRoot = makeTempDir("ravi-daemon-pm2-bootstrap-");
    const bundleDir = join(tempRoot, "dist", "bundle");
    const bundlePath = join(bundleDir, "index.js");
    const wrapperPath = join(tempRoot, "pm2-require-wrapper.cjs");
    const fakeBinDir = join(tempRoot, "bin");
    const fakePm2Path = join(fakeBinDir, "pm2");

    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(join(tempRoot, "package.json"), JSON.stringify({ name: "ravi.bot", version: "test" }), "utf8");
    symlinkSync(join(process.cwd(), "node_modules"), join(tempRoot, "node_modules"), "dir");
    writeFileSync(
      wrapperPath,
      [
        'const Module = require("node:module");',
        "const originalRequire = Module.prototype.require;",
        "Module.prototype.require = function patchedRequire() {",
        "  return originalRequire.apply(this, arguments);",
        "};",
        "require(process.env.RAVI_TEST_BUNDLE);",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(fakePm2Path, '#!/bin/sh\n[ "$1" = "jlist" ] && printf "[]"\nexit 0\n', "utf8");
    chmodSync(fakePm2Path, 0o755);

    const build = spawnSync(
      "bun",
      [
        "build",
        "src/cli/index.ts",
        "--outdir",
        bundleDir,
        "--target",
        "bun",
        "--minify",
        "--external",
        "ink",
        "--external",
        "react",
        "--external",
        "@anthropic-ai/*",
        "--external",
        "openai",
        "--external",
        "@google/*",
        "--external",
        "nats",
        "--external",
        "@elevenlabs/*",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    expect(build.status).toBe(0);
    expect(build.stderr).not.toContain("error:");

    const result = spawnSync("bun", [wrapperPath, "daemon", "status"], {
      cwd: tempRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        RAVI_STATE_DIR: join(tempRoot, "state"),
        RAVI_TEST_BUNDLE: bundlePath,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Ravi Daemon Status");
    expect(result.stderr).not.toContain("require() async module");
  });

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

describe("DaemonCommands --json", () => {
  it("prints structured daemon status without stdout fallback fields", () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      new DaemonCommands().status(true);
    } finally {
      console.log = originalLog;
    }

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] ?? "{}");
    expect(typeof payload.pm2Available).toBe("boolean");
    expect(payload.processName).toBe("ravi");
    expect(payload.ravi).toEqual(
      expect.objectContaining({
        name: "ravi",
        managed: expect.any(Boolean),
        running: expect.any(Boolean),
        status: expect.any(String),
      }),
    );
    expect(payload.stdout).toBeUndefined();
    expect(payload.stderr).toBeUndefined();
  });
});

describe("DaemonCommands log transport", () => {
  it("blocks --clear before probing or flushing PM2 when --execute is absent", () => {
    let failure: unknown;
    try {
      runWithContext({ transport: "tool", suppressCliOutput: true }, () =>
        new DaemonCommands().logs(false, "50", true, false, true, undefined),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ContractError);
    expect(failure).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3, op: "daemon logs" });
    expect((failure as ContractError).envelope()).toMatchObject({
      success: false,
      op: "daemon logs",
      error: {
        code: "WRITE_REQUIRES_EXECUTE",
        dryRun: true,
        plan: { action: "flush-logs", process: "ravi" },
      },
    });
  });

  it("rejects an unbounded follow stream before spawning it through a tool transport", () => {
    let failure: unknown;
    try {
      runWithContext({ transport: "tool", suppressCliOutput: true }, () =>
        new DaemonCommands().logs(true, "50", false, false, true),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ContractError);
    expect(failure).toMatchObject({ code: "INTERACTIVE_ONLY", exitCode: 2, op: "daemon logs" });
  });
});

describe("DaemonCommands init-admin-key negated storage", () => {
  let stateDir: string | null = null;
  let previousCredentialsPath: string | undefined;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-daemon-admin-key-");
    previousCredentialsPath = process.env.RAVI_CREDENTIALS_PATH;
    process.env.RAVI_CREDENTIALS_PATH = join(stateDir, "credentials.json");
  });

  afterEach(async () => {
    if (previousCredentialsPath === undefined) delete process.env.RAVI_CREDENTIALS_PATH;
    else process.env.RAVI_CREDENTIALS_PATH = previousCredentialsPath;
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  async function issueAdminKey(noStore: boolean) {
    const originalLog = console.log;
    console.log = () => {};
    try {
      return new DaemonCommands().initAdminKey("test", false, noStore, false, true);
    } finally {
      console.log = originalLog;
    }
  }

  it("persists credentials by default", async () => {
    const result = await issueAdminKey(false);

    expect("persisted" in result).toBe(true);
    if (!("persisted" in result)) throw new Error("expected a newly issued admin key");
    expect(result.persisted).toBe(true);
    expect(result.credentialsPath).toBe(process.env.RAVI_CREDENTIALS_PATH!);
    expect(existsSync(process.env.RAVI_CREDENTIALS_PATH!)).toBe(true);
  });

  it("does not persist credentials when --no-store is present", async () => {
    const result = await issueAdminKey(true);

    expect("persisted" in result).toBe(true);
    if (!("persisted" in result)) throw new Error("expected a newly issued admin key");
    expect(result.persisted).toBe(false);
    expect(result.credentialsPath).toBeNull();
    expect(existsSync(process.env.RAVI_CREDENTIALS_PATH!)).toBe(false);
  });

  it("reports an existing admin context as a policy block", async () => {
    await issueAdminKey(true);

    let failure: unknown;
    try {
      runWithContext({ suppressCliOutput: true }, () =>
        new DaemonCommands().initAdminKey("test", false, true, false, true),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ContractError);
    expect(failure).toMatchObject({ code: "ADMIN_CONTEXT_EXISTS", exitCode: 3, op: "daemon init-admin-key" });
  });
});
