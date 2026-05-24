/**
 * Trigger Filter Evaluator
 *
 * Evaluates restricted boolean filter expressions against event data.
 * No eval, no new Function().
 *
 * Syntax:
 *   data.<path> <operator> "<value>"
 *   !<expression>
 *   <expression> && <expression>
 *   <expression> || <expression>
 *   (<expression>)
 *
 * Operators: ==, !=, startsWith, endsWith, includes
 */

import { logger } from "../utils/logger.js";

const log = logger.child("triggers:filter");

type ComparisonOperator = "==" | "!=" | "startsWith" | "endsWith" | "includes";

type FilterAst =
  | { type: "comparison"; path: string; operator: ComparisonOperator; expected: string }
  | { type: "and"; left: FilterAst; right: FilterAst }
  | { type: "or"; left: FilterAst; right: FilterAst }
  | { type: "not"; expression: FilterAst };

type Token =
  | { type: "path"; value: string; position: number }
  | { type: "operator"; value: ComparisonOperator; position: number }
  | { type: "string"; value: string; position: number }
  | { type: "and"; position: number }
  | { type: "or"; position: number }
  | { type: "not"; position: number }
  | { type: "lparen"; position: number }
  | { type: "rparen"; position: number }
  | { type: "word"; value: string; position: number }
  | { type: "eof"; position: number };

type ParseResult = { ok: true; ast: FilterAst } | { ok: false; error: string };

export type FilterValidationResult = { ok: true } | { ok: false; error: string };

const COMPARISON_OPERATORS = new Set<string>(["==", "!=", "startsWith", "endsWith", "includes"]);
const PATH_RE = /^data\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function isComparisonOperator(value: string): value is ComparisonOperator {
  return COMPARISON_OPERATORS.has(value);
}

function syntaxError(message: string, position: number): string {
  return `${message} at character ${position}`;
}

function tokenize(input: string): Token[] | string {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (!char) break;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (input.startsWith("&&", index)) {
      tokens.push({ type: "and", position: index });
      index += 2;
      continue;
    }

    if (input.startsWith("||", index)) {
      tokens.push({ type: "or", position: index });
      index += 2;
      continue;
    }

    if (input.startsWith("!=", index)) {
      tokens.push({ type: "operator", value: "!=", position: index });
      index += 2;
      continue;
    }

    if (input.startsWith("==", index)) {
      tokens.push({ type: "operator", value: "==", position: index });
      index += 2;
      continue;
    }

    if (char === "!") {
      tokens.push({ type: "not", position: index });
      index += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ type: "lparen", position: index });
      index += 1;
      continue;
    }

    if (char === ")") {
      tokens.push({ type: "rparen", position: index });
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      const position = index;
      index += 1;
      let value = "";
      let closed = false;
      while (index < input.length) {
        const next = input[index];
        if (next === "\\") {
          const escaped = input[index + 1];
          if (escaped === undefined) {
            return syntaxError("Unterminated escape sequence", index);
          }
          value += escaped;
          index += 2;
          continue;
        }
        if (next === quote) {
          index += 1;
          closed = true;
          tokens.push({ type: "string", value, position });
          break;
        }
        value += next;
        index += 1;
      }
      if (!closed) {
        return syntaxError("Unterminated quoted string", position);
      }
      continue;
    }

    const wordStart = index;
    while (
      index < input.length &&
      !/\s/.test(input[index] ?? "") &&
      !["(", ")", "!", "=", "&", "|", '"', "'"].includes(input[index] ?? "")
    ) {
      index += 1;
    }

    if (index === wordStart) {
      return syntaxError(`Unexpected character '${char}'`, index);
    }

    const value = input.slice(wordStart, index);
    if (isComparisonOperator(value)) {
      tokens.push({ type: "operator", value, position: wordStart });
    } else if (PATH_RE.test(value)) {
      tokens.push({ type: "path", value, position: wordStart });
    } else {
      tokens.push({ type: "word", value, position: wordStart });
    }
  }

  tokens.push({ type: "eof", position: input.length });
  return tokens;
}

class FilterParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ParseResult {
    const ast = this.parseOr();
    if (typeof ast === "string") return { ok: false, error: ast };

    const current = this.current();
    if (current.type !== "eof") {
      return { ok: false, error: syntaxError(`Unexpected token '${this.describe(current)}'`, current.position) };
    }

