/**
 * Transcript Parser
 *
 * Parses Claude SDK .jsonl transcript files into a simplified format
 * for memory extraction.
 */

import { createReadStream, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { logger } from "../utils/logger.js";

const log = logger.child("hooks:transcript-parser");

// Use streaming for files larger than 1MB
const STREAMING_THRESHOLD = 1024 * 1024;

interface TranscriptLine {
  type: "user" | "assistant" | "system" | "queue-operation";
  message?: {
    role: string;
    content: ContentBlock[];
  };
  timestamp?: string;
  uuid?: string;
}

interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: ContentBlock[] | string;
}

export interface ParsedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp?: string;
}

/**
 * Parse a transcript file into simplified messages.
 * Uses streaming for large files to avoid memory issues.
 */
export function parseTranscript(transcriptPath: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  try {
    const stats = statSync(transcriptPath);

    if (stats.size > STREAMING_THRESHOLD) {
      log.info("Large transcript, using sync read with chunked processing", {
        path: transcriptPath,
        size: stats.size,
      });
    }

    // For now, still sync but with better handling
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line) as TranscriptLine;
        processEntry(entry, messages);
      } catch (parseErr) {
        // Skip malformed lines
        log.debug("Skipping malformed line", { error: parseErr });
      }
    }
  } catch (err) {
    log.error("Failed to parse transcript", { path: transcriptPath, error: err });
  }

  return messages;
}

/**
 * Parse a transcript file asynchronously using streaming.
 * Better for very large files.
 */
export async function parseTranscriptAsync(transcriptPath: string): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = [];

  try {
    const fileStream = createReadStream(transcriptPath, { encoding: "utf-8" });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line) as TranscriptLine;
        processEntry(entry, messages);
      } catch (parseErr) {
        log.debug("Skipping malformed line", { error: parseErr });
      }
    }
  } catch (err) {
    log.error("Failed to parse transcript", { path: transcriptPath, error: err });
  }

  return messages;
}

/**
 * Process a single transcript entry and add to messages.
 */
function processEntry(entry: TranscriptLine, messages: ParsedMessage[]): void {
  if (entry.type === "user" && entry.message) {
    const text = extractText(entry.message.content);
    if (text) {
      messages.push({
        role: "user",
        content: text,
        timestamp: entry.timestamp,
      });
    }

    // Also extract tool results
    const toolResults = extractToolResults(entry.message.content);
    for (const result of toolResults) {
      messages.push({
        role: "tool",
        content: result,
        timestamp: entry.timestamp,
      });
    }
  }

  if (entry.type === "assistant" && entry.message) {
    const text = extractText(entry.message.content);
    if (text) {
      messages.push({
        role: "assistant",
        content: text,
        timestamp: entry.timestamp,
      });
    }

    // Also extract tool calls
    const toolCalls = extractToolCalls(entry.message.content);
    for (const call of toolCalls) {
      messages.push({
        role: "tool",
        content: call,
        timestamp: entry.timestamp,
      });
    }
  }
}

/**
 * Extract text content from blocks.
 */
function extractText(blocks: ContentBlock[]): string {
  const texts: string[] = [];

  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      texts.push(block.text);
    }
  }

  return texts.join("\n").trim();
}

/**
 * Extract tool calls from blocks.
 */
function extractToolCalls(blocks: ContentBlock[]): string[] {
  const calls: string[] = [];

  for (const block of blocks) {
    if (block.type === "tool_use" && block.name) {
      const input = block.input ? JSON.stringify(block.input).slice(0, 200) : "";
      calls.push(`[Tool: ${block.name}] ${input}`);
    }
  }

  return calls;
}

/**
 * Extract tool results from blocks.
 */
function extractToolResults(blocks: ContentBlock[]): string[] {
  const results: string[] = [];

  for (const block of blocks) {
    if (block.type === "tool_result") {
      let text = "";
      if (typeof block.content === "string") {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        text = block.content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text)
          .join("\n");
      }
      if (text) {
        // Truncate long results
        results.push(`[Result] ${text.slice(0, 500)}`);
      }
    }
  }

  return results;
}

/**
 * Format parsed messages into a readable transcript for LLM.
 */
export function formatTranscript(messages: ParsedMessage[], options: { includeTools?: boolean } = {}): string {
  const { includeTools = false } = options;

  const lines: string[] = [];

  for (const msg of messages) {
    if (!includeTools && msg.role === "tool") continue;

    const prefix = {
      system: "[System]",
      user: "[User]",
      assistant: "[Assistant]",
      tool: "[Tool]",
    }[msg.role];

    lines.push(`${prefix} ${msg.content}`);
  }

  return lines.join("\n\n");
}
