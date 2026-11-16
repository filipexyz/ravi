/**
 * Shell structure extraction for the Bash permission guard.
 *
 * Separates the command text the shell will run at one level from the command
 * text nested inside it: `$(...)`, backticks, `<(...)`/`>(...)` and the
 * expansions of an unquoted here-document body. Every nested text is returned
 * with its origin so the policy can authorize what actually runs; the outer
 * text keeps a dynamic placeholder in its place.
 *
 * This is analysis only. It never decides authority, and anything it cannot
 * model throws {@link ShellAnalysisError} so the caller fails closed.
 */

export type NestedShellOrigin = "substitution" | "process_substitution" | "heredoc";

export interface NestedShellText {
  text: string;
  origin: NestedShellOrigin;
}

export interface ShellStructure {
  /** Text of this level with nested commands replaced by `${__RAVI_*}` placeholders and here-doc bodies removed. */
  outer: string;
  nested: NestedShellText[];
}

/** The analyzer could not model this command. Callers MUST fail closed. */
export class ShellAnalysisError extends Error {
  readonly code = "unknown_parse" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "ShellAnalysisError";
  }
}

export function isShellAnalysisError(error: unknown): error is ShellAnalysisError {
  return error instanceof ShellAnalysisError;
}

const MAX_NESTING = 8;

/** Skip backslash-newline continuations, which the shell removes outside single quotes. */
function skipContinuations(input: string, index: number): number {
  let i = index;
  while (input[i] === "\\" && input[i + 1] === "\n") i += 2;
  return i;
}

function findBacktickEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    if (input[i] === "\\") {
      i++;
      continue;
    }
    if (input[i] === "`") return i;
  }
  throw new ShellAnalysisError("Unterminated backtick substitution");
}

function findDoubleQuoteEnd(input: string, start: number): number {
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === '"') return i;
    if (char === "`") {
      i = findBacktickEnd(input, i + 1);
      continue;
    }
    if (char === "$" && input[skipContinuations(input, i + 1)] === "(") {
      i = findParenEnd(input, skipContinuations(input, i + 1) + 1);
    }
  }
  throw new ShellAnalysisError("Unterminated shell quote");
}

/**
 * Index of the `)` closing a `$(`, `<(` or `>(` whose body starts at `start`.
 * Quotes, nested substitutions and comments are skipped. A `case` statement
 * inside a substitution has unbalanced `)` and is refused instead of guessed.
 */
function findParenEnd(input: string, start: number): number {
  let depth = 0;
  let wordStart = true;
  for (let i = start; i < input.length; i++) {
    const char = input[i]!;
    if (char === "\\") {
      i++;
      wordStart = false;
      continue;
    }
    if (char === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new ShellAnalysisError("Unterminated shell quote");
      i = end;
      wordStart = false;
      continue;
    }
    if (char === '"') {
      i = findDoubleQuoteEnd(input, i + 1);
      wordStart = false;
      continue;
    }
    if (char === "`") {
      i = findBacktickEnd(input, i + 1);
      wordStart = false;
      continue;
    }
    if (char === "#" && wordStart) {
      const end = input.indexOf("\n", i);
      if (end < 0) break;
      i = end;
      wordStart = true;
      continue;
    }
    if (wordStart && /^case[\s;]/.test(input.slice(i, i + 5))) {
      throw new ShellAnalysisError("A case statement inside a substitution is not supported");
    }
    if (char === "$" && input[skipContinuations(input, i + 1)] === "(") {
      i = findParenEnd(input, skipContinuations(input, i + 1) + 1);
      wordStart = false;
      continue;
    }
    if (char === "(") {
      depth++;
      wordStart = true;
      continue;
    }
    if (char === ")") {
      if (depth === 0) return i;
      depth--;
      wordStart = false;
      continue;
    }
    wordStart = /[\s;&|<>]/.test(char);
  }
  throw new ShellAnalysisError("Unterminated command or process substitution");
}

interface PendingHeredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

/** `$(...)`, backticks and arithmetic inside text the shell expands like a double-quoted string. */
function extractExpansionsFromExpandedText(text: string, origin: NestedShellOrigin): NestedShellText[] {
  const nested: NestedShellText[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "`") {
      const end = findBacktickEnd(text, i + 1);
      nested.push({ text: unescapeBacktickBody(text.slice(i + 1, end)), origin });
      i = end;
      continue;
    }
    if (char === "$" && text[skipContinuations(text, i + 1)] === "(") {
      const open = skipContinuations(text, i + 1);
      const end = findParenEnd(text, open + 1);
      const body = text.slice(open + 1, end);
      if (body.startsWith("(") && body.endsWith(")")) {
        nested.push(...extractExpansionsFromExpandedText(body.slice(1, -1), origin));
      } else {
        nested.push({ text: body, origin });
      }
      i = end;
    }
  }
  return nested;
}

