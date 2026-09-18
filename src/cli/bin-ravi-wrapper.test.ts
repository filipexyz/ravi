import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/ravi");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface CheckoutOptions {
  withBundle?: boolean;
  staleSrc?: boolean;
  stalePackageJson?: boolean;
  buildOutput?: string;
  buildFails?: boolean;
}

/**
 * Throwaway checkout shaped like this repo: `bin/ravi`, a `src/` tree, a
 * package.json whose build scripts write the bundle, and an optional prebuilt
 * bundle. The wrapper derives its project root from its own path, so the fixture
 * has to live in the same layout.
 */
function makeCheckout(options: CheckoutOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-wrapper-"));
  tempDirs.push(root);

  mkdirSync(join(root, "bin"), { recursive: true });
  copyFileSync(WRAPPER, join(root, "bin", "ravi"));
  mkdirSync(join(root, "src", "cli"), { recursive: true });
  writeFileSync(join(root, "src", "cli", "index.ts"), "export {};\n");

  const marker = options.buildOutput ?? "REBUILT-OK";
  const buildScript = options.buildFails
    ? "exit 1"
    : `mkdir -p dist/bundle && printf 'console.log("${marker}");\\n' > dist/bundle/index.js`;
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { "build:cli": buildScript, "gen:plugins": "exit 0" } }, null, 2),
  );

  if (options.withBundle !== false) {
    mkdirSync(join(root, "dist", "bundle"), { recursive: true });
    writeFileSync(join(root, "dist", "bundle", "index.js"), 'console.log("BUNDLE-OK");\n');
  }

  // Timestamps come last: creating files bumps directory mtimes, and the wrapper
  // compares mtimes, so the fixture has to end in the exact state under test.
  const past = new Date(Date.now() - 60_000);
  const now = new Date();
  if (options.withBundle !== false) {
    utimesSync(join(root, "dist", "bundle", "index.js"), past, past);
  }
  utimesSync(join(root, "src", "cli", "index.ts"), options.staleSrc ? now : past, options.staleSrc ? now : past);
  utimesSync(join(root, "src", "cli"), past, past);
  utimesSync(join(root, "src"), past, past);
  const packageJsonTime = options.stalePackageJson ? now : past;
  utimesSync(join(root, "package.json"), packageJsonTime, packageJsonTime);

  return root;
}

interface GlobalInstallOptions {
  withBundle?: boolean;
}

/**
 * Throwaway `bun install -g ravi.bot` layout: the published tarball under
 * `.bun/install/global/node_modules/ravi.bot` (only `bin/ravi`, `dist/bundle/` and
 * package.json -- no `src/`, per the `files` whitelist) plus the `.bun/bin/ravi`
 * symlink that ends up on PATH. package.json is deliberately newer than the bundle,
 * which is the state a real extracted install was found in, and `build:cli` records
 * that it ran so the test can prove the wrapper never invoked it.
 */
function makeGlobalInstall(options: GlobalInstallOptions = {}): { root: string; pathBin: string; pkg: string } {
  const root = mkdtempSync(join(tmpdir(), "ravi-global-"));
  tempDirs.push(root);

  const pkg = join(root, ".bun", "install", "global", "node_modules", "ravi.bot");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  copyFileSync(WRAPPER, join(pkg, "bin", "ravi"));
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify(
      {
        name: "ravi.bot",
        version: "3.260918.5",
        scripts: {
          "build:cli": "mkdir -p dist && touch dist/.build-invoked && exit 1",
          "gen:plugins": "exit 0",
        },
      },
      null,
      2,
    ),
  );

  if (options.withBundle !== false) {
    mkdirSync(join(pkg, "dist", "bundle"), { recursive: true });
    writeFileSync(join(pkg, "dist", "bundle", "index.js"), 'console.log("BUNDLE-OK");\n');
  }

  mkdirSync(join(root, ".bun", "bin"), { recursive: true });
  const pathBin = join(root, ".bun", "bin", "ravi");
  symlinkSync(join(pkg, "bin", "ravi"), pathBin);

  const past = new Date(Date.now() - 60_000);
  const now = new Date();
  if (options.withBundle !== false) {
    utimesSync(join(pkg, "dist", "bundle", "index.js"), past, past);
  }
  utimesSync(join(pkg, "package.json"), now, now);

  return { root, pathBin, pkg };
}

