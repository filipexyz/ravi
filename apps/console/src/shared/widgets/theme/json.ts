// Strict JSON parser that also records the line of every object key, so
// theme.json and fields.json diagnostics can point at the offending key.
// `JSON.parse` reports no position in every runtime, hence the small
// recursive-descent parser. Accepts exactly RFC 8259 JSON.

export type JsonPath = readonly (string | number)[];

export type JsonParseResult =
  | { ok: true; value: unknown; keyLine: (path: JsonPath) => number | undefined }
  | { ok: false; message: string; line: number; column: number };

const MAX_DEPTH = 64;
const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

export function pathKey(path: JsonPath) {
  return path.join("\u0000");
}

export function parseJsonWithLines(text: string): JsonParseResult {
  let pos = 0;
  let line = 1;
  const lines = new Map<string, number>();

  const fail = (message: string, at = pos): never => {
    throw new JsonSyntaxError(message, at);
  };

  const skipWhitespace = () => {
    while (pos < text.length) {
      const char = text.charCodeAt(pos);
      if (char === 0x0a) line++;
      else if (char !== 0x20 && char !== 0x09 && char !== 0x0d) return;
      pos++;
    }
  };

  const describe = (at: number) => (at >= text.length ? "end of input" : `'${text[at]}'`);

  const parseString = (): string => {
    const start = pos;
    pos++;
    while (pos < text.length) {
      const char = text.charCodeAt(pos);
      if (char === 0x22) {
        pos++;
        try {
          return JSON.parse(text.slice(start, pos)) as string;
        } catch {
          return fail("Invalid escape sequence in string", start);
        }
      }
      if (char === 0x5c) pos += 2;
      else if (char < 0x20) fail("Control character in string");
      else pos++;
    }
    return fail("Unterminated string", start);
  };

  const parseValue = (path: (string | number)[], depth: number): unknown => {
    if (depth > MAX_DEPTH) fail("Nesting is too deep");
    skipWhitespace();
    const char = text[pos];
    if (char === "{") {
      pos++;
      const object: Record<string, unknown> = {};
      skipWhitespace();
      if (text[pos] === "}") {
        pos++;
        return object;
      }
      for (;;) {
        skipWhitespace();
        if (text[pos] !== '"') fail(`Expected a quoted key, found ${describe(pos)}`);
        const keyLine = line;
        const key = parseString();
        path.push(key);
        lines.set(pathKey(path), keyLine);
        skipWhitespace();
        if (text[pos] !== ":") fail(`Expected ':' after key, found ${describe(pos)}`);
        pos++;
        // defineProperty keeps a "__proto__" key as data instead of a prototype change.
        Object.defineProperty(object, key, {
          value: parseValue(path, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        path.pop();
        skipWhitespace();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "}") {
          pos++;
          return object;
        }
        fail(`Expected ',' or '}', found ${describe(pos)}`);
      }
    }
    if (char === "[") {
      pos++;
      const array: unknown[] = [];
      skipWhitespace();
      if (text[pos] === "]") {
        pos++;
        return array;
      }
      for (;;) {
        path.push(array.length);
        array.push(parseValue(path, depth + 1));
        path.pop();
        skipWhitespace();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "]") {
          pos++;
          return array;
        }
        fail(`Expected ',' or ']', found ${describe(pos)}`);
      }
    }
    if (char === '"') return parseString();
    if (text.startsWith("true", pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith("false", pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith("null", pos)) {
      pos += 4;
      return null;
    }
    NUMBER_PATTERN.lastIndex = pos;
    const match = NUMBER_PATTERN.exec(text);
    if (match) {
      pos += match[0].length;
      return Number(match[0]);
    }
    return fail(`Unexpected ${describe(pos)}`);
  };

  try {
    const value = parseValue([], 0);
    skipWhitespace();
    if (pos < text.length) fail(`Unexpected ${describe(pos)} after the end of the document`);
    return { ok: true, value, keyLine: (path) => lines.get(pathKey(path)) };
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    const before = text.slice(0, error.position);
    const lineStart = before.lastIndexOf("\n") + 1;
    return {
      ok: false,
      message: error.message,
      line: before.split("\n").length,
      column: error.position - lineStart + 1,
    };
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
