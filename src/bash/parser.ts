/**
 * Bash Command Parser
 *
 * Extracts visible executables from the supported shell subset for permission
 * checking. Syntax checks prevent common accidents, not arbitrary host effects.
 */

import type { AnalyzedCommand, ParsedCommand, PatternCheckResult } from "./types.js";
import { parse as parseShell, type ParseEntry } from "shell-quote";
import { resolve } from "node:path";
import { physicalPathForPermissionCheck } from "../permissions/provider-config-paths.js";
import { collectShellLevels, isShellAnalysisError, ShellAnalysisError, type ShellLevel } from "./shell-structure.js";
import { launcherPayloads, type Argv } from "./launchers.js";

// ============================================================================
// Dangerous Patterns (checked before parsing)
// ============================================================================

/**
 * Indirect executables blocked for named-executable contexts. Arbitrary shell
 * authority is decided by the permission hook, never inferred by this parser.
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
  bun: ["-e", "--eval", "-p", "--print"],
  osascript: ["-e"],
};

/** `python3.11` uses the `python3` inline-code flags. */
function inlineCodeFlags(executable: string): string[] | undefined {
  return INLINE_CODE_INTERPRETERS[executable] ?? INLINE_CODE_INTERPRETERS[executable.replace(/\.\d+$/, "")];
}

// ============================================================================
// Pattern Checking
// ============================================================================

/** Every level of `command`, or the analyzer's named refusal. */
function shellLevels(command: string): ShellLevel[] | { error: string } {
  try {
    return collectShellLevels(command);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Cannot analyze shell command" };
  }
}

/**
 * Check structure the policy cannot authorize command by command: text the
 * analyzer cannot model (named `unknown_parse`) and stdin piped into a shell or
 * interpreter. Substitutions, process substitutions and here-documents are not
 * refused here: {@link parseBashCommand} returns the commands inside them.
 */
export function checkDangerousPatterns(command: string): PatternCheckResult {
  const levels = shellLevels(command);
  if (!Array.isArray(levels)) return { safe: false, reason: levels.error, code: "unknown_parse" };
  for (const level of levels) {
    const result = checkPipelineReceivers(level.text);
    if (!result.safe) return result;
  }
  return { safe: true };
}

function checkPipelineReceivers(command: string): PatternCheckResult {
  const inspected = inspectShellSyntax(command);
  if (inspected.error) return { safe: false, reason: inspected.error, code: "unknown_parse" };
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
      if (inlineCodeFlags(executable)) {
        if (isInlineCodeExecution(executable, receiver).blocked) {
          return { safe: false, reason: "piping to interpreter with inline code is not allowed" };
        }
        if (countCommandWords(receiver) === 1) {
          return { safe: false, reason: "piping to interpreter stdin is not allowed" };
        }
      }
    }
  } catch (error) {
    return {
      safe: false,
      reason: error instanceof Error ? error.message : "Cannot parse shell pipeline safely",
      code: "unknown_parse",
    };
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
function inspectShellSyntax(input: string): {
  command: string;
  syntax: string;
  masked: string;
  /** Same offsets as `command`, with comment characters replaced by spaces. */
  code: string;
  error?: string;
} {
  let command = "";
  let code = "";
  let syntax = "";
  /** Same offsets as `command`, but literal material becomes `_` so word
   * boundaries and quoting stay decidable without re-scanning quotes. */
  let masked = "";
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
      if (next === undefined) return { command, syntax, masked, code, error: "Unterminated shell escape" };
      // Inside double quotes, backslash only escapes $, `, ", backslash or newline.
      if (!quote || /[$`"\\]/.test(next)) {
        command += char + next;
        code += char + next;
        syntax += "  ";
        masked += "__";
        wordStart = false;
        i++;
        continue;
      }
    }
    if (!quote && char === "$" && (next === "'" || next === '"')) {
      return { command, syntax, masked, code, error: "Expanded shell quoting is not supported" };
    }
    if (!quote && char === "#" && wordStart) {
      while (i < input.length && input[i] !== "\n") {
        command += input[i];
        code += " ";
        syntax += " ";
        masked += "_";
        i++;
      }
      i--;
      continue;
    }
    command += char;
    code += char;
    if (char === quote) {
      quote = undefined;
      syntax += " ";
      masked += "_";
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
      syntax += " ";
      masked += "_";
    } else if (quote === '"' && char === "$" && next === "(") {
      command += next;
      code += next;
      syntax += "$(";
      masked += "$(";
      i = nextIndex;
    } else if (!quote || (quote === '"' && char === "`")) {
      syntax += char;
      masked += char;
    } else {
      syntax += " ";
      masked += "_";
    }
    wordStart = !quote && /[\s;&|()<>]/.test(char);
  }
  return { command, syntax, masked, code, ...(quote ? { error: "Unterminated shell quote" } : {}) };
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
 * Words that Bash only recognizes as syntax when they appear unquoted.
 * `"do"`, `'do'` and `\do` are ordinary command words.
 */
const RESERVED_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "for",
  "select",
  "case",
  "esac",
  "in",
  "function",
  "time",
  "!",
  "{",
  "}",
  "[[",
  "]]",
]);

