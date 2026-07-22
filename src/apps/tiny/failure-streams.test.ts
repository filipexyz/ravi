import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

describe("Tiny failure streams", () => {
  test("writes one JSON failure to stdout and leaves stderr empty", async () => {
    const run = spawn(["bun", cliPath, "info", "--json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    const payload = JSON.parse(stdout) as { ok: boolean; failure: Record<string, unknown> };

    expect(exitCode).toBe(2);
    expect(stderr).toBe("");
    expect(payload).toMatchObject({
      ok: false,
      failure: {
        version: "ravi.app.failure/v1",
        code: "TINY_INPUT_INVALID",
        category: "validation",
        retryable: false,
        exitCode: 2,
      },
    });
  });

  test("writes a concise human failure only to stderr", async () => {
    const run = spawn(["bun", cliPath, "info"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("--tenant e obrigatorio");
    expect(stderr.trim().startsWith("{")).toBe(false);
  });
});
