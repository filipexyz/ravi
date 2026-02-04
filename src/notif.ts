/**
 * Notif Singleton
 *
 * Shared instance for all components. Prevents multiple WebSocket connections.
 * Pattern from: https://notif.sh/docs#singleton-pattern
 */

import { Notif } from "notif.sh";
import { logger } from "./utils/logger.js";

const log = logger.child("notif");

const globalForNotif = globalThis as unknown as { notif: Notif };

const baseNotif = globalForNotif.notif || new Notif();

// Wrap emit to trace .response emissions (helps debug ghost responses)
const originalEmit = baseNotif.emit.bind(baseNotif);
baseNotif.emit = async (topic: string, data: Record<string, unknown>) => {
  if (topic.includes(".response")) {
    const hasEmitId = "_emitId" in data;
    const keys = Object.keys(data);

    log.debug("RESPONSE_EMIT", {
      topic,
      hasEmitId,
      emitId: data._emitId ?? "NONE",
      keys,
    });

    // If NO _emitId, this is a ghost - log as warning
    if (!hasEmitId) {
      const stack = new Error().stack?.split("\n").slice(2, 8).join("\n") || "no stack";
      log.warn("GHOST_EMIT_DETECTED", {
        topic,
        keys,
        fullData: JSON.stringify(data).slice(0, 500),
        stack,
      });
    }
  }

  return originalEmit(topic, data);
};

export const notif = baseNotif;

if (process.env.NODE_ENV !== "production") {
  globalForNotif.notif = baseNotif;
}