/** Reserved words that start a construct whose header words are not commands. */
const RESERVED_PREFIX_WORDS = new Set(["if", "then", "elif", "else", "while", "until", "!", "time"]);

const OPENING_WORDS = new Set(["for", "select", "case", "function"]);

const REDIRECT_OPERATORS = new Set([">", ">>", ">|", "&>", "<>", "<", "<&", ">&"]);

type Atom = { kind: "word" | "operator"; text: string; active: boolean; assignment: boolean };

const ASSIGNMENT_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

/**
 * Split a segment into words and operators with quoting already resolved.
 * A word is `active` when every character was typed unquoted and unescaped;
 * only active words can be reserved words. A word is an `assignment` when its
 * `NAME=` prefix is unquoted: `A="x y" cmd` assigns, `"A=x" cmd` runs `A=x`.
 */
function scanAtoms(command: string): Atom[] {
  const inspected = inspectShellSyntax(command);
  if (inspected.error) throw new ShellAnalysisError(inspected.error);
  const source = inspected.command;
  const mask = inspected.masked;
  const atoms: Atom[] = [];
  let i = 0;
  while (i < source.length) {
    const char = mask[i]!;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (/[;&|()<>]/.test(char)) {
      let text = char;
      let next = mask[i + 1] ?? "";
      if ((char === ";" || char === "&" || char === "|") && next === char) {
        text += next;
        i++;
        next = mask[i + 1] ?? "";
      }
      if ((char === ">" || char === "<") && (next === ">" || next === "&")) {
        text += next;
        i++;
      } else if (char === ">" && next === "|") {
        text += next;
        i++;
      } else if (char === "&" && next === ">") {
        text += next;
        i++;
      }
      atoms.push({ kind: "operator", text, active: true, assignment: false });
      i++;
      continue;
    }
    const start = i;
    while (i < source.length && !/[\s;&|()<>]/.test(mask[i]!)) i++;
    const text = source.slice(start, i);
    const masked = mask.slice(start, i);
    const active = masked === text;
    const prefix = ASSIGNMENT_PREFIX.exec(text);
    const assignment = !!prefix && masked.startsWith(prefix[0]);
    atoms.push({ kind: "word", text, active, assignment });
  }
  return atoms;
}

const dynamicExpansion = () => ({ op: "glob", pattern: "unknown expansion" });

/**
 * Decode a word the way the shell would. `null` means the word depends on an
 * expansion (variable, glob, substitution placeholder) and cannot be known.
 */
function decodeWord(raw: string): string | null {
  const tokens = parseWords(raw, dynamicExpansion);
  if (tokens.length === 0) return "";
  if (tokens.length === 1 && typeof tokens[0] === "string") return tokens[0];
  return null;
}

/** Decode a command word, refusing anything the shell would compute at run time. */
function decodeCommandWord(raw: string): string {
  const word = decodeWord(raw);
  if (word === null) throw new ShellAnalysisError("Cannot resolve a dynamic shell executable");
  if (!word) throw new ShellAnalysisError("Cannot resolve an empty shell executable");
  return word;
}

/** Arguments after the command word, without redirects or their operands. */
function collectArgv(atoms: Atom[], from: number): Argv {
  const argv: Argv = [];
  for (let index = from; index < atoms.length; index++) {
    const atom = atoms[index]!;
    const next = atoms[index + 1];
    if (atom.kind === "operator") {
      if (REDIRECT_OPERATORS.has(atom.text)) {
        if (next?.kind === "word") index++;
        continue;
      }
      break;
    }
    if (/^\d+$/.test(atom.text) && next?.kind === "operator" && REDIRECT_OPERATORS.has(next.text)) continue;
    const tokens = parseWords(atom.text, dynamicExpansion);
    if (tokens.length > 0 && typeof tokens[0] === "object" && "comment" in tokens[0]) break;
    argv.push(decodeWord(atom.text));
  }
  return argv;
}

