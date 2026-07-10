/**
 * Shell Hard-Safety Classifier
 *
 * Hard-safety is a policy layer that is evaluated BEFORE and INDEPENDENTLY of
 * Ravi capability authorization. It guarantees that dangerous command patterns
 * and every executable in `UNCONDITIONAL_BLOCKS` are denied regardless of any
 * grant — including a specific `execute executable:<name>`, the wildcard
 * `execute executable:*`, `admin system:*`, the `full-access` profile, or any
 * future authorization bypass.
 *
 * Both the SDK Bash hook (`src/bash/hook.ts`) and the runtime host services
 * (`src/runtime/host-services.ts`) MUST use this single classifier so the two
 * execution paths share the same ordering, reason structure, and stable
 * `blockType` values.
 */

import { checkDangerousPatterns, parseBashCommand, UNCONDITIONAL_BLOCKS } from "./parser.js";
import type { ParsedCommand } from "./types.js";

/** Stable policy categories emitted for hard-safety denials. */
export type ShellHardSafetyBlockType = "runtime_command_dangerous_pattern" | "runtime_executable_unconditional_block";

/**
 * Structured result of classifying a command against shell hard-safety policy.
 *
 * When `safe` is `false`, `blockType` and `reason` are always populated and the
 * command MUST be denied before any capability authorization runs. When `safe`
 * is `true`, `parsed` carries the parsed command (so callers never re-parse) and
 * `parseError` is set when parsing failed — parse-error handling stays with the
 * caller and is NOT a hard-safety denial.
 */
export interface ShellHardSafetyClassification {
  safe: boolean;
  blockType?: ShellHardSafetyBlockType;
  reason?: string;
  /** The unconditional executable that triggered the block, when applicable. */
  executable?: string;
  /** The dangerous pattern source that triggered the block, when applicable. */
  pattern?: string;
  /** Parsed command data, present whenever parsing was attempted. */
  parsed?: ParsedCommand;
  /** Parse error message when parsing failed. Not a hard-safety denial. */
  parseError?: string;
}

/**
 * Classify a command against shell hard-safety policy.
 *
 * Ordering is fixed and identical for every caller:
 * 1. Dangerous patterns (`runtime_command_dangerous_pattern`).
 * 2. Unconditional executables (`runtime_executable_unconditional_block`).
 *
 * Parsing happens once here; callers reuse `parsed` instead of re-parsing.
 */
export function classifyShellHardSafety(command: string): ShellHardSafetyClassification {
  const patternCheck = checkDangerousPatterns(command);
  if (!patternCheck.safe) {
    return {
      safe: false,
      blockType: "runtime_command_dangerous_pattern",
      reason: patternCheck.reason ?? "Command denied by Ravi hard-safety policy.",
      ...(patternCheck.pattern ? { pattern: patternCheck.pattern } : {}),
    };
  }

  const parsed = parseBashCommand(command);
  if (!parsed.success) {
    return {
      safe: true,
      parsed,
      ...(parsed.error ? { parseError: parsed.error } : { parseError: "Failed to parse command." }),
    };
  }

  for (const executable of parsed.executables) {
    if (UNCONDITIONAL_BLOCKS.has(executable)) {
      return {
        safe: false,
        blockType: "runtime_executable_unconditional_block",
        reason: `${executable} is blocked by Ravi command policy.`,
        executable,
        parsed,
      };
    }
  }

  return { safe: true, parsed };
}

/**
 * Stable `denied` identifier for a hard-safety audit event. Derived from the
 * structured classification — never inferred from free-form text.
 */
export function shellHardSafetyAuditDenied(result: ShellHardSafetyClassification): string {
  if (result.blockType === "runtime_command_dangerous_pattern") {
    return "command_policy:dangerous_pattern";
  }
  return `command_policy:unconditional_block:${result.executable ?? "unknown"}`;
}