    return { ok: true, ast };
  }

  private parseOr(): FilterAst | string {
    let left = this.parseAnd();
    if (typeof left === "string") return left;

    while (this.match("or")) {
      const right = this.parseAnd();
      if (typeof right === "string") return right;
      left = { type: "or", left, right };
    }

    return left;
  }

  private parseAnd(): FilterAst | string {
    let left = this.parseUnary();
    if (typeof left === "string") return left;

    while (this.match("and")) {
      const right = this.parseUnary();
      if (typeof right === "string") return right;
      left = { type: "and", left, right };
    }

    return left;
  }

  private parseUnary(): FilterAst | string {
    if (this.match("not")) {
      const expression = this.parseUnary();
      if (typeof expression === "string") return expression;
      return { type: "not", expression };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): FilterAst | string {
    if (this.match("lparen")) {
      const expression = this.parseOr();
      if (typeof expression === "string") return expression;
      if (!this.match("rparen")) {
        return syntaxError("Expected ')'", this.current().position);
      }
      return expression;
    }

    return this.parseComparison();
  }

  private parseComparison(): FilterAst | string {
    const path = this.consume("path", "Expected data.<path>");
    if (typeof path === "string") return path;

    const operator = this.consume("operator", "Expected comparison operator");
    if (typeof operator === "string") return operator;

    const expected = this.consume("string", "Expected quoted string value");
    if (typeof expected === "string") return expected;

    return {
      type: "comparison",
      path: path.value,
      operator: operator.value,
      expected: expected.value,
    };
  }

  private match(type: Token["type"]): boolean {
    if (this.current().type !== type) return false;
    this.index += 1;
    return true;
  }

  private consume<T extends Token["type"]>(type: T, message: string): Extract<Token, { type: T }> | string {
    const token = this.current();
    if (token.type !== type) {
      return syntaxError(`${message}, got '${this.describe(token)}'`, token.position);
    }
    this.index += 1;
    return token as Extract<Token, { type: T }>;
  }

  private current(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1] ?? { type: "eof", position: 0 };
  }

  private describe(token: Token): string {
    switch (token.type) {
      case "path":
      case "operator":
      case "string":
      case "word":
        return token.value;
      case "and":
        return "&&";
      case "or":
        return "||";
      case "not":
        return "!";
      case "lparen":
        return "(";
      case "rparen":
        return ")";
      case "eof":
        return "end of input";
    }
  }
}

function parseFilter(filter: string): ParseResult {
  const tokens = tokenize(filter);
  if (typeof tokens === "string") {
    return { ok: false, error: tokens };
  }
  return new FilterParser(tokens).parse();
}

/**
 * Validate a filter expression before persisting it through CLI commands.
 */
export function validateFilter(filter: string | undefined): FilterValidationResult {
  if (!filter || filter.trim() === "") {
    return { ok: true };
  }

  const parsed = parseFilter(filter.trim());
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
}

/**
 * Resolve a dot-notation path into an object.
 * e.g. "data.hook_event_name" with root { hook_event_name: "Stop" } -> "Stop"
 * The leading "data." is stripped before resolution.
 */
function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.replace(/^data\./, "").split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (!part) return undefined;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evaluateAst(ast: FilterAst, data: unknown): boolean {
  switch (ast.type) {
    case "and":
      return evaluateAst(ast.left, data) && evaluateAst(ast.right, data);
    case "or":
      return evaluateAst(ast.left, data) || evaluateAst(ast.right, data);
    case "not":
      return !evaluateAst(ast.expression, data);
    case "comparison": {
      const rawValue = resolvePath(data, ast.path);
      if (rawValue === undefined) return false;

      const value = String(rawValue);
      switch (ast.operator) {
        case "==":
          return value === ast.expected;
        case "!=":
          return value !== ast.expected;
        case "startsWith":
          return value.startsWith(ast.expected);
        case "endsWith":
          return value.endsWith(ast.expected);
        case "includes":
          return value.includes(ast.expected);
      }
    }
  }
}

/**
 * Evaluate a filter expression against event data.
 *
 * Returns true if:
 * - filter is undefined or empty (no filter = always fires)
 * - filter matches the data
 * - filter is invalid (fail open, logs warning)
 *
 * Returns false if the filter expression evaluates to false.
 */
export function evaluateFilter(filter: string | undefined, data: unknown): boolean {
  if (!filter || filter.trim() === "") {
    return true;
  }

  const parsed = parseFilter(filter.trim());
  if (!parsed.ok) {
    log.warn("Trigger filter: invalid syntax, failing open", { filter, error: parsed.error });
    return true;
  }

  return evaluateAst(parsed.ast, data);
}
