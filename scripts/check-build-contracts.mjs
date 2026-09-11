#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Fixed local SDK/OpenAPI targets only. No lifecycle, install, publish or daemon commands.
const workspace = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const mode = process.argv[2] ?? "check";
if (!["check", "preview", "generate"].includes(mode) || process.argv.length > 3) {
  throw new Error("Usage: check-build-contracts.mjs [check|preview|generate]");
}
const rtk = Bun.which("rtk");
if (!rtk) throw new Error("RTK is required for isolated child commands.");
const targets = [
  { kind: "client", path: "packages/ravi-os-sdk/src", versionFile: "version.ts", versionPattern: /SDK_VERSION = "([^"]+)"/ },
  { kind: "swift", path: "packages/ravi-os-swift-sdk/Sources/RaviSDK", versionFile: "RaviVersion.generated.swift", versionPattern: /RAVI_SDK_VERSION = "([^"]+)"/ },
  { kind: "dart", path: "packages/ravi-os-dart-sdk/lib/src", versionFile: "ravi_version.generated.dart", versionPattern: /raviSdkVersion = "([^"]+)"/ },
  { kind: "openapi", path: "docs/openapi.json" },
  { kind: "openapi", path: "openapi.json" },
];
for (const target of targets) {
  const suffix = relative(workspace, realpathSync(join(workspace, target.path)));
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith("../") || suffix.startsWith("..\\")) {
    throw new Error("A generated artifact target escapes the worktree.");
  }
}

const root = mkdtempSync(join(tmpdir(), "ravi-build-contracts-"));
const env = {};
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
const directories = {
  HOME: join(root, "home"), USERPROFILE: join(root, "home"), CODEX_HOME: join(root, "codex"),
  CLAUDE_CONFIG_DIR: join(root, "claude"), APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "runtime"), RAVI_STATE_DIR: join(root, "ravi-state"),
  RAVI_DIR: join(root, "ravi"), TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
  BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"), npm_config_cache: join(root, "npm-cache"),
};
for (const directory of new Set([join(root, "cwd"), ...Object.values(directories)])) mkdirSync(directory, { recursive: true });
Object.assign(env, directories, {
  RAVI_TEST_SANDBOX_ROOT: root, RAVI_SUPPRESS_AUDIT_EVENTS: "1", NODE_ENV: "test", CI: "1", NO_COLOR: "1",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
  HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
  NO_PROXY: "127.0.0.1,localhost,::1",
});
const gitDirectory = Bun.spawnSync([rtk, "proxy", "git", "rev-parse", "--absolute-git-dir"], {
  cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
if (gitDirectory.exitCode !== 0) throw new Error("Cannot resolve worktree metadata for generated provenance.");
env.GIT_DIR = gitDirectory.stdout.toString().trim();
env.GIT_WORK_TREE = workspace;

if (mode === "generate") {
  const existingEdits = Bun.spawnSync([rtk, "proxy", "git", "diff", "--exit-code", "HEAD", "--", ...targets.map((target) => target.path)], {
    cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  if (existingEdits.exitCode !== 0) throw new Error("Generated targets already have changes; refusing to overwrite them.");
}

let failed = false;
for (const target of targets) {
  const existing = join(workspace, target.path);
  const destination = mode === "preview" ? join(root, "generated", target.path) : existing;
  const operation = mode === "check" ? "check" : target.kind === "openapi" ? "emit" : "generate";
  const args = ["sdk", target.kind, operation];
  args.push(target.kind === "openapi" && mode === "check" ? "--against" : "--out", destination, "--json");
  if (target.versionFile) {
    const version = readFileSync(join(existing, target.versionFile), "utf8").match(target.versionPattern)?.[1];
    if (!version) throw new Error("Cannot preserve the current SDK version.");
    args.push("--version", version);
  }
  const child = Bun.spawn([
    rtk, "proxy", process.execPath, "--no-env-file", "--preload",
    join(workspace, "tests/helpers/isolated-test-preload.mjs"), join(workspace, "dist/bundle/index.js"), ...args,
  ], { cwd: join(root, "cwd"), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  console.log(JSON.stringify({ mode, kind: target.kind, target: target.path, exitCode, stdout, stderr }));
  if (exitCode !== 0) {
    failed = true;
    if (mode !== "check") break;
  }
}
console.log(JSON.stringify({ isolatedRoot: root, failed }));
process.exitCode = failed ? 1 : 0;
