import { describe, expect, test } from "bun:test";
import { main } from "./cli.js";

describe("Tiny App CLI error contract", () => {
  test("returns deterministic JSON and exit code for invalid usage", async () => {
    const originalWrite = process.stdout.write;
    let stdout = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      expect(await main(["unknown-operation", "--json"], {})).toBe(2);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      failure: {
        version: "ravi.app.failure/v1",
        code: "TINY_INPUT_INVALID",
        category: "validation",
        message:
          "Uso: tiny <config-check|v3-auth-check|read-operation|write-operation> --tenant <tenant> [args] [--input-file <path>] [--dry-run] [--json]",
        retryable: false,
        exitCode: 2,
        details: { source: "tiny" },
      },
    });
  });
});
