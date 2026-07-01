/**
 * CI quality gate helpers.
 *
 * Deterministic spec validation and focused runtime/consumer coverage
 * checks derived entirely from the PR diff and local ravi specs commands.
 *
 * No external secrets, APIs, or subjective judgements required.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getSpec, getSpecContext, syncSpecs } from "../specs/service.js";

const SPECS_PREFIX = ".ravi/specs/";
const REQUIRED_COMPANIONS = ["WHY.md", "RUNBOOK.md", "CHECKS.md"] as const;

/**
 * Runtime/consumer source path prefixes that require focused test coverage.
 * Each prefix maps to a list of known test file glob patterns.
 */
export const RUNTIME_PATH_MAP: Record<string, string[]> = {
  "src/omni/": ["src/omni/consumer-context.test.ts", "src/omni/consumer-policy.test.ts"],
  "src/router/": ["src/router/router.test.ts", "src/router/sessions.test.ts", "src/router/resolver.test.ts"],
  "src/runtime/": [
    "src/runtime/index.test.ts",
    "src/runtime/model-catalog.test.ts",
    "src/runtime/context-registry.test.ts",
  ],
  "src/session-trace/": ["src/session-trace/session-trace.test.ts"],
  "src/triggers/": ["src/triggers/triggers.test.ts"],
  "src/approval/": ["src/approval/approval.test.ts"],
  "src/devin/": ["src/devin/client.test.ts", "src/devin/store.test.ts"],
};

export interface SpecGateError {
  specId: string;
  error: string;
}

export interface SpecGateResult {
  ok: boolean;
  changedSpecIds: string[];
  syncResult: { total: number } | null;
  errors: SpecGateError[];
}

export interface CoverageGateError {
  path: string;
  prefix: string;
  message: string;
}

export interface CoverageGateResult {
  ok: boolean;
  triggeredPrefixes: string[];
  errors: CoverageGateError[];
}

/**
 * Extract unique spec ids from a list of changed file paths.
 * Only files under `.ravi/specs/` are considered.
 * The spec id is derived from the directory path relative to `.ravi/specs/`.
 */
export function extractChangedSpecIds(changedFiles: string[]): string[] {
  const specIds = new Set<string>();

  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, "/");
    if (!normalized.startsWith(SPECS_PREFIX)) continue;

    const relative = normalized.slice(SPECS_PREFIX.length);
    const parts = relative.split("/");

    // Strip the filename to get the directory-based spec id
    if (parts.length < 2) continue; // need at least domain/file
    const dirParts = parts.slice(0, -1);

    // Spec ids are 1-3 segments deep
    if (dirParts.length < 1 || dirParts.length > 3) continue;

    specIds.add(dirParts.join("/"));
  }

  return [...specIds].sort();
}

/**
 * Check whether the diff contains only docs/spec files (no runtime source).
 */
export function isDocsOnlyDiff(changedFiles: string[]): boolean {
  return changedFiles.every((file) => {
    const normalized = file.replace(/\\/g, "/");
    return (
      normalized.startsWith("docs/") ||
      normalized.startsWith(".ravi/specs/") ||
      normalized.startsWith(".ravi/") ||
      normalized.endsWith(".md") ||
      normalized.endsWith(".mdx")
    );
  });
}

/**
 * Run the spec validation gate against a list of changed files.
 *
 * 1. If any `.ravi/specs/**` files changed, run `syncSpecs()`.
 * 2. For each changed spec id, run `getSpec()` and `getSpecContext()` to
 *    validate structure, frontmatter, kind/depth, and companions.
 */
export function runSpecGate(changedFiles: string[], cwd?: string): SpecGateResult {
  const changedSpecIds = extractChangedSpecIds(changedFiles);
  const result: SpecGateResult = {
    ok: true,
    changedSpecIds,
    syncResult: null,
    errors: [],
  };

  if (changedSpecIds.length === 0) {
    return result;
  }

  // Run sync to validate the full spec tree
  try {
    const sync = syncSpecs({ cwd });
    result.syncResult = { total: sync.total };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.ok = false;
    result.errors.push({ specId: "*", error: `specs sync failed: ${message}` });
    return result;
  }

  // Validate each changed spec
  for (const specId of changedSpecIds) {
    try {
      getSpec(specId, { cwd });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.ok = false;
      result.errors.push({ specId, error: message });
      continue;
    }

    // Validate full context (all companion files)
    try {
      getSpecContext(specId, { cwd, mode: "full" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.ok = false;
      result.errors.push({ specId, error: `full context: ${message}` });
    }

    // Validate checks context
    try {
      getSpecContext(specId, { cwd, mode: "checks" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.ok = false;
      result.errors.push({ specId, error: `checks context: ${message}` });
    }

    // Check required companions exist
    const specsRoot = resolve(cwd ?? process.cwd(), ".ravi", "specs");
    const specDir = join(specsRoot, ...specId.split("/"));
    for (const companion of REQUIRED_COMPANIONS) {
      const companionPath = join(specDir, companion);
      if (!existsSync(companionPath)) {
        result.ok = false;
        result.errors.push({
          specId,
          error: `missing required companion: ${companion}`,
        });
      }
    }
  }

  return result;
}

/**
 * Identify which runtime/consumer path prefixes are touched by the diff.
 */
export function findTriggeredPrefixes(changedFiles: string[]): string[] {
  const triggered = new Set<string>();

  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, "/");
    // Skip test files from triggering coverage requirements
    if (normalized.endsWith(".test.ts") || normalized.endsWith(".test.tsx")) continue;

    for (const prefix of Object.keys(RUNTIME_PATH_MAP)) {
      if (normalized.startsWith(prefix)) {
        triggered.add(prefix);
      }
    }
  }

  return [...triggered].sort();
}

/**
 * Run the focused coverage gate against a list of changed files.
 *
 * For each triggered runtime/consumer prefix, verify that at least one
 * known test file for that prefix appears in the changed files (test was
 * updated or added alongside source). Existence on disk alone is not
 * sufficient — the diff must include the focused test.
 */
export function runCoverageGate(changedFiles: string[], _cwd?: string): CoverageGateResult {
  const triggeredPrefixes = findTriggeredPrefixes(changedFiles);
  const result: CoverageGateResult = {
    ok: true,
    triggeredPrefixes,
    errors: [],
  };

  if (triggeredPrefixes.length === 0 || isDocsOnlyDiff(changedFiles)) {
    return result;
  }

  for (const prefix of triggeredPrefixes) {
    const testFiles = RUNTIME_PATH_MAP[prefix];
    if (!testFiles || testFiles.length === 0) continue;

    const hasTestInDiff = testFiles.some((testFile) => changedFiles.some((f) => f.replace(/\\/g, "/") === testFile));

    if (!hasTestInDiff) {
      result.ok = false;
      result.errors.push({
        path: prefix,
        prefix,
        message: `Runtime/consumer path '${prefix}' changed but no focused test in the diff. Expected one of: ${testFiles.join(", ")}`,
      });
    }
  }

  return result;
}

/**
 * Run both gates and return a combined result.
 */
export function runQualityGate(
  changedFiles: string[],
  cwd?: string,
): { spec: SpecGateResult; coverage: CoverageGateResult; ok: boolean } {
  const spec = runSpecGate(changedFiles, cwd);
  const coverage = runCoverageGate(changedFiles, cwd);
  return {
    spec,
    coverage,
    ok: spec.ok && coverage.ok,
  };
}
