/**
 * Bash CLI Permissioning Types
 */

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
