/**
 * Presence targets for a headless surface (no inbound source tracks an active chat).
 *
 * These methods sit on the gateway typing/presence path and must never throw.
 */

import type { ChannelPresenceTargets } from "./types.js";

/** Headless surface: no active targets, renew → false, clear → no-op (replaces the deprecated src/omni stub consumer). */
export function createNoopPresenceTargets(): ChannelPresenceTargets {
  return {
    getActiveTarget: () => undefined,
    renewActiveTarget: async () => false,
    clearActiveTarget: async () => {},
  };
}
