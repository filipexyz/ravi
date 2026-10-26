/**
 * `claude-jsonl` — Claude Code transcripts under `~/.claude/projects`,
 * older than 90 days.
 *
 * Hard exclusion: nothing under a memory directory is ever a candidate,
 * independent of age: a memory directory holds durable agent memory, not a
 * transcript.
 */

import { existsSync, lstatSync } from "node:fs";
import { walkRegularFiles } from "./fsutil.js";
import type { StoragePolicy } from "./policy.js";
import type { AreaScan, StorageEntry } from "./types.js";

const MAX_DEPTH = 8;

export function scanClaudeJsonlArea(policy: StoragePolicy, now: number): AreaScan {
  const entries: StorageEntry[] = [];
  const limitations: string[] = [];
  const root = policy.claudeProjectsDir;
  if (!root) {
    return { area: "claude-jsonl", entries, limitations: ["claude-jsonl: class disabled"] };
  }
  if (!existsSync(root)) {
    return { area: "claude-jsonl", entries, limitations: [`claude-jsonl: root not present (${root})`] };
  }

  const files = walkRegularFiles(root, { maxDepth: MAX_DEPTH });
  for (const file of files) {
    const name = file.segments[file.segments.length - 1] ?? "";
    if (!name.endsWith(".jsonl")) continue;
    // `memory` is durable state, not a transcript: never a candidate, any depth.
    if (file.segments.slice(0, -1).includes("memory")) {
      entries.push({
        area: "claude-jsonl",
        root,
        path: file.path,
        bytes: sizeOf(file.path),
        decision: "preserved",
        reason: "never delete */memory/*",
      });
      continue;
    }
    const st = lstatSync(file.path);
    const age = now - st.mtimeMs;
    if (age < policy.claudeJsonlMaxAgeMs) {
      entries.push({
        area: "claude-jsonl",
        root,
        path: file.path,
        bytes: st.size,
        decision: "preserved",
        reason: `younger than the ${policy.claudeJsonlMaxAgeMs}ms threshold`,
      });
      continue;
    }
    entries.push({
      area: "claude-jsonl",
      root,
      path: file.path,
      bytes: st.size,
      decision: "candidate",
      reason: "Claude transcript older than the 90-day threshold",
    });
  }

  return { area: "claude-jsonl", entries, limitations };
}

function sizeOf(path: string): number {
  try {
    return lstatSync(path).size;
  } catch {
    return 0;
  }
}