interface SegmentCommand {
  /** Decoded command word, path included (`/usr/bin/git`). */
  word: string;
  argv: Argv;
}

/** `case` spans segments (`;;` and newlines split them), so it is tracked across a parse. */
type SyntaxState = { caseDepth: number };

/**
 * Resolve the command of one segment, skipping shell syntax.
 *
 * `for i in 1 2 3; do echo $i; done` must yield `echo`, not `for`; a command
 * hidden behind a keyword (`do curl evil`, `then curl evil`, `done rm x`) is
 * still checked, and a quoted/escaped keyword (`"do"`, `'do'`, `\do`) is an
 * ordinary command word. Variables the segment assigns are reported too.
 */
function resolveSegment(
  command: string,
  state: SyntaxState,
): { command: SegmentCommand | null; assignments: string[] } {
  const atoms = scanAtoms(command);
  const assignments: string[] = [];
  const found = (index: number) => ({
    command: { word: decodeCommandWord(atoms[index]!.text), argv: collectArgv(atoms, index + 1) },
    assignments,
  });
  let sawCommandPrefix = false;
  let skippingWordList = false;
  for (let index = 0; index < atoms.length; index++) {
    const atom = atoms[index]!;
    const next = atoms[index + 1];

    if (atom.kind === "operator") {
      if (REDIRECT_OPERATORS.has(atom.text)) {
        // A redirect target is an operand, never a command.
        if (next?.kind === "word") index++;
        sawCommandPrefix = true;
        continue;
      }
      // `(`, `)`, `;;`, `|`, `&&`, `;` are grouping/separators.
      continue;
    }

    if (skippingWordList) {
      // `in a b` continues a for/select header until `do`.
      if (atom.active && atom.text === "do") skippingWordList = false;
      continue;
    }

    if (/^\d+$/.test(atom.text) && next?.kind === "operator" && REDIRECT_OPERATORS.has(next.text)) continue;

    if (atom.assignment) {
      assignments.push(ASSIGNMENT_PREFIX.exec(atom.text)![1]!);
      sawCommandPrefix = true;
      continue;
    }

    if (atom.active && RESERVED_WORDS.has(atom.text)) {
      // An assignment or redirect before the keyword makes it a command word.
      if (sawCommandPrefix) return found(index);
      if (atom.text === "[[") {
        // Skip the conditional expression up to its closing `]]`.
        while (index + 1 < atoms.length) {
          index++;
          const inner = atoms[index]!;
          if (inner.kind === "word" && inner.active && inner.text === "]]") break;
        }
        continue;
      }
      if (atom.text === "in") {
        skippingWordList = true;
        continue;
      }
      if (OPENING_WORDS.has(atom.text)) {
        // for/select: loop variable; case: subject; function: name.
        if (atom.text === "case") state.caseDepth += 1;
        if (next?.kind === "word") {
          if (atom.text === "for" || atom.text === "select") assignments.push(next.text);
          index++;
        }
        const afterHeader = atoms[index + 1];
        if (atom.text === "for" || atom.text === "select") {
          if (afterHeader?.kind === "word" && afterHeader.active && afterHeader.text === "in") {
            index++;
            skippingWordList = true;
          }
        } else if (atom.text === "case") {
          if (afterHeader?.kind === "word" && afterHeader.active && afterHeader.text === "in") index++;
        }
        continue;
      }
      if (atom.text === "time") {
        while (atoms[index + 1]?.kind === "word" && atoms[index + 1]!.text.startsWith("-")) index++;
        continue;
      }
      if (RESERVED_PREFIX_WORDS.has(atom.text)) continue;
      if (atom.text === "esac" && state.caseDepth > 0) state.caseDepth -= 1;
      continue;
    }

    // A case arm pattern (`a)`, `*)`, `(a)`) is syntax, not a command.
    if (state.caseDepth > 0 && !sawCommandPrefix && next?.kind === "operator" && next.text === ")") {
      index++;
      continue;
    }

    return found(index);
  }
  return { command: null, assignments };
}

/**
 * Parse a single simple command (no pipes/chains) and extract the executable name.
 */
function parseSimpleCommand(command: string, state: SyntaxState = { caseDepth: 0 }): string | null {
  const resolved = resolveSegment(command.trim(), state).command;
  return resolved ? extractExecutableName(resolved.word) : null;
}

