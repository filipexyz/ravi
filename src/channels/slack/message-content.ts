import type { SlackEventPayload } from "./types.js";

/** Read the message body, not a potentially abbreviated notification fallback. */
export function extractSlackMessageText(event: Pick<SlackEventPayload, "text" | "blocks">): string {
  const fallback = typeof event.text === "string" ? event.text : "";
  if (!Array.isArray(event.blocks) || event.blocks.length === 0) return fallback;

  const text: string[] = [];
  for (const block of event.blocks) {
    const parts = readBlockText(block);
    // A mixed/unknown layout may have essential text we cannot reconstruct.
    // Preserve Slack's fallback instead of silently returning only one part.
    if (parts === null) return fallback;
    text.push(...parts);
  }
  return text.filter((part) => part.trim()).join("\n\n") || fallback;
}

function readBlockText(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "markdown":
      return typeof value.text === "string" ? [value.text] : null;
    case "header": {
      const text = readTextObject(value.text);
      return text === null ? null : [text];
    }
    case "section": {
      if (value.accessory !== undefined) return null;
      const parts: string[] = [];
      if (value.text !== undefined) {
        const text = readTextObject(value.text);
        if (text === null) return null;
        parts.push(text);
      }
      if (value.fields !== undefined) {
        if (!Array.isArray(value.fields)) return null;
        for (const field of value.fields) {
          const text = readTextObject(field);
          if (text === null) return null;
          parts.push(text);
        }
      }
      return [parts.filter((part) => part.trim()).join("\n")];
    }
    case "divider":
      return [];
    default:
      return null;
  }
}

function readTextObject(value: unknown): string | null {
  return isRecord(value) && (value.type === "plain_text" || value.type === "mrkdwn") && typeof value.text === "string"
    ? value.text
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
