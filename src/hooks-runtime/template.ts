import type { NormalizedHookEvent } from "./types.js";

const MAX_VALUE_LENGTH = 500;

function resolvePath(root: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function toDisplayString(value: unknown): string {
  if (value === undefined || value === null) return "";
  const display = typeof value === "string" ? value : JSON.stringify(value);
  if (display.length <= MAX_VALUE_LENGTH) return display;
  return `${display.slice(0, MAX_VALUE_LENGTH)}...`;
}

export function resolveHookTemplate(template: string, event: NormalizedHookEvent): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, rawKey: string) => {
    const key = rawKey.trim();
    if (!key) return match;
    const value = resolvePath(event, key);
    if (value === undefined) return match;
    return toDisplayString(value);
  });
}
