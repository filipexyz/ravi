// Diagnostics as the theme and widget editors show them: errors first, each
// with where it is (`widget.html:12:5`), and the server's own list when a
// save is refused (`400 PAYLOAD_INVALID` with `details.diagnostics`).

import type { Diagnostic } from "@/shared/widgets/types";

const FILE_ORDER = ["widget.html", "widget.json", "example.json", "theme.json", "fields.json", "logo.svg", "README.md"];

/** `file:line:column`, as far as the diagnostic says; empty when it names no file. */
export function diagnosticWhere(diagnostic: Diagnostic) {
  if (!diagnostic.file) return "";
  if (!diagnostic.line) return diagnostic.file;
  return diagnostic.column ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}` : `${diagnostic.file}:${diagnostic.line}`;
}

/** Errors before warnings, then by file, line and column. Stable for equal positions. */
export function sortDiagnosticsForDisplay(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const fileRank = (file: string | undefined) => {
    if (!file) return FILE_ORDER.length + 1;
    const index = FILE_ORDER.indexOf(file);
    return index === -1 ? FILE_ORDER.length : index;
  };
  return diagnostics
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort(
      (a, b) =>
        Number(a.diagnostic.severity !== "error") - Number(b.diagnostic.severity !== "error") ||
        fileRank(a.diagnostic.file) - fileRank(b.diagnostic.file) ||
        (a.diagnostic.line ?? 0) - (b.diagnostic.line ?? 0) ||
        (a.diagnostic.column ?? 0) - (b.diagnostic.column ?? 0) ||
        a.index - b.index,
    )
    .map((entry) => entry.diagnostic);
}

export function countDiagnostics(diagnostics: readonly Diagnostic[]) {
  let errors = 0;
  for (const diagnostic of diagnostics) if (diagnostic.severity === "error") errors++;
  return { errors, warnings: diagnostics.length - errors };
}

/** "2 erros e 1 aviso", "1 erro", "Nenhum problema". */
export function diagnosticsSummary(diagnostics: readonly Diagnostic[]) {
  const { errors, warnings } = countDiagnostics(diagnostics);
  const parts = [
    errors ? `${errors} ${errors === 1 ? "erro" : "erros"}` : null,
    warnings ? `${warnings} ${warnings === 1 ? "aviso" : "avisos"}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" e ") : "Nenhum problema";
}

/** Lines of `file` with a diagnostic, marked `error` when any on that line is one. */
export function diagnosticLines(diagnostics: readonly Diagnostic[], file: string) {
  const lines = new Map<number, "error" | "warning">();
  for (const diagnostic of diagnostics) {
    if (diagnostic.file !== file || !diagnostic.line) continue;
    if (lines.get(diagnostic.line) !== "error") lines.set(diagnostic.line, diagnostic.severity);
  }
  return lines;
}

/** The diagnostics a refused save carries (`details.diagnostics` of the error body), or null. */
export function diagnosticsFromError(error: unknown): Diagnostic[] | null {
  const body = (error as { extra?: { body?: unknown } } | null)?.extra?.body;
  const list = (body as { details?: { diagnostics?: unknown } } | null)?.details?.diagnostics;
  if (!Array.isArray(list)) return null;
  const diagnostics = list.filter(isDiagnostic);
  return diagnostics.length ? diagnostics : null;
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.severity === "error" || entry.severity === "warning") &&
    typeof entry.code === "string" &&
    typeof entry.message === "string" &&
    (entry.file === undefined || typeof entry.file === "string") &&
    (entry.line === undefined || typeof entry.line === "number") &&
    (entry.column === undefined || typeof entry.column === "number")
  );
}
