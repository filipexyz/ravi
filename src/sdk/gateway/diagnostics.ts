import { createHash } from "node:crypto";
import { errorDiagnostic } from "../../utils/error-diagnostic.js";
import { logger } from "../../utils/logger.js";
import { gatewayRequestContext } from "./request-context.js";

const log = logger.child("gateway:dispatcher");
const WINDOW_MS = 60_000;
const MAX_KEYS = 256;
const occurrences = new Map<string, { at: number; requestId: string; suppressed: number }>();

/** First occurrence gets the normalized cause; repeat responses point to its request ID. */
export function logGatewayFailure(error: unknown, code: string, now = Date.now()): void {
  const context = gatewayRequestContext();
  const { requestId, op } = context;
  const details = errorDiagnostic(error, { operation: op });
  const key = createHash("sha256")
    .update(JSON.stringify([op, code, details]))
    .digest("hex");
  const previous = occurrences.get(key);
  if (previous && now - previous.at < WINDOW_MS) {
    previous.suppressed++;
    context.diagnosticRequestId = previous.requestId;
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
