import { createHash } from "node:crypto";
import { sanitizePublicValue } from "../../cli/redaction.js";
import { logger } from "../../utils/logger.js";
import { gatewayRequestContext } from "./request-context.js";

const log = logger.child("gateway:dispatcher");
const WINDOW_MS = 60_000;
const MAX_KEYS = 256;
const occurrences = new Map<string, { at: number; requestId: string; suppressed: number }>();

/** No request body, headers, argv, provider payload or arbitrary exception properties. */
function diagnosticText(text: string): string {
  const redacted = text
    .replace(/\b(?:https?|postgres(?:ql)?|mysql):\/\/[^\s"')]+/gi, "[REDACTED:url]")
    .replace(
      /(["']?(?:[A-Za-z0-9_-]*(?:password|secret|token|credential|api[-_]?key|access[-_]?key)[A-Za-z0-9_-]*|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bctx_[A-Za-z0-9_-]+/g, "[REDACTED:context]")
    .replace(/[\u0000-\u001f\u007f]/g, " ");
  return String(sanitizePublicValue(redacted)).slice(0, 2000);
}

function diagnostic(error: unknown, seen = new Set<unknown>()): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: "Non-Error exception", errorName: typeof error };
  if (seen.has(error) || seen.size >= 4) return { error: "Cause chain truncated" };
  seen.add(error);
  return {
    error: diagnosticText(error.message),
    errorName: diagnosticText(error.name),
    stack: error.stack
      ?.split("\n")
      .filter((line) => /^\s+at\s/.test(line))
      .slice(0, 8)
      .map(diagnosticText),
    ...(error.cause !== undefined ? { cause: diagnostic(error.cause, seen) } : {}),
  };
}

/** First occurrence gets the stack and cause; repetitions point to it at debug level. */
export function logGatewayFailure(error: unknown, code: string, now = Date.now()): void {
  const context = gatewayRequestContext();
  const { requestId, op } = context;
  const details = diagnostic(error);
  const key = createHash("sha256")
    .update(JSON.stringify([op, code, details]))
    .digest("hex");
  const previous = occurrences.get(key);
  if (previous && now - previous.at < WINDOW_MS) {
    previous.suppressed++;
    context.diagnosticRequestId = previous.requestId;
    log.debug("Repeated gateway failure", { command: op, code, requestId, firstRequestId: previous.requestId });
    return;
  }
  if (!previous && occurrences.size >= MAX_KEYS) occurrences.delete(occurrences.keys().next().value!);
  occurrences.set(key, { at: now, requestId, suppressed: 0 });
  log.error("Gateway command exception", {
    command: op,
    code,
    requestId,
    suppressed: previous?.suppressed ?? 0,
    ...details,
    // Keep the cause readable in terminal logs as well as JSON file logs.
    ...(details.cause ? { failureDetails: details.cause } : {}),
  });
}
