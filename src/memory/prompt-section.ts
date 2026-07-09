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
import { DEFAULT_MEMORY_CAP_CHARS } from "./types.js";

export const MEMORY_PROMPT_SECTION_ID = "runtime.memory_snapshot";
export const MEMORY_PROMPT_SECTION_PRIORITY = 30;
export const MEMORY_PROMPT_SECTION_TITLE = "Auto Memory Snapshot";

interface MemorySnapshotOptions {
  /** Override the default `<agentCwd>/MEMORY.md` path. */
  memoryPath?: string;
  /**
   * R13 read-side cap — bound the injected snapshot to the same budget the
   * WRITE side enforces (`DEFAULT_MEMORY_CAP_CHARS`). A `MEMORY.md` larger than
   * cap (manual edit / legacy) is truncated-with-marker rather than injected
   * whole, so the READ side can never bypass the WRITE cap.
   */
  capChars?: number;
}

const TRUNCATION_MARKER_PREFIX = "[memory truncated at read cap";
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

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

  const cap = options.capChars ?? DEFAULT_MEMORY_CAP_CHARS;
  const freshness = newestEntryDate(raw);
  // Truncate the source to cap BEFORE the injection scan so the injected
  // snapshot is bounded by the same budget the write side enforces. Scanning
  // after truncation keeps [BLOCKED:...] markers intact (the wrap only grows
  // content, so we bound the raw first and let the safety wrap ride on top).
  const { text: capped, truncated } = capToBudget(raw, cap);

  const scan = scanInjection(capped);
  const wrapped = scan.hasInjection ? scan.wrapped : capped;

  return {
    id: MEMORY_PROMPT_SECTION_ID,
    title: MEMORY_PROMPT_SECTION_TITLE,
    priority: MEMORY_PROMPT_SECTION_PRIORITY,
    source: memoryPath,
    content: buildContent({
      wrapped,
      memoryPath,
      hadInjection: scan.hasInjection,
      injectionCount: scan.matches.length,
      truncated,
      cap,
      freshness,
    }),
  };
}

/**
 * Keep the head of the file up to `cap` chars (the index/most-salient rows sit
 * at the top of `MEMORY.md`) and append a marker when the tail is dropped, so a
 * truncated store is visible rather than silently short. Cuts on a line
 * boundary to avoid injecting a half-line.
 */
function capToBudget(raw: string, cap: number): { text: string; truncated: boolean } {
  if (raw.length <= cap) {
    return { text: raw, truncated: false };
  }
  const head = raw.slice(0, cap);
  const lastNewline = head.lastIndexOf("\n");
  const clean = lastNewline > 0 ? head.slice(0, lastNewline) : head;
  const droppedChars = raw.length - clean.length;
  return {
    text: `${clean}\n\n${TRUNCATION_MARKER_PREFIX} ${cap} chars — ${droppedChars} trailing chars dropped; read the file directly for the full store]`,
    truncated: true,
  };
}

/** Newest absolute date (R16 provenance) present in the store, or null. */
function newestEntryDate(raw: string): string | null {
  let newest: string | null = null;
  for (const match of raw.matchAll(ISO_DATE_RE)) {
    const candidate = match[0];
    if (newest === null || candidate > newest) {
      newest = candidate;
    }
  }
  return newest;
}

interface BuildContentInput {
  wrapped: string;
  memoryPath: string;
  hadInjection: boolean;
  injectionCount: number;
  truncated: boolean;
  cap: number;
  freshness: string | null;
}

function buildContent(input: BuildContentInput): string {
  const base = input.hadInjection
    ? `Persistent auto-memory loaded from ${input.memoryPath}. ${input.injectionCount} suspicious pattern(s) were wrapped in [BLOCKED:injection|...] before injection — the raw file remains visible for a human operator to reconcile.`
    : `Persistent auto-memory loaded from ${input.memoryPath}. This snapshot was captured at prompt build; mid-turn writes hit disk but do not mutate this prompt (R6).`;
  const freshness = input.freshness ? ` Newest entry: ${input.freshness}.` : "";
  const truncation = input.truncated ? ` Bounded to the ${input.cap}-char read cap (R13); older tail omitted.` : "";
  return `${base}${freshness}${truncation}\n\n${input.wrapped.trim()}`;
}
