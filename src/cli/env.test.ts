import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function loadEnvironment(args: string[]) {
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-cli-env-"));
  const envFile = join(stateDir, ".env");
  writeFileSync(envFile, 'RAVI_TEST_RELOADED="fresh-from-managed-file"\nRAVI_TEST_MISSING=added-from-file\n');
  const script = `
    process.argv = [process.execPath, "/pm2/ProcessContainer.js", ...${JSON.stringify(args)}];
    await import(${JSON.stringify(new URL("./env.ts", import.meta.url).href)});
    const { isRaviEnvFileSourced } = await import(${JSON.stringify(new URL("../runtime/ravi-env-file-origin.ts", import.meta.url).href)});
    console.log(JSON.stringify({
      reloaded: process.env.RAVI_TEST_RELOADED,
      missing: process.env.RAVI_TEST_MISSING,
      inheritedOnly: process.env.RAVI_TEST_INHERITED_ONLY,
      fileSourced: isRaviEnvFileSourced(process.env, "RAVI_TEST_RELOADED", ${JSON.stringify(envFile)}),
    }));
  `;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RAVI_")));
    const result = spawnSync(process.execPath, ["--eval", script], {
      env: {
        ...env,
        RAVI_STATE_DIR: stateDir,
        RAVI_TEST_RELOADED: "stale-inherited-value",
        RAVI_TEST_INHERITED_ONLY: "external-value",
      },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    return JSON.parse(result.stdout);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("CLI managed environment bootstrap", () => {
  it("reloads channel runner values over stale inherited PM2 or updater values", () => {
    expect(loadEnvironment(["channels", "run"])).toEqual({
      reloaded: "fresh-from-managed-file",
      missing: "added-from-file",
      inheritedOnly: "external-value",
      fileSourced: true,
    });
  });

  it("preserves inherited values for an ordinary CLI invocation while loading missing keys", () => {
    expect(loadEnvironment(["channels", "status", "--json"])).toEqual({
      reloaded: "stale-inherited-value",
      missing: "added-from-file",
      inheritedOnly: "external-value",
      fileSourced: false,
    });
  });
});