/**
 * Split command by operators (pipes, and, or, semicolons).
 * Returns array of simple commands.
 */
function splitByOperators(command: string): string[] {
  const inspected = inspectShellSyntax(command);
  if (inspected.error) throw new ShellAnalysisError(inspected.error);
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
  const flags = inlineCodeFlags(executable);
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
    if (hasInlineFlag(flags, token)) {
      return {
        blocked: true,
        reason: `${executable} with inline code flag is not allowed`,
      };
    }
  }

  return { blocked: false };
}

function hasInlineFlag(flags: string[], token: string): boolean {
  return flags.some(
    (flag) => token === flag || token.startsWith(flag + "=") || (flag.length === 2 && token.startsWith(flag)),
  );
}

/** Inline-code refusal for an analyzed command, judged on its own argv. */
function inlineCodeReason(command: AnalyzedCommand): string | undefined {
  const flags = inlineCodeFlags(command.name);
  if (!flags) return undefined;
  return command.argv.some((arg) => arg !== null && hasInlineFlag(flags, arg))
    ? `${command.name} with inline code flag is not allowed`
    : undefined;
}

/** Builtins whose arguments name variables they assign. */
const ASSIGNING_BUILTINS = new Set([
  "export",
  "declare",
  "typeset",
  "readonly",
  "local",
  "read",
  "mapfile",
  "readarray",
]);

function builtinAssignments(command: AnalyzedCommand): string[] {
  const names: string[] = [];
  if (ASSIGNING_BUILTINS.has(command.name)) {
    for (const arg of command.argv) {
      if (arg === null || arg.startsWith("-")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\+?=|$)/.exec(arg);
      if (match) names.push(match[1]!);
    }
  }
  if (command.name === "printf") {
    command.argv.forEach((arg, index) => {
      if (arg === "-v" && command.argv[index + 1]) names.push(command.argv[index + 1]!);
      else if (arg?.startsWith("-v") && arg.length > 2) names.push(arg.slice(2));
    });
  }
  return names;
}

const MAX_LAUNCHER_DEPTH = 8;

function expandLauncher(command: AnalyzedCommand, out: AnalyzedCommand[], assignments: string[], depth: number): void {
  const launched = launcherPayloads(command.name, [command.word, ...command.argv]);
  if (!launched) return;
  if (launched.kind === "shell_string") {
    command.launchesShellString = launched.reason;
    return;
  }
  if (depth >= MAX_LAUNCHER_DEPTH) throw new ShellAnalysisError("Launchers are nested too deeply to analyze");
  assignments.push(...launched.assignments);
  for (const payload of launched.payloads) {
    const word = payload[0];
    if (word === null || word === undefined) {
      throw new ShellAnalysisError(`Cannot resolve the command launched by ${command.name}: it is dynamic`);
    }
    if (word.includes("{}")) {
      throw new ShellAnalysisError(`Cannot resolve the command launched by ${command.name}: it comes from its input`);
    }
    if (!word) throw new ShellAnalysisError(`Cannot resolve the command launched by ${command.name}: it is empty`);
    const child: AnalyzedCommand = {
      name: extractExecutableName(word),
      word,
      argv: payload.slice(1),
      origin: "launcher",
      launcher: command.name,
      text: command.text,
    };
    out.push(child);
    assignments.push(...builtinAssignments(child));
    expandLauncher(child, out, assignments, depth + 1);
  }
}

export interface BashAnalysis {
  commands: AnalyzedCommand[];
  /** Variables any part of the command assigns or exports. */
  assignments: string[];
}

/**
 * Every command the shell would run for `command`, with its path as typed and
 * where it came from (segment, substitution, process substitution, here-doc,
 * launcher). Throws {@link ShellAnalysisError} for anything it cannot model.
 */
export function analyzeBashCommand(command: string): BashAnalysis {
  const commands: AnalyzedCommand[] = [];
  const assignments: string[] = [];
  try {
    for (const level of collectShellLevels(command)) {
      const state: SyntaxState = { caseDepth: 0 };
      for (const segment of splitByOperators(level.text)) {
        const resolved = resolveSegment(segment, state);
        assignments.push(...resolved.assignments);
        if (!resolved.command) continue;
        const analyzed: AnalyzedCommand = {
          name: extractExecutableName(resolved.command.word),
          word: resolved.command.word,
          argv: resolved.command.argv,
          origin: level.origin,
          text: segment,
        };
        commands.push(analyzed);
        assignments.push(...builtinAssignments(analyzed));
        expandLauncher(analyzed, commands, assignments, 0);
      }
    }
  } catch (error) {
    if (isShellAnalysisError(error)) throw error;
    throw new ShellAnalysisError(error instanceof Error ? error.message : "Cannot analyze shell command");
  }
  return { commands, assignments };
}

