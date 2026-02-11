/**
 * Markdown → WhatsApp formatting converter
 *
 * Converts standard Markdown syntax to WhatsApp's native formatting:
 *   **bold**    → *bold*
 *   *italic*    → _italic_
 *   ~~strike~~  → ~strike~
 *   `code`      → ```code```
 *   ```block``` → ```block```  (unchanged)
 *   # Heading   → *HEADING*
 *   ## Heading  → *Heading*
 *   - item      → • item
 *   [text](url) → text (url)
 */

// Placeholders to protect converted tokens from later regex passes
const PH_BOLD_OPEN = "\x01B\x02";
const PH_BOLD_CLOSE = "\x03B\x04";
const PH_CODE_OPEN = "\x01C\x02";
const PH_CODE_CLOSE = "\x03C\x04";

/**
 * Convert Markdown text to WhatsApp-formatted text.
 */
export function markdownToWhatsApp(text: string): string {
  let result = text;

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

  // 11. Restore inline code → ```code```
  result = result.replace(/\x01INLINE_(\d+)\x02/g, (_, idx) => {
    return "```" + inlineCodes[parseInt(idx)] + "```";
  });

  // 12. Restore code blocks → ```code```
  result = result.replace(/\x01CODEBLOCK_(\d+)\x02/g, (_, idx) => {
    return "```" + codeBlocks[parseInt(idx)] + "```";
  });

  // 13. Clean up excessive blank lines (3+ → 2)
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