/** Inside backticks, `\\`, `` \` `` and `\$` lose their backslash before the inner command is parsed. */
function unescapeBacktickBody(body: string): string {
  return body.replace(/\\([\\`$])/g, "$1").replace(/\\\n/g, "");
}

/**
 * Split one level of shell text into its outer command text and nested texts.
 * Quoted data never yields nested commands: single quotes, escaped `$`/backtick,
 * and quoted here-document bodies are literal.
 */
export function extractShellStructure(input: string): ShellStructure {
  let outer = "";
  const nested: NestedShellText[] = [];
  let quote: '"' | undefined;
  let wordStart = true;
  let placeholderCount = 0;
  let pending: PendingHeredoc[] = [];
  const placeholder = (kind: string) => `\${__RAVI_${kind}_${placeholderCount++}}`;

  let i = 0;
  while (i < input.length) {
    const char = input[i]!;

    if (char === "\\") {
      const next = input[i + 1];
      if (next === undefined) throw new ShellAnalysisError("Unterminated shell escape");
      if (next === "\n") {
        i += 2;
        continue;
      }
      outer += char + next;
      i += 2;
      wordStart = false;
      continue;
    }

    if (!quote && char === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new ShellAnalysisError("Unterminated shell quote");
      outer += input.slice(i, end + 1);
      i = end + 1;
      wordStart = false;
      continue;
    }

    if (char === '"') {
      quote = quote ? undefined : '"';
      outer += char;
      i++;
      wordStart = false;
      continue;
    }

    if (!quote && char === "#" && wordStart) {
      const end = input.indexOf("\n", i);
      const stop = end < 0 ? input.length : end;
      outer += input.slice(i, stop);
      i = stop;
      continue;
    }

    if (char === "$") {
      const after = skipContinuations(input, i + 1);
      if (!quote && (input[after] === "'" || input[after] === '"')) {
        throw new ShellAnalysisError("Expanded shell quoting ($'...' or $\"...\") is not supported");
      }
      if (input[after] === "(") {
        const end = findParenEnd(input, after + 1);
        const body = input.slice(after + 1, end);
        if (body.startsWith("(") && body.endsWith(")")) {
          // Arithmetic expansion: the expression is data, its own substitutions are commands.
          nested.push(...extractExpansionsFromExpandedText(body.slice(1, -1), "substitution"));
          outer += placeholder("ARITH");
        } else {
          nested.push({ text: body, origin: "substitution" });
          outer += placeholder("SUBST");
        }
        i = end + 1;
        wordStart = false;
        continue;
      }
    }

    if (char === "`") {
      const end = findBacktickEnd(input, i + 1);
      nested.push({ text: unescapeBacktickBody(input.slice(i + 1, end)), origin: "substitution" });
      outer += placeholder("SUBST");
      i = end + 1;
      wordStart = false;
      continue;
    }

    if (!quote && (char === "<" || char === ">") && input[i + 1] === "(") {
      const end = findParenEnd(input, i + 2);
      nested.push({ text: input.slice(i + 2, end), origin: "process_substitution" });
      outer += placeholder("PROCSUB");
      i = end + 1;
      wordStart = false;
      continue;
    }

    if (!quote && char === "<" && input[i + 1] === "<") {
      if (input[i + 2] === "<") {
        // Here-string: its word is data read on stdin, expanded like any argument.
        outer += "<";
        i += 3;
        wordStart = true;
        continue;
      }
      let j = i + 2;
      const stripTabs = input[j] === "-";
      if (stripTabs) j++;
      while (input[j] === " " || input[j] === "\t") j++;
      let delimiter = "";
      let quoted = false;
      while (j < input.length && !/[\s;&|()<>]/.test(input[j]!)) {
        const c = input[j]!;
        if (c === "'" || c === '"') {
          const close = input.indexOf(c, j + 1);
          if (close < 0) throw new ShellAnalysisError("Unterminated here-document delimiter quote");
          delimiter += input.slice(j + 1, close);
          quoted = true;
          j = close + 1;
          continue;
        }
        if (c === "\\") {
          if (j + 1 >= input.length) throw new ShellAnalysisError("Unterminated shell escape");
          delimiter += input[j + 1];
          quoted = true;
          j += 2;
          continue;
        }
        delimiter += c;
        j++;
      }
      if (!delimiter) throw new ShellAnalysisError("Missing here-document delimiter");
      pending.push({ delimiter, quoted, stripTabs });
      outer += " ";
      i = j;
      wordStart = false;
      continue;
    }

    if (char === "\n" && !quote && pending.length > 0) {
      outer += "\n";
      i++;
      for (const heredoc of pending) {
        let body = "";
        let terminated = false;
        while (i < input.length) {
          const newline = input.indexOf("\n", i);
          const lineEnd = newline < 0 ? input.length : newline;
          const line = input.slice(i, lineEnd);
          i = newline < 0 ? input.length : newline + 1;
          const compared = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
          if (compared === heredoc.delimiter) {
            terminated = true;
            break;
          }
          body += line + "\n";
        }
        if (!terminated) throw new ShellAnalysisError("Unterminated here document");
        if (!heredoc.quoted) nested.push(...extractExpansionsFromExpandedText(body, "heredoc"));
      }
      pending = [];
      wordStart = true;
      continue;
    }

    outer += char;
    i++;
    wordStart = !quote && /[\s;&|()<>]/.test(char);
  }

  if (quote) throw new ShellAnalysisError("Unterminated shell quote");
  if (pending.length > 0) throw new ShellAnalysisError("Unterminated here document");
  return { outer, nested };
}

export interface ShellLevel {
  /** Outer text of one level, free of substitutions and here-document bodies. */
  text: string;
  origin: "segment" | NestedShellOrigin;
  depth: number;
}

/** Every level of a command, outermost first. Throws {@link ShellAnalysisError}. */
export function collectShellLevels(command: string, origin: ShellLevel["origin"] = "segment", depth = 0): ShellLevel[] {
  if (depth > MAX_NESTING) throw new ShellAnalysisError("Shell nesting is too deep to analyze");
  const structure = extractShellStructure(command);
  const levels: ShellLevel[] = [{ text: structure.outer, origin, depth }];
  for (const nested of structure.nested) {
    // A nested text keeps the origin of the construct it came from.
    levels.push(...collectShellLevels(nested.text, origin === "segment" ? nested.origin : origin, depth + 1));
  }
  return levels;
}
