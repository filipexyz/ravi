import { errorDiagnostic, type ErrorDiagnosticContext } from "./error-diagnostic.js";

/** Report a bounded cause without allowing a diagnostic sink to replace the operation's outcome. */
export function reportErrorDiagnostic(
  reporter: { warn(message: string, data?: unknown): void },
  message: string,
  error: unknown,
  context: ErrorDiagnosticContext,
): void {
  try {
    reporter.warn(message, errorDiagnostic(error, context));
    // no-cause: A failed diagnostic sink cannot replace the original operation's result or primary error.
  } catch {
    // The caller retains responsibility for the original operation and its result.
  }
}
