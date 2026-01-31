/**
 * Notif Singleton
 *
 * Shared instance for all components. Prevents multiple WebSocket connections.
 * Lazy initialization - only created when first accessed.
 */

import { Notif } from "notif.sh";

const globalForNotif = globalThis as unknown as { _notif?: Notif };

/**
 * Get the shared Notif instance (lazy initialization)
 */
export function getNotif(): Notif {
  if (!globalForNotif._notif) {
    globalForNotif._notif = new Notif();
  }
  return globalForNotif._notif;
}

/**
 * @deprecated Use getNotif() for lazy initialization
 */
export const notif = new Proxy({} as Notif, {
  get(_, prop) {
    return (getNotif() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
