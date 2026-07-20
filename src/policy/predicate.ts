/**
 * Small, side-effect-free predicate language shared by runtime policy consumers.
 * It deliberately supports only string comparisons and boolean composition.
 */

export type PredicateComparisonOperator = "==" | "!=" | "startsWith" | "endsWith" | "includes";
export type PredicateFailMode = "open" | "closed";

type PredicateAst =
  | { type: "comparison"; path: string; operator: PredicateComparisonOperator; expected: string }
  | { type: "and"; left: PredicateAst; right: PredicateAst }
  | { type: "or"; left: PredicateAst; right: PredicateAst }
  | { type: "not"; expression: PredicateAst };

type Token =
  | { type: "path"; value: string; position: number }
  | { type: "operator"; value: PredicateComparisonOperator; position: number }
  | { type: "string"; value: string; position: number }
  | { type: "and" | "or" | "not" | "lparen" | "rparen" | "eof"; position: number }
  | { type: "word"; value: string; position: number };

export interface PredicateCompileOptions {
  allowedRoots?: Iterable<string>;
  /** Consumer-specific text used in syntax errors, for example `data.<path>`. */
  pathLabel?: string;
}

export interface CompiledPredicate {
  expression: string;
  paths: readonly string[];
  roots: readonly string[];
  evaluate(context: Record<string, unknown>): boolean;
}

export type PredicateCompileResult = { ok: true; predicate: CompiledPredicate } | { ok: false; error: string };

const OPERATORS = new Set<string>(["==", "!=", "startsWith", "endsWith", "includes"]);
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function isOperator(value: string): value is PredicateComparisonOperator {
  return OPERATORS.has(value);
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
    if (input.startsWith("!=", index) || input.startsWith("==", index)) {
      tokens.push({
        type: "operator",
        value: input.slice(index, index + 2) as PredicateComparisonOperator,
        position: index,
      });
      index += 2;
      continue;
    }
    if (char === "!") {
      tokens.push({ type: "not", position: index++ });
      continue;
    }
    if (char === "(") {
      tokens.push({ type: "lparen", position: index++ });
      continue;
    }
    if (char === ")") {
      tokens.push({ type: "rparen", position: index++ });
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const position = index++;
      let value = "";
      let closed = false;
      while (index < input.length) {
        const next = input[index];
        if (next === "\\") {
          const escaped = input[index + 1];
          if (escaped === undefined) return syntaxError("Unterminated escape sequence", index);
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
      if (!closed) return syntaxError("Unterminated quoted string", position);
      continue;
    }

    const start = index;
    while (
      index < input.length &&
      !/\s/.test(input[index] ?? "") &&
      !["(", ")", "!", "=", "&", "|", '"', "'"].includes(input[index] ?? "")
    ) {
      index += 1;
    }
    if (index === start) return syntaxError(`Unexpected character '${char}'`, index);
    const value = input.slice(start, index);
    if (isOperator(value)) tokens.push({ type: "operator", value, position: start });
    else if (PATH_RE.test(value)) tokens.push({ type: "path", value, position: start });
    else tokens.push({ type: "word", value, position: start });
  }
  tokens.push({ type: "eof", position: input.length });
  return tokens;
}

class PredicateParser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly allowedRoots: Set<string> | undefined,
    private readonly pathLabel: string,
  ) {}

  parse(): PredicateCompileResult {
    const ast = this.parseOr();
    if (typeof ast === "string") return { ok: false, error: ast };
    const current = this.current();
    if (current.type !== "eof") {
      return { ok: false, error: syntaxError(`Unexpected token '${this.describe(current)}'`, current.position) };
    }
    const paths = [...collectPaths(ast)].sort();
    return {
      ok: true,
      predicate: {
        expression: "",
        paths,
        roots: [...new Set(paths.map((path) => path.split(".")[0]!))].sort(),
        evaluate: (context) => evaluateAst(ast, context),
      },
    };
  }

  private parseOr(): PredicateAst | string {
    let left = this.parseAnd();
    if (typeof left === "string") return left;
    while (this.match("or")) {
      const right = this.parseAnd();
      if (typeof right === "string") return right;
      left = { type: "or", left, right };
    }
    return left;
  }

  private parseAnd(): PredicateAst | string {
    let left = this.parseUnary();
    if (typeof left === "string") return left;
    while (this.match("and")) {
      const right = this.parseUnary();
      if (typeof right === "string") return right;
      left = { type: "and", left, right };
    }
    return left;
  }

  private parseUnary(): PredicateAst | string {
    if (this.match("not")) {
      const expression = this.parseUnary();
      return typeof expression === "string" ? expression : { type: "not", expression };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): PredicateAst | string {
    if (!this.match("lparen")) return this.parseComparison();
    const expression = this.parseOr();
    if (typeof expression === "string") return expression;
    if (!this.match("rparen")) return syntaxError("Expected ')'", this.current().position);
    return expression;
  }

  private parseComparison(): PredicateAst | string {
    const path = this.consume("path", `Expected ${this.pathLabel}`);
    if (typeof path === "string") return path;
    const root = path.value.split(".")[0]!;
    if (this.allowedRoots && !this.allowedRoots.has(root)) {
      return syntaxError(`Path root '${root}' is not allowed`, path.position);
    }
    const operator = this.consume("operator", "Expected comparison operator");
    if (typeof operator === "string") return operator;
    const expected = this.consume("string", "Expected quoted string value");
    if (typeof expected === "string") return expected;
    return { type: "comparison", path: path.value, operator: operator.value, expected: expected.value };
  }

  private match(type: Token["type"]): boolean {
    if (this.current().type !== type) return false;
    this.index += 1;
    return true;
  }

  private consume<T extends Token["type"]>(type: T, message: string): Extract<Token, { type: T }> | string {
    const token = this.current();
    if (token.type !== type) return syntaxError(`${message}, got '${this.describe(token)}'`, token.position);
    this.index += 1;
    return token as Extract<Token, { type: T }>;
  }

  private current(): Token {
    return this.tokens[this.index] ?? { type: "eof", position: 0 };
  }

  private describe(token: Token): string {
    if ("value" in token) return token.value;
    return ({ and: "&&", or: "||", not: "!", lparen: "(", rparen: ")", eof: "end of input" } as const)[token.type];
  }
}

