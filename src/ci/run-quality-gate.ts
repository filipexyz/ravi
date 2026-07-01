#!/usr/bin/env bun
/**
 * CI quality gate runner.
 *
 * Usage in GitHub Actions:
 *   bun src/ci/run-quality-gate.ts
 *
 * Reads changed files from:
 *   1. CHANGED_FILES env var (newline-separated), or
 *   2. git diff against the PR base branch.
 *
 * Exits 0 on pass, 1 on failure with structured output.
 */

import { execSync } from "node:child_process";
import { runQualityGate } from "./quality-gate.js";

function getChangedFiles(): string[] {
  const envFiles = process.env.CHANGED_FILES;
  if (envFiles) {
    return envFiles
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  }

  // Fall back to git diff against merge-base
  const base = process.env.GITHUB_BASE_REF || "main";
  try {
    const output = execSync(`git diff --name-only --diff-filter=ACMR origin/${base}...HEAD`, { encoding: "utf8" });
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    console.error("Could not determine changed files from git diff.");
    process.exit(1);
  }
}

const changedFiles = getChangedFiles();

if (changedFiles.length === 0) {
  console.log("No changed files detected. Quality gate passed.");
  process.exit(0);
}

console.log(`Changed files (${changedFiles.length}):`);
for (const f of changedFiles) {
  console.log(`  ${f}`);
}
console.log();

const result = runQualityGate(changedFiles);

// Report spec gate
console.log("=== Spec Gate ===");
if (result.spec.changedSpecIds.length === 0) {
  console.log("No spec changes detected. Skipped.");
} else {
  console.log(`Changed spec ids: ${result.spec.changedSpecIds.join(", ")}`);
  if (result.spec.syncResult) {
    console.log(`Spec sync: ${result.spec.syncResult.total} specs indexed.`);
  }
  if (result.spec.ok) {
    console.log("Spec gate: PASSED");
  } else {
    console.log("Spec gate: FAILED");
    for (const err of result.spec.errors) {
      console.error(`  [${err.specId}] ${err.error}`);
    }
  }
}
console.log();

// Report coverage gate
console.log("=== Coverage Gate ===");
if (result.coverage.triggeredPrefixes.length === 0) {
  console.log("No runtime/consumer paths changed. Skipped.");
} else {
  console.log(`Triggered prefixes: ${result.coverage.triggeredPrefixes.join(", ")}`);
  if (result.coverage.ok) {
    console.log("Coverage gate: PASSED");
  } else {
    console.log("Coverage gate: FAILED");
    for (const err of result.coverage.errors) {
      console.error(`  ${err.message}`);
    }
  }
}
console.log();

if (result.ok) {
  console.log("Quality gate: PASSED");
  process.exit(0);
} else {
  console.log("Quality gate: FAILED");
  process.exit(1);
}
