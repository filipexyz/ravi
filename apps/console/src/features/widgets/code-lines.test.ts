import { describe, expect, test } from "bun:test";

import { lineCount, lineRange } from "./code-lines";

describe("lineCount", () => {
  test("counts lines, with an empty text as one line", () => {
    expect(lineCount("")).toBe(1);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\nb\n")).toBe(3);
  });
});

describe("lineRange", () => {
  const text = "first\nsecond line\n\nlast";

  test("finds the start and end of a line without its newline", () => {
    expect(lineRange(text, 1)).toEqual({ line: 1, start: 0, end: 5, caret: 0 });
    expect(lineRange(text, 2)).toEqual({ line: 2, start: 6, end: 17, caret: 6 });
    expect(lineRange(text, 3)).toEqual({ line: 3, start: 18, end: 18, caret: 18 });
    expect(lineRange(text, 4)).toEqual({ line: 4, start: 19, end: 23, caret: 19 });
  });

  test("puts the caret at the column, never past the line", () => {
    expect(lineRange(text, 2, 8).caret).toBe(13);
    expect(lineRange(text, 2, 99).caret).toBe(17);
    expect(lineRange(text, 2, 1).caret).toBe(6);
  });

  test("clamps lines outside the text", () => {
    expect(lineRange(text, 0).line).toBe(1);
    expect(lineRange(text, -3).start).toBe(0);
    expect(lineRange(text, 40)).toEqual({ line: 4, start: 19, end: 23, caret: 19 });
    expect(lineRange("", 5)).toEqual({ line: 1, start: 0, end: 0, caret: 0 });
  });
});
