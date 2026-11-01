/**
 * Diagnostics the Console's theme and widget compiler returns (check, preview,
 * scaffold, publish). This side only normalizes and prints them: what is an
 * error is the Console's decision.
 *
 * spec: skills/library
 */

import type { PresentationKind } from "./kinds.js";
import type { LibraryContrastReport } from "./types.js";

export interface LibraryDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
}

/** Errors the Console reported for a folder: the CLI prints them and exits 2. */
export class LibraryDiagnosticsError extends Error {
  constructor(
    readonly kind: PresentationKind,
    readonly diagnostics: LibraryDiagnostic[],
    message = `The ${kind} has ${countErrors(diagnostics)} error${countErrors(diagnostics) === 1 ? "" : "s"}.`,
  ) {
    super(message);
    this.name = "LibraryDiagnosticsError";
  }
}

/** A theme check with errors keeps the contrast report, so the failure can name the pairs. */
export class ThemeCheckFailed extends LibraryDiagnosticsError {
  constructor(
    diagnostics: LibraryDiagnostic[],
    readonly contrast: LibraryContrastReport | null,
  ) {
    super("theme", diagnostics);
    this.name = "ThemeCheckFailed";
  }
}

const MAX_DIAGNOSTICS = 200;
const MAX_MESSAGE_LENGTH = 500;

/** Only the contract's fields; anything but `"error"` counts as a warning. */
export function normalizeDiagnostics(value: unknown): LibraryDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_DIAGNOSTICS).flatMap((entry): LibraryDiagnostic[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const message = typeof record.message === "string" ? cleanText(record.message) : "";
    const code = typeof record.code === "string" && record.code.trim() ? cleanText(record.code).slice(0, 80) : "";
    if (!message && !code) return [];
    return [
      {
        severity: record.severity === "error" ? "error" : "warning",
        code: code || "DIAGNOSTIC",
        message: message.slice(0, MAX_MESSAGE_LENGTH),
        file: typeof record.file === "string" && record.file.trim() ? cleanText(record.file).slice(0, 255) : null,
        line: positiveInteger(record.line),
        column: positiveInteger(record.column),
      },
    ];
  });
}

export function countErrors(diagnostics: readonly LibraryDiagnostic[]): number {
  return diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
}

export function hasDiagnosticErrors(diagnostics: readonly LibraryDiagnostic[]): boolean {
  return countErrors(diagnostics) > 0;
}

/** `file:line:column severity code message`; parts the Console did not send are left out. */
export function diagnosticLine(diagnostic: LibraryDiagnostic): string {
  const where =
    (diagnostic.file ?? "-") +
    (diagnostic.line !== null ? `:${diagnostic.line}` : "") +
    (diagnostic.line !== null && diagnostic.column !== null ? `:${diagnostic.column}` : "");
  return `${where} ${diagnostic.severity} ${diagnostic.code} ${diagnostic.message}`.trimEnd();
}

/**
 * A diagnostic as a contract issue (`path`, `code`, `message`). The envelope
 * redacts free-text `message` keys except in issues, so plans and errors
 * carry diagnostics in this shape.
 */
export interface LibraryDiagnosticIssue {
  path: Array<string | number>;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export function diagnosticIssue(diagnostic: LibraryDiagnostic): LibraryDiagnosticIssue {
  const path: Array<string | number> = [];
  if (diagnostic.file) path.push(diagnostic.file);
  if (diagnostic.line !== null) path.push(diagnostic.line);
  if (diagnostic.line !== null && diagnostic.column !== null) path.push(diagnostic.column);
  return { path, code: diagnostic.code, message: diagnostic.message, severity: diagnostic.severity };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
}
