/**
 * Notif Singleton
 *
 * Shared instance for all components. Prevents multiple WebSocket connections.
 * Pattern from: https://notif.sh/docs#singleton-pattern
 */

import { Notif } from "notif.sh";

const globalForNotif = globalThis as unknown as { notif: Notif };

export const notif = globalForNotif.notif || new Notif();

if (process.env.NODE_ENV !== "production") {
  globalForNotif.notif = notif;
}