function collectPaths(ast: PredicateAst, result = new Set<string>()): Set<string> {
  if (ast.type === "comparison") result.add(ast.path);
  else if (ast.type === "not") collectPaths(ast.expression, result);
  else {
    collectPaths(ast.left, result);
    collectPaths(ast.right, result);
  }
  return result;
}

function resolvePath(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const part of path.split(".")) {
    if (!part || current === null || current === undefined || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evaluateAst(ast: PredicateAst, context: Record<string, unknown>): boolean {
  if (ast.type === "and") return evaluateAst(ast.left, context) && evaluateAst(ast.right, context);
  if (ast.type === "or") return evaluateAst(ast.left, context) || evaluateAst(ast.right, context);
  if (ast.type === "not") return !evaluateAst(ast.expression, context);
  const raw = resolvePath(context, ast.path);
  if (raw === undefined) return false;
  const value = String(raw);
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

export function compilePredicate(
  expression: string | null | undefined,
  options: PredicateCompileOptions = {},
): PredicateCompileResult {
  const normalized = expression?.trim() ?? "";
  if (!normalized) {
    return {
      ok: true,
      predicate: { expression: "", paths: [], roots: [], evaluate: () => true },
    };
  }
  const tokens = tokenize(normalized);
  if (typeof tokens === "string") return { ok: false, error: tokens };
  const allowedRoots = options.allowedRoots ? new Set(options.allowedRoots) : undefined;
  const parsed = new PredicateParser(tokens, allowedRoots, options.pathLabel ?? "<root>.<path>").parse();
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    predicate: { ...parsed.predicate, expression: normalized },
  };
}

export function evaluatePredicate(
  expression: string | null | undefined,
  context: Record<string, unknown>,
  options: PredicateCompileOptions & { failMode?: PredicateFailMode } = {},
): boolean {
  const compiled = compilePredicate(expression, options);
  if (!compiled.ok) return options.failMode === "open";
  return compiled.predicate.evaluate(context);
}
