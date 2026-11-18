/**
 * What a caller may learn from a Ravi App CLI that exited non-zero.
 *
 * Spec: `apps/router` ("Failed app output"). The router never forwards the
 * child's stdout or stderr. It keeps a projection of them: the app's own error
 * (a JSON object on stdout, the shape `ravi` and the first-party apps print with
 * `--json`) when there is one, otherwise the head of stderr. Every string goes
 * through the shared diagnostic redactor and a hard bound, and nothing else the
 * app printed crosses: a stdout that is not an error object is data, not a
 * diagnostic, and is dropped.
 *
 * The JSON error cannot go through the redactor as text: the redactor collapses
 * any `{...}` in free text into a provider-body marker. It is read field by
 * field instead, and each field is redacted on its own.
 */
import { redactDiagnosticText } from "../utils/error-diagnostic.js";
import type { RaviAppCliFailure } from "./types.js";

/** The shared redactor's own truncation marker, so a second redaction pass leaves it alone. */
const TRUNCATION_MARKER = " [truncated]";

/** The explanation kept as the diagnostic `cause`. */
export const APP_FAILURE_CAUSE_MAX_CHARS = 2_000;
/** The one-line headline appended to the public message. The remote relay accepts up to 1200. */
export const APP_FAILURE_MESSAGE_MAX_CHARS = 300;
/** The app's own next step. The remote relay accepts up to 600. */
export const APP_FAILURE_ACTION_MAX_CHARS = 300;
const APP_FAILURE_CODE_MAX_CHARS = 96;
/** Larger than this, the stdout is a payload, not an error object. */
const APP_FAILURE_JSON_MAX_CHARS = 64 * 1024;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export interface AppCliRun {
  /** The child's exit status; null when a signal ended it. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface AppFailureOptions {
  /** Exact values to mask on top of the pattern redaction, such as the child context key. */
  secrets?: readonly string[];
}

type Redaction = { secrets: readonly string[] };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** An error code is public only when redaction would not change a single character of it. */
function identifier(value: unknown, redaction: Redaction): string | undefined {
  if (typeof value !== "string" || value.length > APP_FAILURE_CODE_MAX_CHARS || !CODE_PATTERN.test(value)) {
    return undefined;
  }
  return redactDiagnosticText(value, redaction) === value ? value : undefined;
}

function redacted(value: unknown, redaction: Redaction): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = redactDiagnosticText(value, redaction).trim();
  return text || undefined;
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - TRUNCATION_MARKER.length;
  const newline = text.lastIndexOf("\n", end);
  if (newline > 0) end = newline;
  let kept = text.slice(0, end).trimEnd();
  // Never end on half of a surrogate pair.
  if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}${TRUNCATION_MARKER}`;
}

/** One line with the whitespace collapsed, so the remote relay (which refuses control characters) keeps it. */
function oneLine(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  return line ? clamp(line, max) : undefined;
}

/**
 * The error object a CLI printed on stdout, or undefined when stdout is not one.
 * Accepted shapes: `{error: {code, message, ...}}` (Ravi's contract envelope and
 * the first-party apps), `{error: "text", code?}`, and a top-level
 * `{ok: false | success: false, code, message}`.
 */
function jsonErrorInfo(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed.length > APP_FAILURE_JSON_MAX_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const root = record(parsed);
  if (!root) return undefined;
  const nested = record(root.error);
  if (nested) return nested;
  if (typeof root.error === "string") {
    return {
      code: root.code ?? root.errorCode,
      reason: root.reason,
      message: root.error,
      retryable: root.retryable,
      suggestedAction: root.suggestedAction,
    };
  }
  if (root.ok === false || root.success === false) return root;
  return undefined;
}

function projectJsonFailure(
  exitCode: number | null,
  info: Record<string, unknown>,
  redaction: Redaction,
): RaviAppCliFailure | undefined {
  const code = identifier(info.code, redaction);
  const reason = identifier(info.reason, redaction);
  const message = redacted(info.message, redaction);
  // Without a code and a message there is nothing to say; stderr may still have it.
  if (!code && !message) return undefined;
  const innerCause = redacted(info.cause, redaction);
  const head = [code, reason ? `(${reason})` : undefined].filter(Boolean).join(" ");
  const line = head && message ? `${head}: ${message}` : (head || message)!;
  const cause = clamp(
    innerCause && innerCause !== message ? `${line}\nCaused by: ${innerCause}` : line,
    APP_FAILURE_CAUSE_MAX_CHARS,
  );
  const headline = oneLine(message ?? head, APP_FAILURE_MESSAGE_MAX_CHARS);
  const suggestedAction = oneLine(redacted(info.suggestedAction, redaction), APP_FAILURE_ACTION_MAX_CHARS);
  return {
    exitCode,
    source: "json",
    ...(code ? { code } : {}),
    ...(headline ? { message: headline } : {}),
    cause,
    ...(typeof info.retryable === "boolean" ? { retryable: info.retryable } : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
  };
}

export function projectAppCliFailure(run: AppCliRun, options: AppFailureOptions = {}): RaviAppCliFailure {
  const redaction: Redaction = { secrets: options.secrets ?? [] };
  const info = jsonErrorInfo(run.stdout);
  const fromJson = info ? projectJsonFailure(run.exitCode, info, redaction) : undefined;
  if (fromJson) return fromJson;

  const text = redacted(run.stderr, redaction);
  if (text) {
    const firstLine = text.split("\n").find((line) => line.trim()) ?? text;
    const headline = oneLine(firstLine, APP_FAILURE_MESSAGE_MAX_CHARS);
    return {
      exitCode: run.exitCode,
      source: "stderr",
      ...(headline ? { message: headline } : {}),
      cause: clamp(text, APP_FAILURE_CAUSE_MAX_CHARS),
    };
  }

  return {
    exitCode: run.exitCode,
    source: "none",
    cause:
      run.exitCode === null
        ? "The app CLI was terminated by a signal."
        : `The app CLI exited with code ${run.exitCode}.`,
  };
}
