import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLICATION_CONTEXT_REQUIRED_MESSAGE } from "../../pr/contracts.js";
import { withoutRaviRuntimeContextEnv } from "../../test/ravi-state.js";

const state = mkdtempSync(join(tmpdir(), "ravi-pr-auth-process-"));
afterAll(() => rmSync(state, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(process.execPath, ["--no-env-file", "src/cli/index.ts", "pr", "publish", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...withoutRaviRuntimeContextEnv(),
      RAVI_STATE_DIR: state,
      RAVI_SUPPRESS_AUDIT_EVENTS: "1",
      NATS_URL: "nats://127.0.0.1:1",
    },
  });
}

describe("pr publish process authentication contract", () => {
  it("refuses bare operator preview and execute with one actionable envelope", () => {
    for (const mode of ["--dry-run", "--execute"]) {
      const result = run(["--repo", "o/r", "--base", "dev", "--body-file", "/does-not-exist.md", mode, "--json"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toMatchObject({ success: false, op: "pr publish", error: { code: "PERMISSION_DENIED" } });
      expect(envelope.error.message).toContain(PUBLICATION_CONTEXT_REQUIRED_MESSAGE);
      expect(result.stdout).not.toContain("PUBLICATION_AUDIT_FAILED");
    }
  }, 45_000);

  it("rejects the removed reply-session option as usage error", () => {
    const result = run(["--repo", "o/r", "--base", "dev", "--reply-session", "publisher", "--json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      op: "pr publish",
      error: { code: "USAGE_ERROR", message: expect.stringContaining("--reply-session") },
    });
  }, 25_000);
});
