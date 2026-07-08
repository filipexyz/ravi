/**
 * R6 / R12 / R13 — frozen memory snapshot for the system prompt.
 *
 * Reads the agent's `MEMORY.md` whole-file (R13), wraps injection patterns
 * (R9 keep-visible so the model never sees the raw override), and returns a
 * `PromptContextSection` slotted into the volatile tier right after the
 * project rules (AGENTS.md, priority 25) and before the agent's own
 * `systemPromptAppend` (priority 35). Content is captured once per prompt
 * build — R6 frozen: mid-session writes hit disk but do not mutate the
 * assembled prompt until the next rebuild (boot or PreCompact).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptContextSection } from "../prompt-builder.js";
import { scanInjection } from "./scan-injection.js";

export const MEMORY_PROMPT_SECTION_ID = "runtime.memory_snapshot";
export const MEMORY_PROMPT_SECTION_PRIORITY = 30;
export const MEMORY_PROMPT_SECTION_TITLE = "Auto Memory Snapshot";

interface MemorySnapshotOptions {
  /** Override the default `<agentCwd>/MEMORY.md` path. */
  memoryPath?: string;
}

/**
 * Assemble the memory snapshot section for the current prompt build.
 *
 * Returns `null` when there is no `MEMORY.md` (R26 cold-start is a valid
 * state — no section, no error) or when the file is empty after trimming.
 * A file that contains only injection matches still returns a section: the
 * wrapper carries `[BLOCKED:...]` markers and the model sees only the
 * placeholders (R9).
 */
export function buildMemoryPromptSection(
  agentCwd: string,
  options: MemorySnapshotOptions = {},
): PromptContextSection | null {
  const memoryPath = options.memoryPath ?? join(agentCwd, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    return null;
  }
  const raw = readFileSync(memoryPath, "utf-8");
  if (!raw.trim()) {
    return null;
  }

  const scan = scanInjection(raw);
  const wrapped = scan.hasInjection ? scan.wrapped : raw;

  return {
    id: MEMORY_PROMPT_SECTION_ID,
    title: MEMORY_PROMPT_SECTION_TITLE,
    priority: MEMORY_PROMPT_SECTION_PRIORITY,
    source: memoryPath,
    content: buildContent(wrapped, memoryPath, scan.hasInjection, scan.matches.length),
  };
}

function buildContent(wrapped: string, memoryPath: string, hadInjection: boolean, injectionCount: number): string {
  const header = hadInjection
    ? `Persistent auto-memory loaded from ${memoryPath}. ${injectionCount} suspicious pattern(s) were wrapped in [BLOCKED:injection|...] before injection — the raw file remains visible for a human operator to reconcile.`
    : `Persistent auto-memory loaded from ${memoryPath}. This snapshot was captured at prompt build; mid-turn writes hit disk but do not mutate this prompt (R6).`;
  return `${header}\n\n${wrapped.trim()}`;
}
