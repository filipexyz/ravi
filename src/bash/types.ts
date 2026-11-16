/**
 * Bash CLI Permissioning Types
 */

/** Where a command the shell would run came from. */
export type CommandOrigin = "segment" | "substitution" | "process_substitution" | "heredoc" | "launcher";

/** One command the shell would run, as the analyzer sees it. Analysis only, never authority. */
export interface AnalyzedCommand {
  /** Name the executable grant is checked against (last path segment of `word`). */
  name: string;
  /** Decoded command word, path included (`/tmp/p/git`). */
  word: string;
  /** Decoded arguments; `null` marks a dynamic word. */
  argv: Array<string | null>;
  origin: CommandOrigin;
  /** The launcher that runs this command, when `origin === "launcher"`. */
  launcher?: string;
  /** Set when this command is a launcher that hands its command to a shell string. */
  launchesShellString?: string;
  /** The simple command (segment) text it came from. */
  text: string;
  /**
   * Input the command line builds for this command: `stdin` (here-document,
   * here-string, or stdin a compound command/function passes down) and `file`
   * (`<(...)`). An interpreter reading it runs code the agent wrote inline.
   */
  codeInputs?: Array<"stdin" | "file">;
  /**
   * The launcher adds arguments it reads at run time (xargs input) to `argv`.
   * A check that depends on the arguments cannot see them.
   */
  openArgs?: boolean;
}

/** Result of parsing a bash command */
export interface ParsedCommand {
  /** All executables found in the command */
  executables: string[];

  /** Whether parsing was successful */
  success: boolean;

  /** Error message if parsing failed */
  error?: string;

  /** Why parsing failed: the analyzer could not model it, or inline interpreter code. */
  code?: "unknown_parse" | "inline_code";

  /** The analyzer's typed refusal when `code === "unknown_parse"`, cause chain included. */
  cause?: Error;

  /** Every analyzed command, with path and origin (present on success). */
  commands?: AnalyzedCommand[];

  /** Variables the command assigns or exports (present on success). */
  assignments?: string[];

  /** Every assignment, in order; `value` is the literal string for `NAME=value` before a command, else null. */
  assignmentValues?: AssignmentValue[];
}

export interface AssignmentValue {
  name: string;
  /** The fixed string assigned, or null when it is dynamic, appended or set by a builtin/launcher. */
  value: string | null;
}

/** Result of checking dangerous patterns */
export interface PatternCheckResult {
  /** Whether the command is safe (no dangerous patterns found) */
  safe: boolean;

  /** Reason if unsafe */
  reason?: string;

  /** Matched pattern if unsafe */
  pattern?: string;

  /** `unknown_parse` when the analyzer could not model the command. */
  code?: "unknown_parse";
}
