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
 * Quoted and escaped text is replaced by a placeholder `OPEN <index> CLOSE`
 * that points into a table of literal strings. This keeps quoted operators,
 * whitespace and newlines from splitting the command, while the full
 * dequoted word can still be rebuilt for the command position
 * (`"/tmp/x"ls` -> `/tmp/xls`, `\rm` -> `rm`).
 *
 * Bash only recognizes reserved words (`do`, `done`, `if`, ...) when they are
 * unquoted, so `"x"done` or `\do` are ordinary command words: a token holding
 * a placeholder is never a keyword. Commands that already contain these
 * control characters are rejected so placeholders cannot be forged.
 */
const QUOTE_OPEN = "\u0000";
const QUOTE_CLOSE = "\u0001";
const PLACEHOLDER_PATTERN = /\u0000(\d+)\u0001/g;

interface DequotedCommand {
  /** The command with quoted/escaped text replaced by placeholders and newlines by ` ; `. */
  text: string;
  /** Rebuild the literal (dequoted) word for a token of `text`. */
  decode: (token: string) => string;
  /** True when the token holds `$'...'` text with a backslash escape, which is kept raw (not decoded). */
  hasRawEscape: (token: string) => boolean;
}

/**
 * Whitespace that JavaScript's `\s` matches but bash does not treat as a blank
 * (vertical tab, form feed, carriage return, no-break and other Unicode spaces).
 * Unquoted, it would make the tokenizer and comment detection disagree with bash.
 */
const NON_BASH_BLANK = /[^\S \t\n]/;

/**
 * Remove shell quoting the way bash does, for the purpose of finding commands:
 * - `'...'` is literal (a backslash inside does not escape anything)
 * - `$'...'` is literal, but `\'` does not end it
 * - `"..."` is literal except `\$`, `` \` ``, `\"`, `\\` and `\<newline>`
 * - `\c` outside quotes is the literal `c`; `\<newline>` is a line continuation
 * - an unquoted newline separates commands (normalized to ` ; `)
 * - an unquoted `#` at the start of a word starts a comment up to the newline
 *
 * Constructs whose quoting bash reads differently (quotes or backslashes
 * inside `${...}` / `$[...]`, `#` right after a redirection, an unterminated
 * quote) are rejected so the permission check fails closed.
 */
function dequoteCommand(command: string): DequotedCommand {
  if (command.includes(QUOTE_OPEN) || command.includes(QUOTE_CLOSE)) {
    throw new Error("command contains control characters that are not allowed");
  }

  const literals: string[] = [];
  let text = "";
  let literal = "";
  let quote: "single" | "ansi" | "double" | null = null;
  let literalHasEscape = false;
  const rawEscapeLiterals = new Set<number>();
  // Whether the next character starts a new shell word (an unquoted `#` there starts a comment).
  let atWordStart = true;

  const pushLiteral = (value: string, rawEscape = false) => {
    literals.push(value);
    if (rawEscape) rawEscapeLiterals.add(literals.length - 1);
    text += `${QUOTE_OPEN}${literals.length - 1}${QUOTE_CLOSE}`;
    atWordStart = false;
  };

  // `${...}` or `$[...]` starting at `start` (the `$`): return its raw text.
  // Quotes and backslashes inside are refused: bash parses them differently.
  const readExpansion = (start: number): string => {
    const open = command[start + 1];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let j = start + 1; j < command.length; j++) {
      const c = command[j];
      if (c === "'" || c === '"' || c === "\\" || c === "`") {
        throw new Error("quotes or backslashes inside a parameter expansion are not allowed");
      }
      if (c === open) depth++;
      if (c === close) {
        depth--;
        if (depth === 0) return command.slice(start, j + 1);
      }
    }
    throw new Error("unterminated parameter expansion");
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];

    if (quote === "single" || quote === "ansi") {
      if (char === "'") {
        pushLiteral(literal, quote === "ansi" && literalHasEscape);
        quote = null;
      } else if (quote === "ansi" && char === "\\" && next !== undefined) {
        // Keep the escape raw: `$'\x72m'` stays `\x72m`, never `rm`. A command
        // word holding such text is refused (see hasRawEscape).
        literal += char + next;
        literalHasEscape = true;
        i++;
      } else {
        literal += char;
      }
      continue;
    }

    if (char === "$" && (next === "{" || next === "[")) {
      const expansion = readExpansion(i);
      if (quote === "double") literal += expansion;
      else {
        if (NON_BASH_BLANK.test(expansion)) {
          throw new Error("unquoted whitespace other than space, tab or newline is not allowed");
        }
        text += expansion;
        atWordStart = false;
      }
      i += expansion.length - 1;
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = null;
        pushLiteral(literal);
      } else if (char === "\\" && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== "\n") literal += next;
        i++;
      } else {
        literal += char;
      }
      continue;
    }

    if (char === "\\") {
      if (next === undefined) {
        pushLiteral("\\");
      } else if (next !== "\n") {
        pushLiteral(next);
      }
      i++;
      continue;
    }

    // An unquoted, unescaped `$` right before a quote makes it `$'...'` (ANSI-C)
    // or `$"..."` (locale). Bash drops that `$`, so `$'bash'` runs `bash`.
    const dollarQuote = (char === "'" || char === '"') && command[i - 1] === "$" && text.endsWith("$");
    if (dollarQuote) text = text.slice(0, -1);

    if (char === "'") {
      quote = dollarQuote ? "ansi" : "single";
      literal = "";
      literalHasEscape = false;
      continue;
    }

    if (char === '"') {
      quote = "double";
      literal = "";
      continue;
    }

    if (char === "#") {
      const prev = command[i - 1];
      if (prev === "<" || prev === ">") {
        throw new Error("'#' right after a redirection is not allowed");
      }
      if (atWordStart) {
        // Comment: skip to the end of the line; the newline still separates commands.
        const newline = command.indexOf("\n", i);
        if (newline === -1) break;
        i = newline - 1;
        continue;
      }
    }

    if (NON_BASH_BLANK.test(char)) {
      // JavaScript reads this as whitespace (word split, comment start), bash does not.
      throw new Error("unquoted whitespace other than space, tab or newline is not allowed");
    }

    text += char === "\n" ? " ; " : char;
    atWordStart = /[\s;&|()]/.test(char);
  }

  if (quote !== null) {
    throw new Error("unterminated quote");
  }

  return {
    text,
    decode: (token) => token.replace(PLACEHOLDER_PATTERN, (_, index: string) => literals[Number(index)] ?? ""),
    hasRawEscape: (token) => {
      for (const match of token.matchAll(PLACEHOLDER_PATTERN)) {
        if (rawEscapeLiterals.has(Number(match[1]))) return true;
      }
      return false;
    },
  };
}

