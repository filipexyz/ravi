import { describe, expect, test } from "bun:test";

import { parseJsonWithLines } from "./json";

describe("parseJsonWithLines", () => {
  test("parses JSON and records the line of every key", () => {
    const text = '{\n  "a": {\n    "b": [1, {"c": true}],\n    "d": "x"\n  },\n  "e": null\n}';
    const result = parseJsonWithLines(text);
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toEqual(JSON.parse(text));
    expect(result.keyLine(["a"])).toBe(2);
    expect(result.keyLine(["a", "b"])).toBe(3);
    expect(result.keyLine(["a", "b", 1, "c"])).toBe(3);
    expect(result.keyLine(["a", "d"])).toBe(4);
    expect(result.keyLine(["e"])).toBe(6);
    expect(result.keyLine(["missing"])).toBeUndefined();
  });

  test("decodes escapes and numbers like JSON.parse", () => {
    const text = '{"s": "a\\n\\u00e7\\"\\\\", "n": [-0.5, 1e3, 0, 12.25E-1]}';
    const result = parseJsonWithLines(text);
    expect(result.ok && result.value).toEqual(JSON.parse(text));
  });

  test.each([
    ['{\n  "a": 1,\n}', 3, 1],
    ['{"a": 1 "b": 2}', 1, 9],
    ["[1, 2", 1, 6],
    ['{"a": tru}', 1, 7],
    ['{"a": "x\ny"}', 1, 9],
    ["{} {}", 1, 4],
    ["", 1, 1],
  ])("reports the position of a syntax error in %j", (text, line, column) => {
    const result = parseJsonWithLines(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect({ line: result.line, column: result.column }).toEqual({ line, column });
  });

  test("keeps __proto__ as a plain key", () => {
    const result = parseJsonWithLines('{"__proto__": {"polluted": true}}');
    if (!result.ok) throw new Error(result.message);
    const value = result.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("refuses deep nesting instead of overflowing the stack", () => {
    const result = parseJsonWithLines("[".repeat(10_000) + "]".repeat(10_000));
    expect(result.ok).toBe(false);
  });
});
