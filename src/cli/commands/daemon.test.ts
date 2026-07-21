import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
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
});
