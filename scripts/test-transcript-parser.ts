#!/usr/bin/env bun
/**
 * Test script for transcript parser
 *
 * Usage: bun scripts/test-transcript-parser.ts [path-to-jsonl]
 */

import { parseTranscript, formatTranscript } from "../src/hooks/transcript-parser.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SAMPLE_TRANSCRIPT_DIR = join(
  process.env.HOME || "",
  ".claude/projects/-Users-luis-ravi-main"
);

async function main() {
  // Get transcript path from args or use a sample
  let transcriptPath = process.argv[2];

  if (!transcriptPath) {
    // Find a non-empty transcript
    if (existsSync(SAMPLE_TRANSCRIPT_DIR)) {
      const files = readdirSync(SAMPLE_TRANSCRIPT_DIR)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({
          path: join(SAMPLE_TRANSCRIPT_DIR, f),
          size: require("node:fs").statSync(join(SAMPLE_TRANSCRIPT_DIR, f)).size,
        }))
        .filter((f) => f.size > 0)
        .sort((a, b) => b.size - a.size);

      if (files.length > 0) {
        transcriptPath = files[0].path;
        console.log(`Using largest transcript: ${transcriptPath} (${files[0].size} bytes)`);
      }
    }
  }

  if (!transcriptPath) {
    console.error("No transcript path provided and no sample found");
    process.exit(1);
  }

  if (!existsSync(transcriptPath)) {
    console.error(`Transcript not found: ${transcriptPath}`);
    process.exit(1);
  }

  console.log("\n=== Testing parseTranscript ===\n");

  const messages = parseTranscript(transcriptPath);
  console.log(`Parsed ${messages.length} messages`);

  // Show message distribution
  const byRole = {
    user: messages.filter((m) => m.role === "user").length,
    assistant: messages.filter((m) => m.role === "assistant").length,
    tool: messages.filter((m) => m.role === "tool").length,
    system: messages.filter((m) => m.role === "system").length,
  };
  console.log("\nMessage distribution:");
  console.log(`  User: ${byRole.user}`);
  console.log(`  Assistant: ${byRole.assistant}`);
  console.log(`  Tool: ${byRole.tool}`);
  console.log(`  System: ${byRole.system}`);

  // Show first few messages
  console.log("\n=== First 5 messages ===\n");
  for (const msg of messages.slice(0, 5)) {
    const preview = msg.content.slice(0, 100).replace(/\n/g, "\\n");
    console.log(`[${msg.role}] ${preview}${msg.content.length > 100 ? "..." : ""}`);
  }

  console.log("\n=== Testing formatTranscript (no tools) ===\n");

  const formatted = formatTranscript(messages, { maxMessages: 10, includeTools: false });
  console.log(formatted.slice(0, 1500));
  if (formatted.length > 1500) {
    console.log(`\n... [truncated, total ${formatted.length} chars]`);
  }

  console.log("\n=== Testing formatTranscript (with tools) ===\n");

  const formattedWithTools = formatTranscript(messages, { maxMessages: 5, includeTools: true });
  console.log(formattedWithTools.slice(0, 1500));
  if (formattedWithTools.length > 1500) {
    console.log(`\n... [truncated, total ${formattedWithTools.length} chars]`);
  }

  console.log("\n=== Test complete! ===\n");
}

main().catch(console.error);
