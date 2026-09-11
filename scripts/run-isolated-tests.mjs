#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run explicit unit-test files in separate processes. This isolates environment
// and default state paths; it is not an OS filesystem or network sandbox.
const preload = resolve(dirname(fileURLToPath(import.meta.url)), "../tests/helpers/isolated-test-preload.mjs");
const argumentsList = process.argv.slice(2);
const preflightOnly = argumentsList.length === 1 && argumentsList[0] === "--preflight-only";
const rtk = Bun.which("rtk");

function resolveTestFiles() {
  if (preflightOnly) return [null];
  if (argumentsList.length === 0) throw new Error("Pass explicit test files or --preflight-only.");
  return argumentsList.map((input) => {
    if (input.startsWith("-") || !/\.test\.[cm]?[jt]sx?$/.test(input) || /\.live\.test\./.test(input)) {
      throw new Error("Only explicit non-live test files are accepted; directories and runner flags are refused.");
    }
    const file = realpathSync(resolve(input));
    if (!statSync(file).isFile()) throw new Error("The test target must be a file.");
    return file;
  });
}

function createEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "ravi-isolated-tests-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const directories = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    RAVI_STATE_DIR: join(home, ".ravi"),
    RAVI_DIR: join(home, "ravi"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
    npm_config_cache: join(root, "npm-cache"),
  };
  for (const directory of new Set([cwd, ...Object.values(directories)])) {
    mkdirSync(directory, { recursive: true });
  }
  Object.assign(env, directories, {
    RAVI_TEST_SANDBOX_ROOT: root,
    RAVI_SUPPRESS_AUDIT_EVENTS: "1",
    NODE_ENV: "test",
    CI: "1",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1,localhost,::1",
  });
  return { root, cwd, env };
}

try {
  if (!rtk) throw new Error("RTK is required for isolated child commands.");
  const testFiles = resolveTestFiles();
  for (const file of testFiles) {
    const sandbox = createEnvironment();
    console.log(JSON.stringify({ type: file ? "isolated-test" : "isolated-preflight", file, root: sandbox.root }));
    const command = file
      ? [rtk, "proxy", process.execPath, "test", "--no-env-file", "--preload", preload, file]
      : [rtk, "proxy", process.execPath, "--no-env-file", preload];
    const child = Bun.spawn(command, {
      env: sandbox.env, cwd: sandbox.cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      break;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Isolated test setup failed.");
  process.exitCode = 2;
}
