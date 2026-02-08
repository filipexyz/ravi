/**
 * Tests for Transcript Parser
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript, parseTranscriptAsync, formatTranscript } from "../transcript-parser.js";

const TEST_DIR = "/tmp/ravi-test-transcript-parser";

describe("parseTranscript", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("parses user messages", () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    const content = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Hello world" }] },
      timestamp: "2026-02-08T10:00:00Z",
    });
    writeFileSync(transcriptPath, content);

    const messages = parseTranscript(transcriptPath);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello world");
    expect(messages[0].timestamp).toBe("2026-02-08T10:00:00Z");
  });

  test("parses assistant messages", () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    const content = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
      timestamp: "2026-02-08T10:00:01Z",
    });
    writeFileSync(transcriptPath, content);

    const messages = parseTranscript(transcriptPath);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("Hi there!");
  });

  test("handles multiple text blocks", () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
        ],
      },
    });
    writeFileSync(transcriptPath, content);

    const messages = parseTranscript(transcriptPath);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("First part\nSecond part");
  });

  test("extracts tool calls from assistant", () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool_use", name: "Read", input: { file_path: "/test.txt" } },
        ],
      },
    });
    writeFileSync(transcriptPath, content);

    const messages = parseTranscript(transcriptPath);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("Let me check");
    expect(messages[1].role).toBe("tool");
    expect(messages[1].content).toContain("[Tool: Read]");
  });

  test("extracts tool results from user", () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "File contents here" }],
      },
    });
    writeFileSync(transcriptPath, content);

    const messages = parseTranscript(transcriptPath);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].content).toContain("[Result]");
  });

  test("handles multiple lines", () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Message 1" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Response 1" }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Message 2" }] },
      }),
    ].join("\n");
    writeFileSync(transcriptPath, lines);

    const messages = parseTranscript(transcriptPath);

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("Message 1");
    expect(messages[1].content).toBe("Response 1");
    expect(messages[2].content).toBe("Message 2");
  });

  test("skips queue-operation entries", () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      }),
    ].join("\n");
    writeFileSync(transcriptPath, lines);

    const messages = parseTranscript(transcriptPath);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello");
  });

  test("skips malformed JSON lines", () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    const lines = [
      "not valid json",
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Valid" }] },
      }),
      "{ broken json",
    ].join("\n");
    writeFileSync(transcriptPath, lines);

    const messages = parseTranscript(transcriptPath);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Valid");
  });

  test("handles empty file", () => {
    const transcriptPath = join(TEST_DIR, "empty.jsonl");
    writeFileSync(transcriptPath, "");

    const messages = parseTranscript(transcriptPath);

    expect(messages).toHaveLength(0);
  });

  test("handles file with only whitespace", () => {
    const transcriptPath = join(TEST_DIR, "whitespace.jsonl");
    writeFileSync(transcriptPath, "   \n\n   \n");

    const messages = parseTranscript(transcriptPath);

    expect(messages).toHaveLength(0);
  });

  test("returns empty array for non-existent file", () => {
    const messages = parseTranscript("/nonexistent/file.jsonl");
    expect(messages).toHaveLength(0);
  });
});

describe("parseTranscriptAsync", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("parses same as sync version", async () => {
    const transcriptPath = join(TEST_DIR, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
      }),
    ].join("\n");
    writeFileSync(transcriptPath, lines);

    const syncMessages = parseTranscript(transcriptPath);
    const asyncMessages = await parseTranscriptAsync(transcriptPath);

    expect(asyncMessages).toEqual(syncMessages);
  });
});

describe("formatTranscript", () => {
  test("formats messages with prefixes", () => {
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there!" },
    ];

    const formatted = formatTranscript(messages);

    expect(formatted).toContain("[User] Hello");
    expect(formatted).toContain("[Assistant] Hi there!");
  });

  test("excludes tool messages by default", () => {
    const messages = [
      { role: "user" as const, content: "Check file" },
      { role: "tool" as const, content: "[Tool: Read] ..." },
      { role: "assistant" as const, content: "Done" },
    ];

    const formatted = formatTranscript(messages);

    expect(formatted).toContain("[User]");
    expect(formatted).toContain("[Assistant]");
    expect(formatted).not.toContain("[Tool]");
  });

  test("includes tool messages when option set", () => {
    const messages = [
      { role: "user" as const, content: "Check file" },
      { role: "tool" as const, content: "[Tool: Read] ..." },
      { role: "assistant" as const, content: "Done" },
    ];

    const formatted = formatTranscript(messages, { includeTools: true });

    expect(formatted).toContain("[Tool]");
  });

  test("separates messages with double newlines", () => {
    const messages = [
      { role: "user" as const, content: "One" },
      { role: "assistant" as const, content: "Two" },
    ];

    const formatted = formatTranscript(messages);

    expect(formatted).toBe("[User] One\n\n[Assistant] Two");
  });

  test("handles empty array", () => {
    const formatted = formatTranscript([]);
    expect(formatted).toBe("");
  });

  test("handles system messages", () => {
    const messages = [{ role: "system" as const, content: "System info" }];

    const formatted = formatTranscript(messages);

    expect(formatted).toContain("[System] System info");
  });
});
