import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "bun:test";

setDefaultTimeout(60_000);

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "bot.runtime-guards.fixture.ts");

describe("RaviBot runtime guards", () => {
  it("pass in an isolated process", () => {
    const result = spawnSync(process.execPath, ["test", fixturePath, "--timeout=30000"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RAVI_TEST_ISOLATED_FIXTURE: "bot-runtime-guards",
      },
      encoding: "utf8",
    });

    if (result.status !== 0) {
      console.error(result.stdout);
      console.error(result.stderr);
    }

    expect(result.status).toBe(0);
  });
});
