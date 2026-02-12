/**
 * Markdown → WhatsApp formatting converter
 *
 * Converts standard Markdown syntax to WhatsApp's native formatting:
 *   **bold**    → *bold*
 *   *italic*    → _italic_
 *   ~~strike~~  → ~strike~
 *   `code`      → `code`  (preserved as-is)
 *   ```block``` → ```block```  (unchanged)
 *   # Heading   → *HEADING*
 *   ## Heading  → *Heading*
 *   - item      → • item
 *   [text](url) → text (url)
 *   | tables |  → box-drawn monospace table
 */

// ─── Markdown table → WhatsApp box-drawn table ───────────────────────

/** Visual width of a string — accounts for emojis (2-wide) and CJK characters */
function visualWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    // Emojis, CJK unified ideographs, fullwidth forms
    if (
      code >= 0x1f000 ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xfe30 && code <= 0xfe4f)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** Pad string to exact visual width */
function padEndVisual(str: string, targetWidth: number): string {
  const diff = targetWidth - visualWidth(str);
  return diff > 0 ? str + " ".repeat(diff) : str;
}

/** Detect, parse, and convert a markdown table block to a WhatsApp box-drawn table */
function markdownTableToWhatsApp(text: string): string {
  // Regex: match contiguous lines that start and end with |
  // A table needs: header row, separator row (|---|), and 1+ data rows
  const tableRegex = /(?:^[ \t]*\|.+\|[ \t]*$\n?){3,}/gm;

  return text.replace(tableRegex, (block) => {
    const lines = block.trim().split("\n").map((l) => l.trim());

    // Validate: second line must be a separator row (| --- | --- |)
    if (!lines[1] || !/^\|[\s\-:|]+\|$/.test(lines[1])) {
      return block; // not a real table, leave as-is
    }

    // Parse rows into cells
    const parseRow = (line: string): string[] =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());

    const headers = parseRow(lines[0]);
    const dataRows = lines.slice(2).map(parseRow);
    const colCount = headers.length;

    // Normalize: ensure every row has the same number of columns
    const normalize = (row: string[]): string[] => {
      if (row.length >= colCount) return row.slice(0, colCount);
      return [...row, ...Array(colCount - row.length).fill("")];
    };

    const normalizedHeaders = normalize(headers);
    const normalizedRows = dataRows.map(normalize);

    // Calculate max visual width per column (min 3 for aesthetics)
    const colWidths = normalizedHeaders.map((h, i) => {
      const cellWidths = [
        visualWidth(h),
        ...normalizedRows.map((r) => visualWidth(r[i] || "")),
      ];
      return Math.max(3, ...cellWidths);
    });

    // Build clean text table (no box-drawing chars — just padded text)
    const gap = "   "; // 3-space gap between columns

    const formatRow = (cells: string[]) =>
      cells.map((cell, i) => padEndVisual(cell, colWidths[i])).join(gap);

    const headerLine = formatRow(normalizedHeaders);
    const separator = colWidths.map((w) => "-".repeat(w)).join(gap);
    const bodyLines = normalizedRows.map(formatRow);

    // Assemble inside a code block for monospace rendering
    const table = [
      "```",
      headerLine,
      separator,
      ...bodyLines,
      "```",
    ].join("\n");

    return table;
  });
}

// Placeholders to protect converted tokens from later regex passes
const PH_BOLD_OPEN = "\x01B\x02";
const PH_BOLD_CLOSE = "\x03B\x04";
const PH_CODE_OPEN = "\x01C\x02";
const PH_CODE_CLOSE = "\x03C\x04";

/**
 * Convert Markdown text to WhatsApp-formatted text.
 */
export function markdownToWhatsApp(text: string): string {
  // 0. Convert markdown tables → box-drawn monospace tables (before code block extraction)
  let result = markdownTableToWhatsApp(text);

  // 1. Protect code blocks — extract and replace with placeholder
  const codeBlocks: string[] = [];
  result = result.replace(/```\w*\n([\s\S]*?)```/g, (_, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(code);
    return `\x01CODEBLOCK_${idx}\x02`;
  });

  // 2. Protect inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+?)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\x01INLINE_${idx}\x02`;
  });

  // 3. Bold: **text** → *text* (with placeholders to protect from italic pass)
  result = result.replace(/\*\*(.+?)\*\*/g, `${PH_BOLD_OPEN}$1${PH_BOLD_CLOSE}`);

  // 4. Italic: *text* → _text_ (now safe — real bolds are placeholdered)
  result = result.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "_$1_");

  // 5. Restore bold placeholders → *text*
  result = result.replaceAll(PH_BOLD_OPEN, "*").replaceAll(PH_BOLD_CLOSE, "*");

  // 6. Headings: # → bold uppercase, ## → bold, ### → bold
  result = result
    .replace(/^### (.+)$/gm, "*$1*")
    .replace(/^## (.+)$/gm, "*$1*")
    .replace(/^# (.+)$/gm, (_, h) => `*${h.toUpperCase()}*`);

  // 7. Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // 8. Links: [text](url) → text (url)
  result = result.replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)");

  // 9. Unordered lists: - item or * item → • item
  result = result.replace(/^[\-\*] (.+)$/gm, "• $1");

  // 10. Horizontal rules: --- or *** → ———
  result = result.replace(/^(?:---+|\*\*\*+)$/gm, "———");

  // 11. Restore inline code → `code` (WhatsApp supports single backtick for monospace)
  result = result.replace(/\x01INLINE_(\d+)\x02/g, (_, idx) => {
    return "`" + inlineCodes[parseInt(idx)] + "`";
  });

  // 12. Restore code blocks → ```\ncode```
  result = result.replace(/\x01CODEBLOCK_(\d+)\x02/g, (_, idx) => {
    return "```\n" + codeBlocks[parseInt(idx)] + "```";
  });

  // 13. Clean up excessive blank lines (3+ → 2)
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