/**
 * Extract the executable name from a path.
 * /usr/bin/git -> git
 */
function extractExecutableName(path: string): string {
  const parts = path.split("/");
  // A trailing slash would leave an empty name; keep the full word (fail closed).
  return parts[parts.length - 1] || path;
}

/**
 * Check if a token is an environment variable assignment.
 * VAR=value or VAR="value"
 */
function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * Check if a token is a shell redirection (`>out`, `2>&1`, `<in`, `&>log`).
 */
function isRedirection(token: string): boolean {
  return /^(?:[0-9]*[<>]|&>)/.test(token);
}

/**
 * A redirection operator written without its target (`>`, `2>>`, `&>`): the
 * next token is the target file, not a command.
 */
function isBareRedirection(token: string): boolean {
  return /^(?:[0-9]*(?:<|>|>>|<>|<&|>&|>\|)|&>|&>>)$/.test(token);
}

// ============================================================================
// Shell Reserved Words
// ============================================================================

/**
 * Reserved words that may start a command and are followed by another command
 * in the same segment: `do rm x`, `then curl y`, `! grep z`, `{ ls`, `time make`.
 * They are skipped so the real command after them is still checked.
 */
const PREFIX_KEYWORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time"]);

/**
 * Reserved words that close a compound command. Only redirections may follow
 * them, so a segment like `done` or `} > out` has no executable.
 */
const CLOSING_KEYWORDS = new Set(["done", "fi", "esac", "}"]);

/**
 * A `case` pattern such as `start)`, `*)` or `"a b")`. It is only treated as a
 * pattern where bash expects one: right after `case WORD in` or at the start of
 * an arm after `;;` / `;&` / `;;&`.
 */
const CASE_PATTERN = /^[^()]*\)$/;

/**
 * The `(stop)` pattern form is only accepted right after `case WORD in` in the
 * same segment. Elsewhere `(cmd)` may be a subshell, so it is checked as a
 * command (fail closed).
 */
const CASE_PATTERN_AFTER_IN = /^\(?[^()]*\)$/;

interface SimpleCommandOptions {
  /** Recognize reserved words. False for words that bash never reads as keywords (e.g. after `sudo`). */
  keywords?: boolean;
  /** The segment starts a `case` arm, so a leading pattern token is not a command. */
  caseArmStart?: boolean;
  /** Rebuild the dequoted word of a token (see dequoteCommand). */
  decode?: (token: string) => string;
  /** See DequotedCommand.hasRawEscape. */
  hasRawEscape?: (token: string) => boolean;
}

interface SimpleCommandResult {
  executable: string | null;
  /** Index of the executable token, or tokens.length when there is none. */
  index: number;
  /** The segment ended with `case WORD in`, so the next segment starts a `case` arm. */
  opensCaseArm: boolean;
}