/**
 * Parse a bash command and extract all executables.
 *
 * Handles:
 * - Pipes: cat file | grep foo -> ["cat", "grep"]
 * - Chains: git status && npm install -> ["git", "npm"]
 * - Env vars: NODE_ENV=prod node app.js -> ["node"]
 * - Launchers: sudo rm -rf / -> ["sudo", "rm"], xargs grep x -> ["xargs", "grep"]
 * - Substitutions and here-docs: echo $(date) -> ["echo", "date"]
 * - Full paths: /usr/bin/git status -> ["git"] (see `commands` for the path)
 * - Semicolons: ls; pwd -> ["ls", "pwd"]
 *
 * A command the analyzer cannot model fails with `code: "unknown_parse"`.
 */
export function parseBashCommand(command: string, options: { allowInlineCode?: boolean } = {}): ParsedCommand {
  let analysis: BashAnalysis;
  try {
    analysis = analyzeBashCommand(command);
  } catch (err) {
    return {
      executables: [],
      success: false,
      error: err instanceof Error ? err.message : "Parse error",
      code: "unknown_parse",
    };
  }
  const inline = analysis.commands.map(inlineCodeReason).find(Boolean);
  if (inline && !options.allowInlineCode) {
    return { executables: [], success: false, error: inline, code: "inline_code" };
  }
  return {
    executables: [...new Set(analysis.commands.map((analyzed) => analyzed.name))],
    commands: analysis.commands,
    assignments: [...new Set(analysis.assignments)],
    success: true,
  };
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
 * and quote parsing. We model only simple commands separated by &&, ||, ;,
 * pipes or newlines, input redirects, and literal cd destinations. Callers pass
 * one level at a time (see collectShellLevels): substitutions and here-docs
 * must already be extracted. Retaining both sides of every cd over-approximates
 * control flow instead of assuming it succeeds. More complex shell execution
 * cannot be authorized as a harmless redirect from this static inspection.
 */
export function analyzeOutputRedirects(
  command: string,
  cwd = process.cwd(),
): { writes: ShellOutputRedirect[]; error?: string } {
  const writes: ShellOutputRedirect[] = [];
  // The tokenizer does not model newline command boundaries, comments that end
  // at a newline, or ANSI-C quotes. Comments are blanked and active newlines
  // become `;` (or a space after `|`, `&&`, `||`, `(`) before tokenizing.
  if (!command.includes(">")) return { writes };
  if (/\r/.test(command) || /\$['"]/.test(command)) {
    return { writes, error: "Cannot resolve output redirects with carriage returns or expanded shell quoting" };
  }
  const inspected = inspectShellSyntax(command);
  if (inspected.error) return { writes, error: "Cannot parse output redirect safely" };
  let normalized = "";
  let lastActive = "";
  for (let i = 0; i < inspected.code.length; i++) {
    const char = inspected.code[i]!;
    if (inspected.syntax[i] === "\n") {
      const continues = lastActive === "" || /[|&;(]/.test(lastActive);
      normalized += continues ? " " : ";";
      if (!continues) lastActive = ";";
      continue;
    }
    normalized += char;
    if (!/\s/.test(char)) lastActive = inspected.masked[i]!;
  }
  let tokens: ParseEntry[];
  try {
    tokens = parseWords(normalized, () => ({ op: "glob", pattern: "unknown expansion" }));
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
    // &> / &>> and >| are two tokens in shell-quote.
    const next = tokens[i + 1];
    if (token.op === "&" && typeof next === "object" && "op" in next && [">", ">>"].includes(next.op)) {
      continue;
    }
    // Pipeline stages and background jobs are separate simple commands. A `cd`
    // inside a pipeline stage runs in a subshell; keeping its directory too only
    // over-approximates where later redirects may land.
    if ([";", "&&", "||", "|", "|&", "&"].includes(token.op)) {
      const error = finishCommand();
      if (error) return { writes, error };
      continue;
    }
    // Input redirects read a file; they never write one.
    if (token.op === "<" || token.op === "<&") {
      if (typeof tokens[i + 1] !== "string") return { writes, error: "Cannot resolve an input redirect operand" };
      i++;
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
