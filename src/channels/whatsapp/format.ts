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

/**
 * Convert Markdown text to WhatsApp-formatted text.
 */
export function markdownToWhatsApp(text: string): string {
  return (
    text
      // Code blocks first (preserve content inside)
      // ```lang\ncode\n``` → ```code```
      .replace(/```\w*\n([\s\S]*?)```/g, "```$1```")

      // Headings: # → bold uppercase, ## → bold, ### → bold
      .replace(/^### (.+)$/gm, "*$1*")
      .replace(/^## (.+)$/gm, "*$1*")
      .replace(/^# (.+)$/gm, (_, h) => `*${h.toUpperCase()}*`)

      // Bold: **text** → *text*
      .replace(/\*\*(.+?)\*\*/g, "*$1*")

      // Italic: _text_ stays _text_ (already WhatsApp compatible)
      // But markdown *text* (single asterisk italic) needs to become _text_
      // Only match single * that aren't part of ** (already handled above)
      .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "_$1_")

      // Strikethrough: ~~text~~ → ~text~
      .replace(/~~(.+?)~~/g, "~$1~")

      // Inline code: `text` → ```text``` (but not already triple-backtick)
      .replace(/(?<!`)(`[^`]+?`)(?!`)/g, (_, code) => `\`\`${code}\`\``)

      // Links: [text](url) → text (url)
      .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")

      // Unordered lists: - item or * item → • item
      .replace(/^[\-\*] (.+)$/gm, "• $1")

      // Horizontal rules: --- or *** → ———
      .replace(/^(?:---+|\*\*\*+)$/gm, "———")

      // Clean up excessive blank lines (3+ → 2)
      .replace(/\n{3,}/g, "\n\n")
  );
}
