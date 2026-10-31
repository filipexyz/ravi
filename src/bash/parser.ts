/**
 * Bash Command Parser
 *
 * Extracts visible executables from the supported shell subset for permission
 * checking. Syntax checks prevent common accidents, not arbitrary host effects.
 */

import type { ParsedCommand, PatternCheckResult } from "./types.js";
import { parse as parseShell, type ParseEntry } from "shell-quote";
import { resolve } from "node:path";
import { physicalPathForPermissionCheck } from "../permissions/provider-config-paths.js";

// ============================================================================
// Dangerous Patterns (checked before parsing)
// ============================================================================

/** Active shell syntax only; quoted data must not match these patterns. */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\(/, reason: "command substitution $(...) is not allowed" },
  { pattern: /`/, reason: "backtick command substitution is not allowed" },
  { pattern: /<\(/, reason: "process substitution <(...) is not allowed" },
  { pattern: />\(/, reason: "process substitution >(...) is not allowed" },
  { pattern: /<<[<-]?/, reason: "here documents are not allowed" },
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
  const inspected = inspectShellSyntax(command);
  if (inspected.error) return { safe: false, reason: inspected.error };
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(inspected.syntax)) {
      return { safe: false, reason, pattern: pattern.source };
    }
  }
  try {
    // Inspect real pipe operators, then decode the receiving command's words.
    // A quoted/escaped pipe is data; a quoted executable is still executable.
    for (let i = 0; i < inspected.syntax.length; i++) {
      if (inspected.syntax[i] !== "|" || /[|>]/.test(inspected.syntax[i - 1] ?? "") || inspected.syntax[i + 1] === "|")
        continue;
      const receiver = splitByOperators(inspected.command.slice(i + 1))[0] ?? "";
      const executable = parseSimpleCommand(receiver);
      if (!executable) continue;
      if (UNCONDITIONAL_BLOCKS.has(executable)) return { safe: false, reason: "piping to shell is not allowed" };
      if (INLINE_CODE_INTERPRETERS[executable]) {
        if (isInlineCodeExecution(executable, receiver).blocked) {
          return { safe: false, reason: "piping to interpreter with inline code is not allowed" };
        }
        if (countCommandWords(receiver) === 1) {
          return { safe: false, reason: "piping to interpreter stdin is not allowed" };
        }
      }
    }
  } catch {
    return { safe: false, reason: "Cannot parse shell pipeline safely" };
  }
  return { safe: true };
}

// ============================================================================
// Command Parsing
// ============================================================================

/**
 * Bounded lexical view, not a shell evaluator. Keep source and syntax offsets
 * aligned: mask literal characters, never delete quote boundaries and join
 * unrelated tokens. Single quotes suppress all expansion; double quotes still
 * evaluate dollar-paren and backticks. Only backslash-newline is removed where
 * the shell actually treats it as a continuation.
 */
function inspectShellSyntax(input: string): { command: string; syntax: string; error?: string } {
  let command = "";
  let syntax = "";
  let quote: "'" | '"' | undefined;
  let wordStart = true;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    let nextIndex = i + 1;
    // Dollar-paren / expanded quoting may straddle one or more continuations.
    if (char === "$" && quote !== "'") {
      while (input[nextIndex] === "\\" && input[nextIndex + 1] === "\n") nextIndex += 2;
    }
    const next = input[nextIndex];
    if (quote !== "'" && char === "\\") {
      if (next === "\n") {
        i++;
        continue;
      }
      if (next === undefined) return { command, syntax, error: "Unterminated shell escape" };
      // Inside double quotes, backslash only escapes $, `, ", backslash or newline.
      if (!quote || /[$`"\\]/.test(next)) {
        command += char + next;
        syntax += "  ";
        wordStart = false;
        i++;
        continue;
      }
    }
    if (!quote && char === "$" && (next === "'" || next === '"')) {
      return { command, syntax, error: "Expanded shell quoting is not supported" };
    }
    if (!quote && char === "#" && wordStart) {
      while (i < input.length && input[i] !== "\n") {
        command += input[i];
        syntax += " ";
        i++;
      }
      i--;
      continue;
    }
    command += char;
    if (char === quote) {
      quote = undefined;
      syntax += " ";
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
      syntax += " ";
    } else if (quote === '"' && char === "$" && next === "(") {
      command += next;
      syntax += "$(";
      i = nextIndex;
    } else {
      syntax += !quote || (quote === '"' && char === "`") ? char : " ";
    }
    wordStart = !quote && /[\s;&|()<>]/.test(char);
  }
  return { command, syntax, ...(quote ? { error: "Unterminated shell quote" } : {}) };
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

/** Keep shell-quote's word view consistent with Bash's word-start comments. */
function parseWords(command: string, env?: Parameters<typeof parseShell>[1]): ParseEntry[] {
  const inspected = inspectShellSyntax(command);
  if (inspected.error) throw new Error(inspected.error);
  let view = "";
  for (let i = 0; i < inspected.command.length; i++) {
    // Only active, mid-word hashes survive in syntax. Quoted/escaped hashes
    // and actual comments must retain their original spelling.
    view += (inspected.syntax[i] === "#" ? "\\" : "") + inspected.command[i];
  }
  return parseShell(view, env);
}

/** Assignments, comments and redirect operands are not interpreter arguments. */
function countCommandWords(command: string): number {
  const tokens = parseWords(command);
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    if (typeof token === "string") {
      if (count === 0 && isEnvAssignment(token)) continue;
      if (/^\d+$/.test(token) && typeof next === "object" && "op" in next && /[<>]/.test(next.op)) continue;
      count++;
    } else if ("comment" in token) {
      break;
    } else if (token.op === "glob") {
      count++;
    } else if (token.op === "&" && typeof next === "object" && "op" in next && [">", ">>"].includes(next.op)) {
      // The following redirect token consumes the combined redirect destination.
    } else if ([">", ">>", "<", ">&", "<&", "<>"].includes(token.op)) {
      if (token.op === ">" && typeof next === "object" && "op" in next && next.op === "|") i++;
      if (tokens[++i] === undefined) throw new Error("Missing shell redirect destination");
    } else {
      throw new Error("Cannot resolve shell pipeline arguments");
    }
  }
  return count;
}

