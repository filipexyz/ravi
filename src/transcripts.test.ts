import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { locateRuntimeTranscript } from "./transcripts.js";

const TEST_CWD = "/tmp/ravi-transcript-locator";
const ESCAPED_CWD = TEST_CWD.replace(/\//g, "-");
const PROJECT_ROOT = join(homedir(), ".claude", "projects", ESCAPED_CWD);
const SESSION_ID = "claude-session-test";

describe("locateRuntimeTranscript", () => {
  beforeEach(() => {
    rmSync(PROJECT_ROOT, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(PROJECT_ROOT, { recursive: true, force: true });
  });

  it("finds the direct claude transcript path when present", () => {
    mkdirSync(PROJECT_ROOT, { recursive: true });
    const transcriptPath = join(PROJECT_ROOT, `${SESSION_ID}.jsonl`);
    writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hi"}}\n');

    const result = locateRuntimeTranscript({
      runtimeProvider: "claude",
      providerSessionId: SESSION_ID,
      agentCwd: TEST_CWD,
    });

    expect(result.path).toBe(transcriptPath);
  });

  it("falls back to the largest nested claude transcript file when only subagents remain", () => {
    const nestedRoot = join(PROJECT_ROOT, SESSION_ID, "subagents");
    mkdirSync(nestedRoot, { recursive: true });
    const smaller = join(nestedRoot, "agent-a.jsonl");
    const larger = join(nestedRoot, "agent-b.jsonl");
    writeFileSync(smaller, '{"type":"user","message":{"content":"short"}}\n');
    writeFileSync(larger, `${'{"type":"user","message":{"content":"longer transcript"}}\n'.repeat(5)}`);

    const result = locateRuntimeTranscript({
      runtimeProvider: "claude",
      providerSessionId: SESSION_ID,
      agentCwd: TEST_CWD,
    });

    expect(result.path).toBe(larger);
  });
});
