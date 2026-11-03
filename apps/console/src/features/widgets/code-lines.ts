// Line arithmetic for the code editors: the gutter's line count and where a
// diagnostic's line and column fall in the text, so a click can put the
// caret there.

export function lineCount(text: string) {
  let count = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
  return count;
}

/**
 * Offsets of a 1-based `line` in `text` (clamped to the lines that exist):
 * `start` and `end` of the line without its newline, and `caret` at the
 * 1-based `column` (clamped to the line; the start when absent).
 */
export function lineRange(text: string, line: number, column?: number) {
  const total = lineCount(text);
  const target = Math.min(Math.max(1, Math.trunc(line) || 1), total);
  let start = 0;
  for (let current = 1; current < target; current++) start = text.indexOf("\n", start) + 1;
  const newline = text.indexOf("\n", start);
  const end = newline === -1 ? text.length : newline;
  const offset = column && column > 1 ? Math.trunc(column) - 1 : 0;
  return { line: target, start, end, caret: Math.min(start + offset, end) };
}
