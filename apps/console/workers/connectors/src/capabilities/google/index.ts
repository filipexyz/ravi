import type { GoogleCapabilityHandler } from "../../adapters/google";

import { buildGoogleCalendarHandlers } from "./calendar";
import { buildGmailHandlers } from "./gmail";

export function buildGoogleHandlers(fetchImpl: typeof fetch = fetch): Map<string, GoogleCapabilityHandler> {
  return new Map<string, GoogleCapabilityHandler>([
    ...buildGmailHandlers(fetchImpl),
    ...buildGoogleCalendarHandlers(fetchImpl),
  ]);
}
