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

describe("pr publish from a terminal, as a real process", () => {
  it("prints one actionable envelope when no reply session is named, in preview and in execute", () => {
    for (const mode of ["--dry-run", "--execute"]) {
      const result = run(["--repo", "o/r", "--base", "dev", "--body-file", "/does-not-exist.md", mode, "--json"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toMatchObject({
        success: false,
        op: "pr publish",
        error: { code: "PUBLICATION_SESSION_REQUIRED", message: expect.stringContaining("--reply-session <session>") },
      });
      expect(result.stdout).not.toContain("PUBLICATION_AUDIT_FAILED");
    }
  }, 45_000);

  it("prints the refusal for a reply session that does not exist, as JSON and as text", () => {
    const json = run(["--repo", "o/r", "--base", "dev", "--reply-session", "no-such-session", "--json"]);
    expect(json.status).toBe(1);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toMatchObject({ success: false, op: "pr publish" });
    expect(json.stdout).not.toContain(PUBLICATION_CONTEXT_REQUIRED_MESSAGE);

    const text = run(["--repo", "o/r", "--base", "dev", "--reply-session", "no-such-session"]);
    expect(text.status).toBe(1);
    expect(text.stdout).toBe("");
    expect(text.stderr.trim().length).toBeGreaterThan(0);
  }, 45_000);

  it("prints usage errors instead of exiting silently", () => {
    const result = run(["--base", "dev", "--json"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      op: "pr publish",
      error: { code: "USAGE_ERROR" },
    });
  }, 25_000);
});
