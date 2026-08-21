import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(90_000);

const stateDir = mkdtempSync(join(tmpdir(), "ravi-cli-output-native-"));
const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

interface CliProcessResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

function isolatedCliEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RAVI_")));
  return {
    ...env,
    RAVI_STATE_DIR: stateDir,
    RAVI_NO_AUDIT: "1",
    RAVI_SUPPRESS_AUDIT_EVENTS: "1",
  };
}

function runNativeCli(args: string[]): Promise<CliProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli/index.ts", ...args], {
      cwd: process.cwd(),
      env: isolatedCliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

describe("native CLI process output integrity", () => {
  it("delivers a complete piped JSON document larger than 64 KiB", async () => {
    const result = await runNativeCli(["tools", "list", "--json", "--limit", "500"]);

    expect(result.status).toBe(0);
    expect(result.stderr.byteLength).toBe(0);
    expect(result.stdout.byteLength).toBeGreaterThan(64 * 1024);

    const payload = JSON.parse(result.stdout.toString("utf8")) as {
      total: number;
      items: unknown[];
      tools: unknown[];
    };
    expect(payload.total).toBeGreaterThan(0);
    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.tools).toEqual(payload.items);
  });

  it("flushes failure output before preserving exit code 1", async () => {
    const result = await runNativeCli(["audio", "blob", "__missing_output_integrity_probe__"]);

    expect(result.status).toBe(1);
    expect(result.stdout.byteLength).toBe(0);
    expect(result.stderr.toString("utf8")).toBe("Binary resource was not found.\n");
  });

  it("preserves the root version output and exit code 0", async () => {
    const result = await runNativeCli(["--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.toString("utf8")).toBe(`${packageVersion}\n`);
    expect(result.stderr.byteLength).toBe(0);
  });
});
