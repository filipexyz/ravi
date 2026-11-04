/** Single versioned redactor used by diagnostic egress, including the standalone TS SDK. */
export const DIAGNOSTIC_REDACTOR_VERSION = 1;
export interface DiagnosticRedactionOptions {
  secrets?: readonly string[];
}
const MAX_INPUT = 8192;
const MAX_OUTPUT = 4096;
const TRUNCATION_MARKER = " [truncated]";
const MAX_SEGMENT = 2048;
const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.:/ -]{0,159}$/;
const MARKER = /^\[redacted(?::[a-z0-9_.-]+)?\]$/i;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Diagnostics must not fail while reading a hostile or partially available throwable. */
export function safeDiagnosticField(value: unknown, field: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function boundedText(value: string): string {
  // Never truncate halfway through an opaque field or credential. Discard that
  // entire line, retaining earlier diagnostic lines and an explicit marker.
  let text = value;
  if (text.length > MAX_INPUT) {
    const boundary = text.lastIndexOf("\n", MAX_INPUT);
    text = `${boundary >= 0 ? text.slice(0, boundary) : ""}\n[redacted:oversize]`;
  }
  return text
    .split("\n")
    .map((line) => (line.length > MAX_SEGMENT ? "[redacted:oversize]" : line))
    .join("\n");
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value.includes("://")) return undefined;
  if (/\b(?:rctx_|sk-|gsk_|gh[pousr]_|github_pat_|xox[baprs]-)/i.test(value)) return undefined;
  return value;
}

/** Extract only declared provider reason/code fields, never stringify a payload. */
export function projectProviderDiagnosticText(
  value: unknown,
  options: DiagnosticRedactionOptions,
  depth: number,
): string {
  const body = record(value);
  if (!body || depth >= 4) return "[redacted:provider.body]";
  const code = safeIdentifier(safeDiagnosticField(body, "code"));
  const message = safeDiagnosticField(body, "message");
  const reason = typeof message === "string" ? normalizeText(message, options, depth + 1) : undefined;
  return [code, reason, reason?.includes("[redacted:provider.body]") ? undefined : "[redacted:provider.body]"]
    .filter(Boolean)
    .join(": ");
}

function normalizeContainers(text: string, options: DiagnosticRedactionOptions, depth: number): string {
  let output = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    if (
      text.slice(i, i + 9).toLowerCase() === "[redacted" ||
      // Commander emits this exact, data-free token in CLI usage text.
      text.startsWith("[options]", i) ||
      text.startsWith("[circular cause]", i) ||
      text.startsWith("[cause chain truncated]", i) ||
      text.startsWith(TRUNCATION_MARKER.trimStart(), i)
    ) {
      const end = text.indexOf("]", i);
      if (end >= 0) {
        i = end;
        continue;
      }
    }
    const opening = i;
    let nesting = 0;
    let quoted = false;
    let escaped = false;
    let end = text.length;
    for (; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") nesting++;
      else if (char === "}" || char === "]") {
        nesting--;
        if (nesting === 0) {
          end = i + 1;
          break;
        }
      }
    }
    output += text.slice(start, opening);
    try {
      output += projectProviderDiagnosticText(JSON.parse(text.slice(opening, end)), options, depth);
    } catch {
      output += "[redacted:opaque]";
    }
    start = end;
    i = end - 1;
  }
  return output + text.slice(start);
}

function normalizeAssignments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const labels = /\b([A-Za-z_][A-Za-z0-9_.-]{0,63})\s*([:=])\s*/g;
      for (const match of line.matchAll(labels)) {
        const key = match[1]!;
        const lower = key.toLowerCase();
        const compact = lower.replace(/[-_.]/g, "");
        const sensitive =
          /(?:password|passwd|secret|token|credential|apikey|accesskey|contextkey|privatekey)/.test(compact) ||
          ["authorization", "cookie", "setcookie"].includes(compact);
        if (!sensitive) continue;
        const valueStart = match.index! + match[0].length;
        const tail = line.slice(valueStart);
        if (MARKER.test(tail.trim())) continue;
        const marker = compact.endsWith("cookie") ? "cookie" : lower;
        // An unquoted credential/header is one opaque segment. '#' and ';' may
        // be part of its value, so a token-only regex would leak its tail.
        return `${line.slice(0, valueStart)}[redacted:${marker}]`;
      }
      return line;
    })
    .join("\n");
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    result -= p * Math.log2(p);
  }
  return result;
}

function normalizeText(value: string, options: DiagnosticRedactionOptions, depth = 0): string {
  let text = boundedText(value);
  for (const secret of (options.secrets ?? [])
    .filter((s) => s.length >= 4)
    .slice(0, 32)
    .sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[redacted:credential]");
  }
  text = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  text = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[redacted:private-key]",
  );
  text = text.replace(/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"']+/gi, (raw) => {
    const query = raw.indexOf("?");
    const fragment = raw.indexOf("#");
    const boundary = Math.min(query < 0 ? raw.length : query, fragment < 0 ? raw.length : fragment);
    const base = raw.slice(0, boundary).replace(/(:\/\/)[^/@]+@/, "$1[redacted:userinfo]@");
    return base + (query >= 0 ? "?[redacted:url-query]" : "") + (fragment >= 0 ? "#[redacted:url-fragment]" : "");
  });
  text = text.replace(
    /(^|[\s(])((?:\/|\.\/)[^\s?"'<>]*)\?([^\s"'<>]+)/g,
    (_match, prefix: string, path: string, query: string) =>
      `${prefix}${path}?[redacted:url-query]${query.includes("#") ? "#[redacted:url-fragment]" : ""}`,
  );
  text = text.replace(/\?(?:key|token|sig|secret|password)=[^\s"'<>]+/gi, "?[redacted:url-query]");
  text = normalizeContainers(text, options, depth);
  // Credential values echoed without an assignment still have a field label.
  text = text.replace(
    /\b((?:invalid |incorrect |provided )?(?:api key|access key|access token|refresh token|password))\s*:\s*[^\n]+/gi,
    (_match, label: string) => `${label}: [redacted:credential]`,
  );
  text = text.replace(
    /\b(?:Bearer|Basic)\s+(?!\[redacted)[^\n]+/gi,
    (match) => `${match.split(/\s/, 1)[0]} [redacted:authorization]`,
  );
  text = normalizeAssignments(text);
  text = text
    .replace(
      /\b(?:rctx_[A-Za-z0-9_-]+|(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{12,}|gh[oprsu]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[redacted:credential]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted:credential]")
    .replace(/\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted:email]");
  const encoded = (candidate: string) =>
    /[a-z]/.test(candidate) && /[A-Z0-9+_=-]/.test(candidate) && entropy(candidate) >= 4
      ? "[redacted:encoded-credential]"
      : candidate;
  // Inspect path segments separately: a filesystem path is not one base64 token.
  text = text.replace(/\b[A-Za-z0-9+_=-]{48,}\b/g, encoded);
  text = text.replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, (candidate, offset: number, whole: string) =>
    whole[offset - 1] === "/" || (candidate.includes("/") && candidate.includes("-")) ? candidate : encoded(candidate),
  );
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
    : text;
}

/** Bounded normalization for already textual diagnostics; structured errors use errorDiagnostic. */
export function redactDiagnosticText(value: string, options: DiagnosticRedactionOptions = {}): string {
  return normalizeText(value, options);
}
