/**
 * Text an agent passes to the Slack thread commands (`ravi sessions
 * create-thread`, `report`, `thread-send`, `close-thread --return`).
 *
 * Agents write these as one shell argument, and a `\n` typed inside double
 * quotes reaches Ravi as a backslash and an `n`: the brief then shows `\n\n`
 * in the thread card and its first reply instead of line breaks. Text with no
 * real line break that carries such sequences gets them decoded. Text that
 * already has real line breaks is left alone, so a literal `\n` inside it (a
 * code sample, a regex) survives; so does an escaped `\\n`.
 */

const LITERAL_LINE_BREAK = /(?<!\\)\\r\\n|(?<!\\)\\n/;
const LITERAL_LINE_BREAKS = /(?<!\\)\\r\\n|(?<!\\)\\n/g;

export function decodeLiteralLineBreaks(text: string): string {
  if (/[\r\n]/.test(text) || !LITERAL_LINE_BREAK.test(text)) return text;
  return text.replace(LITERAL_LINE_BREAKS, "\n");
}
