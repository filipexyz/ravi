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
  utimesSync(join(root, "package.json"), past, past);

  return root;
}

function runWrapper(root: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [join(root, "bin", "ravi"), "--version"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
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