function tokenizeSegment(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * Find the executable of a single simple command (no pipes/chains).
 *
 * Shell reserved words are syntax, not executables. Prefix words (`do`, `then`,
 * `!`, `time`, ...) are skipped and scanning continues, so an executable after a
 * keyword is always returned. Headers whose remaining words are never executed
 * (`for x in a b`, `select x in a`, `case $x in`, `[[ ... ]]`) and closing words
 * (`done`, `fi`, `esac`, `}`) yield no executable. Anything unexpected is
 * returned as the executable, so the permission check fails closed.
 */
function parseSimpleCommandTokens(tokens: string[], options: SimpleCommandOptions = {}): SimpleCommandResult {
  // Bash only reads reserved words in command position: once an assignment,
  // redirection or ordinary word has been seen, `if`/`do`/... are plain words.
  let keywords = options.keywords ?? true;
  const decode = options.decode ?? ((token: string) => token);
  let casePattern: RegExp | null = options.caseArmStart ? CASE_PATTERN : null;
  let i = 0;

  const none = (opensCaseArm = false): SimpleCommandResult => ({
    executable: null,
    index: tokens.length,
    opensCaseArm,
  });

  while (i < tokens.length) {
    const token = tokens[i];

    if (casePattern) {
      const pattern = casePattern;
      casePattern = null;
      if (pattern.test(token)) {
        i++;
        continue;
      }
    }

    // Keywords are matched against the raw token: a quoted or escaped word
    // (holding a quote placeholder) is never a reserved word.
    if (keywords) {
      if (PREFIX_KEYWORDS.has(token)) {
        i++;
        if (token === "time" && tokens[i] === "-p") i++;
        continue;
      }

      if (CLOSING_KEYWORDS.has(token)) {
        keywords = false;
        i++;
        continue;
      }

      if (token === "for" || token === "select") {
        // for NAME [in WORDS...] | for NAME do CMD
        i += 2;
        if (i >= tokens.length || tokens[i] === "in") return none();
        if (tokens[i] === "do") {
          i++;
          continue;
        }
        keywords = false;
        continue;
      }

      if (token === "case") {
        // case WORD in [PATTERN) CMD]
        i += 2;
        if (i >= tokens.length) return none();
        if (tokens[i] === "in") {
          i++;
          if (i >= tokens.length) return none(true);
          casePattern = CASE_PATTERN_AFTER_IN;
          continue;
        }
        keywords = false;
        continue;
      }

      if (token === "in") {
        // Continuation of a `for`/`select`/`case` header split across lines.
        return none();
      }

      if (token === "function") {
        // function NAME [()] BODY
        i += 2;
        if (tokens[i] === "()") i++;
        continue;
      }

      if (token === "[[") {
        // Conditional expression: its words are tested, never executed.
        const close = tokens.indexOf("]]", i + 1);
        // Without its `]]` the words cannot be bounded (bash would refuse it): fail closed.
        if (close === -1) throw new Error("unterminated [[ conditional");
        keywords = false;
        i = close + 1;
        continue;
      }
    }

    if (isEnvAssignment(token)) {
      keywords = false;
      i++;
      continue;
    }

    if (isRedirection(token)) {
      keywords = false;
      i += isBareRedirection(token) ? 2 : 1;
      continue;
    }

    if (options.hasRawEscape?.(token)) {
      throw new Error("ANSI-C escapes in a command name are not allowed");
    }

    const word = decode(token);
    if (!word) {
      // The whole word was quoted text; keep scanning like before, but bash
      // would no longer treat a following reserved word as a keyword.
      keywords = false;
      i++;
      continue;
    }

    return { executable: extractExecutableName(word), index: i, opensCaseArm: false };
  }

  return none();
}

interface CommandSegment {
  text: string;
  /** The segment follows `;;`, `;&` or `;;&`, i.e. it starts a new `case` arm. */
  caseArmStart: boolean;
}

/**
 * Split command by operators (pipes, and, or, background, semicolons).
 * Returns array of simple commands. Expects quotes to be removed already.
 */
function splitByOperators(cleaned: string): CommandSegment[] {
  // Split by operators: |, &&, ||, &, ;
  const commands: CommandSegment[] = [];
  let current = "";
  let caseArmStart = false;
  let i = 0;

  // Inside `[[ ... ]]`, `&&` and `||` are part of the test, not command separators.
  let inConditional = false;

  const flush = () => {
    if (current.trim()) {
      commands.push({ text: current.trim(), caseArmStart });
      caseArmStart = false;
    }
    current = "";
    inConditional = false;
  };

  const isWordBoundary = (c: string | undefined) => c === undefined || /[\s;&|()]/.test(c);

  while (i < cleaned.length) {
    const char = cleaned[i];
    const next = cleaned[i + 1];
    const prev = cleaned[i - 1];

    if (
      !inConditional &&
      char === "[" &&
      next === "[" &&
      isWordBoundary(prev) &&
      /\s/.test(cleaned[i + 2] ?? "") &&
      current
        .trim()
        .split(/\s+/)
        .every((word) => word === "" || PREFIX_KEYWORDS.has(word))
    ) {
      // `[[` in command position (only reserved words before it in this segment).
      inConditional = true;
    } else if (
      inConditional &&
      char === "]" &&
      next === "]" &&
      /\s/.test(prev ?? "") &&
      isWordBoundary(cleaned[i + 2])
    ) {
      inConditional = false;
    } else if (inConditional && ((char === "&" && next === "&") || (char === "|" && next === "|"))) {
      current += char + next;
      i += 2;
      continue;
    }

    // Handle operators
    if (char === "|" && next !== "|") {
      // Pipe (`|&` leaves `&` to start the next segment and is split below)
      flush();
      i++;
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      // && or ||
      flush();
      i += 2;
      continue;
    }

    if (char === "&" && next !== ">" && prev !== ">" && prev !== "<") {
      // Background `cmd & next`: `next` is a separate command. `&>`, `>&`
      // and `<&` are redirections and stay attached to their command.
      flush();
      i++;
      continue;
    }

    if (char === ";") {
      // Semicolon, or a `case` arm terminator: `;;`, `;&`, `;;&`
      flush();
      if (next === ";" || next === "&") {
        caseArmStart = true;
        i += next === ";" && cleaned[i + 2] === "&" ? 3 : 2;
        continue;
      }
      i++;
      continue;
    }

    current += char;
    i++;
  }

  flush();
  return commands;
}

/**
 * Check if an executable with its arguments represents inline code execution.
 */
function isInlineCodeExecution(
  executable: string,
  command: string,
  decode: (token: string) => string,
): { blocked: boolean; reason?: string } {
  const flags = INLINE_CODE_INTERPRETERS[executable];
  if (!flags) return { blocked: false };

  // Check if any inline code flag is present in the command
  const tokens = command.split(/\s+/).map(decode);
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
 * - Reserved words: for f in *; do rm "$f"; done -> ["rm"]
 */
export function parseBashCommand(command: string): ParsedCommand {
  try {
    // Dequote (quoted text becomes placeholders, newlines become `;`), then split by operators
    const { text, decode, hasRawEscape } = dequoteCommand(command);
    const simpleCommands = splitByOperators(text);

    // Extract executables from each command
    const executables: string[] = [];
    const seenInline: string[] = [];
    let opensCaseArm = false;

    for (const segment of simpleCommands) {
      const cmd = segment.text;
      const tokens = tokenizeSegment(cmd);
      const parsed = parseSimpleCommandTokens(tokens, {
        caseArmStart: segment.caseArmStart || opensCaseArm,
        decode,
        hasRawEscape,
      });
      opensCaseArm = parsed.opensCaseArm;
      const exec = parsed.executable;
      if (exec) {
        executables.push(exec);

        // Check for sudo - also extract the actual command
        if (exec === "sudo") {
          const actualExec = parseSimpleCommandTokens(tokens.slice(parsed.index + 1), {
            keywords: false,
            decode,
            hasRawEscape,
          }).executable;
          if (actualExec) {
            executables.push(actualExec);
          }
        }

        // Check for inline code execution
        const inlineCheck = isInlineCodeExecution(exec, cmd, decode);
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
 * are skipped. A redirection whose target cannot be read is reported as "?".
 */
export function findOutputRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === "\\" && quote === '"') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== ">") continue;
    let j = i + 1;
    if (command[j] === ">" || command[j] === "|") j++;
    if (command[j] === "&") {
      // `>&N` duplicates a descriptor; `>&file` is a bash-ism for "both streams to file".
      const dup = /^&\s*(\d+|-)(?![^\s;&|<>])/.exec(command.slice(j));
      if (dup) {
        i = j + dup[0].length - 1;
        continue;
      }
      j++;
    }
    while (command[j] === " " || command[j] === "\t") j++;
    const rest = command.slice(j);
    const target = /^(?:"[^"]*"|'[^']*'|[^\s;&|<>])+/.exec(rest)?.[0];
    targets.push(target ? target.replace(/["']/g, "") : "?");
    i = j + (target?.length ?? 0) - 1;
  }
  return targets;
}

/** Remove shell quoting (`r'a'vi` → `ravi`) so text checks see what the shell will run. */
export function stripShellQuoting(command: string): string {
  return command.replace(/\\(.)/g, "$1").replace(/["']/g, "");
}
