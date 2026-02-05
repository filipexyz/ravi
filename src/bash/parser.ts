/**
 * Bash Command Parser
 *
 * Extracts all executables from bash commands for permission checking.
 * Includes injection safety checks to prevent bypassing restrictions.
 */

import type { ParsedCommand, PatternCheckResult } from "./types.js";

// ============================================================================
// Dangerous Patterns (checked before parsing)
// ============================================================================

/**
 * Patterns that indicate injection attempts or bypass vectors.
 * These are checked against the raw command BEFORE parsing.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\(/, reason: "command substitution $(...)  is not allowed" },
  { pattern: /`[^`]*`/, reason: "backtick command substitution is not allowed" },
  { pattern: /<\(/, reason: "process substitution <(...) is not allowed" },
  { pattern: />\(/, reason: "process substitution >(...) is not allowed" },
  { pattern: /<<[<-]?/, reason: "here documents are not allowed" },
  {
    pattern: /\|\s*(bash|sh|zsh|dash|ksh|csh|fish)\b/,
    reason: "piping to shell is not allowed",
  },
  {
    pattern: /\|\s*(python|python3|node|perl|ruby)\s+(-c|-e)\b/,
    reason: "piping to interpreter with inline code is not allowed",
  },
  {
    pattern: /\|\s*(python|python3|node|perl|ruby)\s*$/,
    reason: "piping to interpreter stdin is not allowed",
  },
];

/**
 * Executables that are ALWAYS blocked, regardless of config.
 * These can execute arbitrary strings, bypassing all restrictions.
 */
export const UNCONDITIONAL_BLOCKS = new Set([
  // Shell bypass
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "fish",
  "tcsh",
  // String execution
  "eval",
  "exec",
  // source/dot command
  "source",
  ".",
]);

/**
 * Interpreters that are blocked when used with inline code flags.
 */
const INLINE_CODE_INTERPRETERS: Record<string, string[]> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval"],
  perl: ["-e"],
  ruby: ["-e"],
  php: ["-r"],
};

// ============================================================================
// Pattern Checking
// ============================================================================

/**
 * Check command for dangerous patterns before parsing.
 * This is a fail-fast check to catch injection attempts.
 */
export function checkDangerousPatterns(command: string): PatternCheckResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        safe: false,
        reason,
        pattern: pattern.source,
      };
    }
  }
  return { safe: true };
}

// ============================================================================
// Command Parsing
// ============================================================================

/**
 * Normalize command by replacing newlines with semicolons.
 * This ensures multi-line commands are properly parsed.
 */
function normalizeCommand(command: string): string {
  return command.replace(/\n/g, " ; ");
}

/**
 * Remove quoted strings from command to avoid false positives.
 * Replaces both single and double quoted strings with placeholders.
 */
function removeQuotedStrings(command: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble) {
      result += char;
    }
  }

  return result;
}

/**
 * Extract the executable name from a path.
 * /usr/bin/git -> git
 */
function extractExecutableName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1];
}

/**
 * Check if a token is an environment variable assignment.
 * VAR=value or VAR="value"
 */
function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * Parse a single simple command (no pipes/chains) and extract the executable.
 */
function parseSimpleCommand(command: string): string | null {
  const cleaned = removeQuotedStrings(command.trim());
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    // Skip env var assignments
    if (isEnvAssignment(token)) {
      continue;
    }

    // Skip common shell redirections
    if (/^[0-9]*[<>]/.test(token) || token === "<" || token === ">") {
      continue;
    }

    // Extract executable name from path
    return extractExecutableName(token);
  }

  return null;
}

/**
 * Split command by operators (pipes, and, or, semicolons).
 * Returns array of simple commands.
 */
function splitByOperators(command: string): string[] {
  // Remove quoted strings to avoid splitting inside quotes
  const cleaned = removeQuotedStrings(command);

  // Split by operators: |, &&, ||, ;
  // But not || or && inside brackets
  const commands: string[] = [];
  let current = "";
  let i = 0;

  while (i < cleaned.length) {
    const char = cleaned[i];
    const next = cleaned[i + 1];

    // Handle operators
    if (char === "|" && next !== "|") {
      // Pipe
      if (current.trim()) commands.push(current.trim());
      current = "";
      i++;
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      // && or ||
      if (current.trim()) commands.push(current.trim());
      current = "";
      i += 2;
      continue;
    }

    if (char === ";") {
      // Semicolon
      if (current.trim()) commands.push(current.trim());
      current = "";
      i++;
      continue;
    }

    current += char;
    i++;
  }

  if (current.trim()) commands.push(current.trim());
  return commands;
}

/**
 * Check if an executable with its arguments represents inline code execution.
 */
function isInlineCodeExecution(
  executable: string,
  command: string
): { blocked: boolean; reason?: string } {
  const flags = INLINE_CODE_INTERPRETERS[executable];
  if (!flags) return { blocked: false };

  // Check if any inline code flag is present in the command
  const tokens = command.split(/\s+/);
  const execIndex = tokens.findIndex(
    (t) => extractExecutableName(t) === executable
  );

  if (execIndex === -1) return { blocked: false };

  // Look at tokens after the executable
  for (let i = execIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (flags.some((flag) => token === flag || token.startsWith(flag + "="))) {
      return {
        blocked: true,
        reason: `${executable} with inline code flag is not allowed`,
      };
    }
    // Stop at pipes/chains
    if (token === "|" || token === "&&" || token === "||" || token === ";") {
      break;
    }
  }

  return { blocked: false };
}

/**
 * Parse a bash command and extract all executables.
 *
 * Handles:
 * - Pipes: cat file | grep foo -> ["cat", "grep"]
 * - Chains: git status && npm install -> ["git", "npm"]
 * - Env vars: NODE_ENV=prod node app.js -> ["node"]
 * - Sudo prefix: sudo rm -rf / -> ["sudo", "rm"]
 * - Full paths: /usr/bin/git status -> ["git"]
 * - Semicolons: ls; pwd -> ["ls", "pwd"]
 */
export function parseBashCommand(command: string): ParsedCommand {
  try {
    // Normalize newlines
    const normalized = normalizeCommand(command);

    // Split by operators
    const simpleCommands = splitByOperators(normalized);

    // Extract executables from each command
    const executables: string[] = [];
    const seenInline: string[] = [];

    for (const cmd of simpleCommands) {
      const exec = parseSimpleCommand(cmd);
      if (exec) {
        executables.push(exec);

        // Check for sudo - also extract the actual command
        if (exec === "sudo") {
          const afterSudo = cmd.replace(/^\s*sudo\s+/, "");
          const actualExec = parseSimpleCommand(afterSudo);
          if (actualExec) {
            executables.push(actualExec);
          }
        }

        // Check for inline code execution
        const inlineCheck = isInlineCodeExecution(exec, cmd);
        if (inlineCheck.blocked) {
          seenInline.push(inlineCheck.reason || `${exec} inline code`);
        }
      }
    }

    // If inline code was detected, fail parsing
    if (seenInline.length > 0) {
      return {
        executables: [],
        success: false,
        error: seenInline[0],
      };
    }

    return {
      executables: [...new Set(executables)], // Deduplicate
      success: true,
    };
  } catch (err) {
    return {
      executables: [],
      success: false,
      error: err instanceof Error ? err.message : "Parse error",
    };
  }
}
