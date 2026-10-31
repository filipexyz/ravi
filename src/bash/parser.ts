/**
 * Bash Command Parser
 *
 * Extracts all executables from bash commands for permission checking.
 * Includes injection safety checks to prevent bypassing restrictions.
 */

import type { ParsedCommand, PatternCheckResult } from "./types.js";
import { parse as parseShell, type ParseEntry } from "shell-quote";
import { resolve } from "node:path";
import { physicalPathForPermissionCheck } from "../permissions/provider-config-paths.js";

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
function isInlineCodeExecution(executable: string, command: string): { blocked: boolean; reason?: string } {
  const flags = INLINE_CODE_INTERPRETERS[executable];
  if (!flags) return { blocked: false };

  // Check if any inline code flag is present in the command
  const tokens = command.split(/\s+/);
  const execIndex = tokens.findIndex((t) => extractExecutableName(t) === executable);

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

/**
 * Targets of output redirections (`>`, `>>`, `>|`, `&>`, `N>`) outside quotes.
 * Duplications to another descriptor (`2>&1`, `>&2`) are not file writes and
 * are skipped. This lists only recovered targets; permission checks MUST use
 * analyzeOutputRedirects and refuse its errors, not infer safety from this list.
 */
export function findOutputRedirectTargets(command: string): string[] {
  return analyzeOutputRedirects(command).writes.map((write) => write.target);
}

export interface ShellOutputRedirect {
  target: string;
  /** All possible directories at this command, including a preceding cd failing. */
  cwds: string[];
}

const MAX_REDIRECT_CWDS = 32;
const AMBIGUOUS_REDIRECT_COMMANDS = new Set([
  "pushd",
  "popd",
  "chdir",
  "command",
  "builtin",
  "env",
  "sudo",
  "doas",
  "exec",
  "source",
  ".",
  "export",
  "unset",
  "set",
  "shopt",
  "alias",
  "unalias",
  "enable",
  "hash",
  "declare",
  "typeset",
  "local",
  "readonly",
  "read",
  "mapfile",
  "readarray",
  "getopts",
  "let",
  "trap",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "time",
  "!",
  "{",
  "}",
]);

/**
 * A deliberately bounded shell subset for file writes. shell-quote owns token
 * and quote parsing. We model only simple commands separated by &&, || or ;,
 * and literal cd destinations. Retaining both sides of every cd over-approximates
 * control flow instead of assuming it succeeds. More complex shell execution
 * cannot be authorized as a harmless redirect from this static inspection.
 */
export function analyzeOutputRedirects(
  command: string,
  cwd = process.cwd(),
): { writes: ShellOutputRedirect[]; error?: string } {
  const writes: ShellOutputRedirect[] = [];
  // The tokenizer does not model newline command boundaries or ANSI-C quotes.
  // Refuse them, including before comments, rather than normalizing shell meaning.
  if (!command.includes(">")) return { writes };
  if (/[\r\n]/.test(command) || /\$['"]/.test(command)) {
    return { writes, error: "Cannot resolve output redirects with multiline or expanded shell quoting" };
  }
  let tokens: ParseEntry[];
  try {
    tokens = parseShell(command, () => ({ op: "glob", pattern: "unknown expansion" }));
  } catch {
    return { writes, error: "Cannot parse output redirect safely" };
  }
  const hasRedirect = tokens.some(
    (token) => typeof token === "object" && "op" in token && [">", ">>", ">&"].includes(token.op),
  );
  if (!hasRedirect) return { writes };
  const physicalCwd = physicalPathForPermissionCheck(cwd);
  if (physicalCwd === null) return { writes, error: "Cannot resolve the shell working directory" };
  const cwds = new Set([resolve(cwd), physicalCwd]);
  let args: string[] = [];
  const finishCommand = (): string | undefined => {
    const [executable, ...rest] = args;
    args = [];
    if (!executable) return;
    if (
      isEnvAssignment(executable) ||
      AMBIGUOUS_REDIRECT_COMMANDS.has(executable) ||
      (executable === "printf" && rest.some((arg) => arg.startsWith("-v")))
    ) {
      return "Cannot resolve output redirects across shell state changes or compound commands";
    }
    if (executable !== "cd") return;
    const destinations = rest.filter((arg) => arg !== "--" && arg !== "-L" && arg !== "-P");
    const destination = destinations[0];
    if (
      destinations.length !== 1 ||
      !destination ||
      destination.startsWith("-") ||
      /[\u0000\r\n$*?[\]{}~]/.test(destination) ||
      process.env.CDPATH
    ) {
      return "Cannot resolve a dynamic shell working directory for output redirects";
    }
    for (const prior of [...cwds]) {
      const physical = physicalPathForPermissionCheck(destination, prior);
      if (physical === null) return "Cannot resolve a shell working directory symlink";
      cwds.add(resolve(prior, destination));
      cwds.add(physical);
      if (cwds.size > MAX_REDIRECT_CWDS) return "Too many possible working directories for output redirects";
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (typeof token === "string") {
      args.push(token);
      continue;
    }
    if ("comment" in token) break;
    if (token.op === ";" || token.op === "&&" || token.op === "||") {
      const error = finishCommand();
      if (error) return { writes, error };
      continue;
    }
    // &> / &>> and >| are two tokens in shell-quote.
    const next = tokens[i + 1];
    if (token.op === "&" && typeof next === "object" && "op" in next && [">", ">>"].includes(next.op)) {
      continue;
    }
    if (token.op === ">" || token.op === ">>" || token.op === ">&") {
      // A numeric word before the operator may be the descriptor, even when
      // redirections precede `cd`. Removing a separated numeric argument too
      // is conservative: it makes a numeric cd destination indeterminate.
      if (/^\d+$/.test(args[args.length - 1] ?? "")) args.pop();
      if (token.op === ">" && typeof next === "object" && "op" in next && next.op === "|") i++;
      const target = tokens[++i];
      if (typeof target !== "string" || !target) {
        return { writes, error: "Cannot resolve a dynamic output redirect target" };
      }
      // Descriptor duplication/closure does not open a path.
      if (token.op === ">&" && /^(?:\d+|-)$/.test(target)) continue;
      writes.push({ target, cwds: [...cwds] });
      if (/[\u0000\r\n$*?[\]{}~]/.test(target)) {
        return { writes, error: "Cannot resolve a dynamic output redirect target" };
      }
      continue;
    }
    return { writes, error: "Cannot resolve output redirects in a subshell, pipeline, or expanded command" };
  }
  const error = finishCommand();
  return { writes, ...(error ? { error } : {}) };
}

/** Remove shell quoting (`r'a'vi` → `ravi`) so text checks see what the shell will run. */
export function stripShellQuoting(command: string): string {
  return command.replace(/\\(.)/g, "$1").replace(/["']/g, "");
}
