/**
 * Trigger Message Template Engine
 *
 * Resolves {{variable}} placeholders in trigger messages using event data.
 *
 * Available variables:
 *   {{topic}}                    — NATS topic that fired the trigger
 *   {{data.<path>}}              — dot-notation path into event data
 *   {{data.cwd}}                 — e.g. /Users/luis/ravi/copilot
 *   {{data.last_assistant_message}} — last CC message (truncated to 300 chars)
 *   {{data.prompt}}              — user prompt (for UserPromptSubmit events)
 *
 * Unresolved variables are left as-is (no crash).
 * String values longer than 300 chars are truncated with "...".
 */

const MAX_VALUE_LENGTH = 300;

/**
 * Resolve a dot-notation path into an object.
 * e.g. "data.cwd" with root { cwd: "/tmp" } -> "/tmp"
 */
function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Coerce a value to a display string, truncating if needed.
 */
function toDisplayString(value: unknown): string {
  if (value === undefined || value === null) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length > MAX_VALUE_LENGTH) {
    return str.slice(0, MAX_VALUE_LENGTH) + "...";
  }
  return str;
}

/**
 * Resolve template variables in a trigger message.
 *
 * Context shape:
 *   { topic: string, data: unknown }
 *
 * Variables: {{topic}}, {{data.<path>}}
 * Unresolved variables are left unchanged.
 */
export function resolveTemplate(message: string, context: { topic: string; data: unknown }): string {
  return message.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
    const trimmed = key.trim();

    if (trimmed === "topic") {
      return context.topic;
    }

    if (trimmed.startsWith("data.")) {
      const path = trimmed.slice(5); // strip "data."
      const value = resolvePath(context.data, path);
      if (value === undefined) return match; // leave unresolved
      return toDisplayString(value);
    }

    return match; // unknown variable, leave as-is
  });
}
