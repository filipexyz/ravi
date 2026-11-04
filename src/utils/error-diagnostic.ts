import { stripVTControlCharacters } from "node:util";

/** Diagnostic fields, never arbitrary request bodies, headers or exception properties. */
export interface ErrorDiagnosticContext {
  operation?: string;
  provider?: string;
  model?: string;
  file?: string;
  status?: number;
  code?: string;
  syscall?: string;
}

const CONTEXT_FIELDS = ["operation", "provider", "model", "file", "code", "syscall"] as const;
const SECRET_NAME =
  "(?:[A-Za-z0-9_-]*(?:password|passwd|secret|token|credential|api[-_]?key|access[-_]?key|context[-_]?key|private[-_]?key)[A-Za-z0-9_-]*|authorization|cookie|set-cookie)";
const SECRET_ASSIGNMENT = new RegExp(
  `(["']?${SECRET_NAME}["']?\\s*[:=]\\s*)(?:\\[redacted\\]|(?:Bearer|Basic)\\s+\\[redacted\\]|"[^"\\n]*"|'[^'\\n]*'|[^\\s,;}\\]&#]+)`,
  "gi",
);

/** Redaction changes secret values, never the surrounding failure or diagnostic path. */
export function redactDiagnosticText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, (match) => `${match.split(/\s/, 1)[0]} [redacted]`)
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(
      /\b(?:rctx_[A-Za-z0-9_-]+|(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{12,}|gh[oprsu]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[redacted]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[redacted]@");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function projectDiagnosticContext(value: unknown): ErrorDiagnosticContext {
  const source = record(value);
  const result: ErrorDiagnosticContext = {};
  if (!source) return result;
  for (const field of CONTEXT_FIELDS) {
    if (typeof source[field] === "string") result[field] = redactDiagnosticText(source[field]);
  }
  if (typeof source.status === "number" && Number.isFinite(source.status)) result.status = source.status;
  return result;
}

export function errorDiagnostic(
  error: unknown,
  context: ErrorDiagnosticContext = {},
): {
  cause: string;
  context: ErrorDiagnosticContext;
} {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const collected: ErrorDiagnosticContext = {};
  let current = error;
  while (current !== undefined && current !== null) {
    if (seen.has(current)) {
      messages.push("[circular cause]");
      break;
    }
    if (seen.size >= 16) {
      messages.push("[cause chain truncated]");
      break;
    }
    seen.add(current);
    const item = record(current);
    if (item) {
      const fields = projectDiagnosticContext(item);
      if (typeof item.path === "string") fields.file = redactDiagnosticText(item.path);
      // Outer operation metadata wins; inner errors fill missing provider/OS fields.
      Object.assign(collected, { ...fields, ...projectDiagnosticContext(item.context), ...collected });
      const text = typeof item.message === "string" ? item.message : undefined;
      if (text && messages.at(-1) !== text) messages.push(text);
      current = item.cause ?? item.error;
      if (!text && current === undefined) messages.push("Error object has no message or cause");
    } else {
      messages.push(String(current));
      break;
    }
  }
  return {
    cause: redactDiagnosticText(messages.join("\nCaused by: ") || "No error cause was supplied"),
    context: { ...collected, ...projectDiagnosticContext(context) },
  };
}
