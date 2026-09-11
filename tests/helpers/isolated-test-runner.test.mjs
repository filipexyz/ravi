import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runner = join(repo, "scripts/run-isolated-tests.mjs");
const rtk = Bun.which("rtk");
if (!rtk) throw new Error("RTK is required for isolation tests.");

function parentEnvironment() {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HARNESS_PARENT_SECRET = "synthetic-private-marker";
  env.RAVI_CONTEXT_KEY = "synthetic-runtime-context";
  return env;
}

function run(args, cwd) {
  return Bun.spawnSync([rtk, "proxy", process.execPath, "--no-env-file", runner, ...args], {
    env: parentEnvironment(), cwd, stdout: "pipe", stderr: "pipe",
  });
}

test("isolates legacy default hook and skill writes before importing adapters", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "ravi-runner-contract-"));
  const testFile = join(fixture, "defaults.test.mjs");
  const hookModule = pathToFileURL(join(repo, "src/runtime/codex-hooks.ts")).href;
  const skillsModule = pathToFileURL(join(repo, "src/plugins/codex-skills.ts")).href;
  await Bun.write(join(fixture, ".env"), "HARNESS_DOTENV_SENTINEL=should-not-load\n");
  await Bun.write(testFile, `
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureCodexBashHookConfig } from ${JSON.stringify(hookModule)};
import { syncCodexSkills } from ${JSON.stringify(skillsModule)};
if (process.env.RAVI_TEST_PREFLIGHT_VERIFIED !== "1") throw new Error("preflight did not precede import");
const hook = ensureCodexBashHookConfig();
syncCodexSkills([]);
await Bun.write(join(process.env.RAVI_TEST_SANDBOX_ROOT, "observation.json"), JSON.stringify({
  home: homedir(), hook: hook.path, cwd: process.cwd(),
  leakedParentSecret: process.env.HARNESS_PARENT_SECRET !== undefined,
  leakedContext: process.env.RAVI_CONTEXT_KEY !== undefined,
  loadedDotenv: process.env.HARNESS_DOTENV_SENTINEL !== undefined,
}));
test("isolated import completed", () => expect(hook.changed).toBe(true));
`);
  const result = run([testFile], fixture);
  expect(result.exitCode).toBe(0);
  const events = result.stdout.toString().split("\n").filter((line) => line.startsWith("{")).map(JSON.parse);
  const started = events.find((event) => event.type === "isolated-test");
  expect(started).toBeDefined();
  const observed = JSON.parse(readFileSync(join(started.root, "observation.json"), "utf8"));
  expect(observed.home).toBe(join(started.root, "home"));
  expect(observed.hook).toBe(join(started.root, "home", ".codex", "hooks.json"));
  expect(observed.cwd).toBe(join(started.root, "cwd"));
  expect(observed.leakedParentSecret).toBe(false);
  expect(observed.leakedContext).toBe(false);
  expect(observed.loadedDotenv).toBe(false);
  expect(existsSync(join(started.root, "home", ".cache", "ravi", "codex-skills", "manifest.json"))).toBe(true);
}, 20000);

test("refuses live files and flags before creating a test child", () => {
  const fixture = mkdtempSync(join(tmpdir(), "ravi-runner-reject-"));
  for (const input of ["src/runtime/codex-provider.live.test.ts", "--watch", "src/runtime"]) {
    const result = run([input], fixture);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).not.toContain('"type":"isolated-test"');
  }
}, 15000);

test("rejects an incomplete preflight before evaluating the test module", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "ravi-runner-incomplete-"));
  const marker = join(fixture, "module-evaluated.txt");
  const testFile = join(fixture, "must-not-run.test.mjs");
  await Bun.write(testFile, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "evaluated");`);
  const result = Bun.spawnSync([
    rtk, "proxy", process.execPath, "test", "--no-env-file", "--preload",
    join(repo, "tests/helpers/isolated-test-preload.mjs"), testFile,
  ], {
    env: { ...parentEnvironment(), RAVI_TEST_SANDBOX_ROOT: fixture, HOME: fixture, USERPROFILE: fixture },
    cwd: fixture, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Test path CODEX_HOME is not isolated");
  expect(existsSync(marker)).toBe(false);
}, 10000);
