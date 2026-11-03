import { setTimeout as delay } from "node:timers/promises";
import { readFleetIdentity } from "./identity.js";
import { runFleetConnection } from "./client.js";
import { executeFleetOperation } from "./executor.js";

let controller: AbortController | undefined;
let task: Promise<void> | undefined;
/** Optional daemon service: a new association is noticed without a daemon restart. */
export function startFleetRunner() {
  if (task) return;
  controller = new AbortController();
  const signal = controller.signal;
  task = (async () => {
    while (!signal.aborted) {
      try {
        if (await readFleetIdentity()) await runFleetConnection({ signal, execute: executeFleetOperation });
      } catch {
        /* Local state may be replaced atomically by the installer; retry without exposing keys. */
      }
      await delay(5000, undefined, { signal }).catch(() => {});
    }
  })();
}
export async function stopFleetRunner() {
  controller?.abort();
  await task;
  task = undefined;
  controller = undefined;
}
