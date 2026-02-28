/**
 * Tests for PreCompact Hook
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPreCompactHook } from "../pre-compact.js";

const TEST_DIR = "/tmp/ravi-test-precompact";
const TEST_CWD = join(TEST_DIR, "agent");

// Sample transcript content
const SAMPLE_TRANSCRIPT = [
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Oi, meu nome é Luís" }] },
    timestamp: "2026-02-08T10:00:00Z",
  }),
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Olá Luís! Como posso ajudar?" }] },
    timestamp: "2026-02-08T10:00:01Z",
  }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Minha cor favorita é roxo" }] },
    timestamp: "2026-02-08T10:00:02Z",
  }),
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Anotado! Roxo é uma ótima cor." }] },
    timestamp: "2026-02-08T10:00:03Z",
  }),
].join("\n");

describe("createPreCompactHook", () => {
  beforeEach(() => {
    // Clean up and create test directories
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_CWD, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("creates hook function", () => {
    const hook = createPreCompactHook();
    expect(typeof hook).toBe("function");
  });

  test("returns empty object immediately (non-blocking)", async () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    writeFileSync(transcriptPath, SAMPLE_TRANSCRIPT);

    const hook = createPreCompactHook({ memoryModel: "haiku" });

    const result = await hook(
      {
        hook_event_name: "PreCompact",
        session_id: "test-session",
        transcript_path: transcriptPath,
        cwd: TEST_CWD,
        trigger: "auto",
        custom_instructions: null,
      },
      null,
      { signal: new AbortController().signal },
    );

    // Should return immediately without blocking
    expect(result).toEqual({});
  });

  test("skips extraction if transcript not found", async () => {
    const hook = createPreCompactHook();

    const result = await hook(
      {
        hook_event_name: "PreCompact",
        session_id: "test-session",
        transcript_path: "/nonexistent/path.jsonl",
        cwd: TEST_CWD,
        trigger: "auto",
        custom_instructions: null,
      },
      null,
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({});
  });

  test("skips extraction if transcript is empty", async () => {
    const transcriptPath = join(TEST_DIR, "empty.jsonl");
    writeFileSync(transcriptPath, "");

    const hook = createPreCompactHook();

    const result = await hook(
      {
        hook_event_name: "PreCompact",
        session_id: "test-session",
        transcript_path: transcriptPath,
        cwd: TEST_CWD,
        trigger: "auto",
        custom_instructions: null,
      },
      null,
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({});
  });

  test("loads COMPACT_INSTRUCTIONS.md if exists", async () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    writeFileSync(transcriptPath, SAMPLE_TRANSCRIPT);

    const instructionsPath = join(TEST_CWD, "COMPACT_INSTRUCTIONS.md");
    writeFileSync(instructionsPath, "Custom extraction instructions");

    const hook = createPreCompactHook();

    const result = await hook(
      {
        hook_event_name: "PreCompact",
        session_id: "test-session",
        transcript_path: transcriptPath,
        cwd: TEST_CWD,
        trigger: "manual",
        custom_instructions: null,
      },
      null,
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({});
  });

  test("uses custom_instructions when provided", async () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    writeFileSync(transcriptPath, SAMPLE_TRANSCRIPT);

    const hook = createPreCompactHook();

    const result = await hook(
      {
        hook_event_name: "PreCompact",
        session_id: "test-session",
        transcript_path: transcriptPath,
        cwd: TEST_CWD,
        trigger: "manual",
        custom_instructions: "Focus only on names and preferences",
      },
      null,
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({});
  });
});