/**
 * Parse a single simple command (no pipes/chains) and extract the executable.
 */
function parseSimpleCommand(command: string): string | null {
  const tokens = parseWords(command.trim(), () => ({ op: "glob", pattern: "unknown expansion" }));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (typeof token !== "string") {
      if ("comment" in token) break;
      if (token.op === "glob") throw new Error("Cannot resolve a dynamic shell executable");
      if ([">", ">>", "<", ">&", "<&", "<>"].includes(token.op)) {
        const next = tokens[i + 1];
        if (token.op === ">" && typeof next === "object" && "op" in next && next.op === "|") i++;
        i++; // redirect destination
      }
      continue;
    }
    if (isEnvAssignment(token)) continue;
    const next = tokens[i + 1];
    if (/^\d+$/.test(token) && typeof next === "object" && "op" in next && /[<>]/.test(next.op)) continue;
    return extractExecutableName(token);
  }

  return null;
}

/**
 * Split command by operators (pipes, and, or, semicolons).
 * Returns array of simple commands.
 */
function splitByOperators(command: string): string[] {
  const inspected = inspectShellSyntax(command);
  if (inspected.error) throw new Error(inspected.error);
  const commands: string[] = [];
  let start = 0;
  for (const match of inspected.syntax.matchAll(/\|\||&&|[|;&\n]/g)) {
    const index = match.index!;
    // Descriptor duplication, combined redirects and clobber are not chains.
    if (match[0] === "&" && (/[<>]/.test(inspected.syntax[index - 1] ?? "") || inspected.syntax[index + 1] === ">"))
      continue;
    if (match[0] === "|" && inspected.syntax[index - 1] === ">") continue;
    const part = inspected.command.slice(start, match.index).trim();
    if (part) commands.push(part);
    start = match.index! + match[0].length;
  }
  const last = inspected.command.slice(start).trim();
  if (last) commands.push(last);
  return commands;
}

/**
 * Check if an executable with its arguments represents inline code execution.
 */
function isInlineCodeExecution(executable: string, command: string): { blocked: boolean; reason?: string } {
  const flags = INLINE_CODE_INTERPRETERS[executable];
  if (!flags) return { blocked: false };

  // Check if any inline code flag is present in the command
  const tokens = parseWords(command);
  const execIndex = tokens.findIndex((t) => typeof t === "string" && extractExecutableName(t) === executable);

  if (execIndex === -1) return { blocked: false };

  // Look at tokens after the executable
  for (let i = execIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (typeof token !== "string") {
      if (!token || "comment" in token) break;
      if ([">", ">>", "<", ">&", "<&", "<>"].includes(token.op)) {
        const next = tokens[i + 1];
        if (token.op === ">" && typeof next === "object" && "op" in next && next.op === "|") i++;
        i++;
      }
      continue;
    }
    if (
      flags.some(
        (flag) => token === flag || token.startsWith(flag + "=") || (flag.length === 2 && token.startsWith(flag)),
      )
    ) {
      return {
        blocked: true,
        reason: `${executable} with inline code flag is not allowed`,
      };
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
    // Split only on active operators; retain quoted words for token decoding.
    const simpleCommands = splitByOperators(command);

    // Extract executables from each command
    const executables: string[] = [];
    const seenInline: string[] = [];

    for (const cmd of simpleCommands) {
      const exec = parseSimpleCommand(cmd);
      if (exec) {
        executables.push(exec);

        // Check for sudo - also extract the actual command
        if (exec === "sudo") {
          const words = parseWords(cmd).filter((token): token is string => typeof token === "string");
          const index = words.findIndex((word) => extractExecutableName(word) === "sudo");
          const actualExec = words[index + 1] ? extractExecutableName(words[index + 1]!) : null;
          if (actualExec) {
            executables.push(actualExec);
            const inline = isInlineCodeExecution(actualExec, cmd);
            if (inline.blocked) seenInline.push(inline.reason!);
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
    tokens = parseWords(command, () => ({ op: "glob", pattern: "unknown expansion" }));
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