function runWrapperBinary(wrapper: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [wrapper, "--version"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runWrapper(root: string, env: Record<string, string> = {}) {
  return runWrapperBinary(join(root, "bin", "ravi"), env);
}

describe("bin/ravi single execution path", () => {
  it("runs the bundle without rebuilding when it is current", () => {
    const root = makeCheckout();
    const result = runWrapper(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BUNDLE-OK");
    expect(result.stderr).not.toContain("rebuilding");
  });

  it("rebuilds and runs the bundle when src/ moved on", () => {
    const root = makeCheckout({ staleSrc: true });
    const result = runWrapper(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REBUILT-OK");
    expect(result.stderr).toContain("rebuilding dist/bundle");
    // The artifact on disk is now current, not just what we ran.
    expect(readFileSync(join(root, "dist", "bundle", "index.js"), "utf8")).toContain("REBUILT-OK");
  });

  it("rebuilds when package.json moved on in a source checkout", () => {
    const root = makeCheckout({ stalePackageJson: true });
    const result = runWrapper(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REBUILT-OK");
    expect(result.stderr).toContain("bundle is older than");
    expect(result.stderr).toContain("package.json");
  });

  it("rebuilds when there is no bundle at all", () => {
    const root = makeCheckout({ withBundle: false });
    const result = runWrapper(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REBUILT-OK");
    expect(result.stderr).toContain("no bundle at dist/bundle/index.js");
  });

  it("refuses to run instead of falling back when the rebuild fails", () => {
    const root = makeCheckout({ staleSrc: true, buildFails: true });
    const result = runWrapper(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build failed");
    expect(result.stderr).toContain("refusing to run a stale bundle");
    expect(result.stdout).not.toContain("BUNDLE-OK");
  });

  it("leaves no build lock behind after a successful rebuild", () => {
    const root = makeCheckout({ staleSrc: true });
    runWrapper(root);

    expect(existsSync(join(root, "dist", ".build.lock"))).toBe(false);
  });

  it("lets RAVI_ALLOW_STALE_BUNDLE skip the freshness check", () => {
    const root = makeCheckout({ staleSrc: true });
    const result = runWrapper(root, { RAVI_ALLOW_STALE_BUNDLE: "1" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BUNDLE-OK");
    expect(result.stderr).not.toContain("rebuilding");
  });
});

describe("bin/ravi from an installed package", () => {
  it("runs the shipped bundle even when package.json is newer, without rebuilding", () => {
    const install = makeGlobalInstall();
    const result = runWrapperBinary(install.pathBin);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BUNDLE-OK");
    expect(result.stderr).toBe("");
    // `build:cli` was never invoked: there is no src/ to build from in a global install.
    expect(existsSync(join(install.pkg, "dist", ".build-invoked"))).toBe(false);
    expect(existsSync(join(install.pkg, "dist", ".build.lock"))).toBe(false);
  });

  it("refuses with a reinstall hint when the package has no bundle, instead of trying to build", () => {
    const install = makeGlobalInstall({ withBundle: false });
    const result = runWrapperBinary(install.pathBin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no bundle at");
    expect(result.stderr).toContain("no source tree to rebuild it from");
    expect(result.stderr).toContain("bun install -g ravi.bot");
    expect(result.stderr).not.toContain("rebuilding");
    expect(result.stdout).toBe("");
    expect(existsSync(join(install.pkg, "dist", ".build-invoked"))).toBe(false);
  });
});
