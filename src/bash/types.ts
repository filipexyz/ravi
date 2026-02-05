/**
 * Bash CLI Permissioning Types
 */

/** Permission mode for bash commands */
export type BashMode = "bypass" | "allowlist" | "denylist";

/** Bash permission configuration for an agent */
export interface BashConfig {
  /** Permission mode */
  mode: BashMode;

  /** CLIs allowed when mode is "allowlist" */
  allowlist?: string[];

  /** CLIs blocked when mode is "denylist" */
  denylist?: string[];
}

/** Result of parsing a bash command */
export interface ParsedCommand {
  /** All executables found in the command */
  executables: string[];

  /** Whether parsing was successful */
  success: boolean;

  /** Error message if parsing failed */
  error?: string;
}

/** Result of checking dangerous patterns */
export interface PatternCheckResult {
  /** Whether the command is safe (no dangerous patterns found) */
  safe: boolean;

  /** Reason if unsafe */
  reason?: string;

  /** Matched pattern if unsafe */
  pattern?: string;
}

/** Result of permission check */
export interface PermissionCheckResult {
  /** Whether the command is allowed */
  allowed: boolean;

  /** Executables that were blocked */
  blockedExecutables?: string[];

  /** Reason for denial */
  reason?: string;
}
