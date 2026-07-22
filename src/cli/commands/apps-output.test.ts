import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const outputBufferBytes = 8 * 1024 * 1024;
const stateDirs: string[] = [];
const contextKeys = [
  "RAVI_CONTEXT_KEY",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_CHANNEL",
  "RAVI_ACCOUNT_ID",
  "RAVI_CHAT_ID",
] as const;

function createIsolatedEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(`${tmpdir()}/ravi-apps-output-`);
  stateDirs.push(root);
  const home = join(root, "home");
  const stateDir = join(root, "state");
  const appsRoot = join(home, "ravi", "plugins", "output-fixtures", "apps");
  mkdirSync(appsRoot, { recursive: true });

  for (const [id, bytes] of [
    ["frete", 2_000],
    ["ads", 760_000],
    ["largest-output-fixture", 1_200_000],
  ] as const) {
    const appRoot = join(appsRoot, id);
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(
      join(appRoot, "ravi.app.json"),
      `${JSON.stringify(
        {
          schema: "ravi.app/v1",
          id,
          name: `${id} output fixture`,
          version: "1.0.0",
          description: "x".repeat(bytes),
          interfaces: { cli: { command: `fixture-${id}`, json: true } },
          permissions: { required: [], optional: [], mutating: [] },
          health: { checks: [] },
        },
        null,
        2,
      )}\n`,
    );
  }

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, RAVI_STATE_DIR: stateDir };
  for (const key of contextKeys) delete env[key];
  return env;
}

afterEach(() => {
  while (stateDirs.length > 0) {
    const stateDir = stateDirs.pop();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("Ravi Apps JSON output", () => {
  test.each([
    ["Frete manifest", ["apps", "show", "frete", "--json"]],
    ["Tiny manifest", ["apps", "show", "tiny", "--json"]],
    ["Ads manifest", ["apps", "show", "ads", "--json"]],
    ["manifest larger than the current catalog maximum", ["apps", "show", "largest-output-fixture", "--json"]],
    ["app guide", ["apps", "guide", "tiny", "--json"]],
    ["isolated operation help", ["tiny", "info", "--help", "--json"]],
  ])(
    "emits one complete JSON document for %s",
    (_label, args) => {
      const env = createIsolatedEnv();

      const run = spawnSync(process.execPath, ["src/cli/index.ts", ...args], {
        cwd: repoRoot,
        env,
        stdio: "pipe",
        maxBuffer: outputBufferBytes,
      });
      const stdout = run.stdout.toString();

      expect(run.status, run.stderr.toString()).toBe(0);
      expect(stdout.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(stdout)).not.toThrow();
      const payload = JSON.parse(stdout) as { app?: { id?: string } };
      expect(payload).toBeObject();
      if (args[0] === "apps" && args[1] === "show") {
        expect(payload.app?.id).toBe(args[2]);
      }
      if (args[2] === "largest-output-fixture") {
        expect(Buffer.byteLength(stdout)).toBeGreaterThan(1_000_000);
      }
    },
    30_000,
  );

  test("renders operation help in human mode without invoking the child", () => {
    const env = createIsolatedEnv();

    const run = spawnSync(process.execPath, ["src/cli/index.ts", "tiny", "info", "--help"], {
      cwd: repoRoot,
      env,
      stdio: "pipe",
      maxBuffer: outputBufferBytes,
    });
    const stdout = run.stdout.toString();

    expect(run.status, run.stderr.toString()).toBe(0);
    expect(stdout).toContain("tiny info");
    expect(stdout).toContain("--tenant");
    expect(stdout).not.toContain("Credencial Tiny ausente");
  }, 30_000);
});
