/**
 * Baileys emits through a Node EventEmitter, which ignores what a listener returns:
 * an async listener that rejects becomes an unhandled rejection, and that kills the
 * channel runner. Every handler registered on `sock.ev` goes through `guardListener`,
 * which catches both synchronous throws and rejected promises, logs them, and hands
 * them to `onError` (the connection handler reports them as health).
 */

import type { Logger } from "../foundation.js";

export interface ListenerGuardOptions {
  readonly event: string;
  readonly instanceId: string;
  readonly log: Logger;
  /** Extra reporting (e.g. health). Its own failures are logged and swallowed. */
  readonly onError?: (error: unknown) => void;
}

function report(options: ListenerGuardOptions, error: unknown): void {
  options.log.error("WhatsApp event listener failed", {
    event: options.event,
    instanceId: options.instanceId,
    error: error instanceof Error ? error.message : String(error),
  });
  if (!options.onError) return;
  try {
    options.onError(error);
  } catch (reportError) {
    options.log.error("WhatsApp listener error reporter failed", {
      event: options.event,
      instanceId: options.instanceId,
      error: reportError instanceof Error ? reportError.message : String(reportError),
    });
  }
}

/** Wrap `handler` so it can never throw or reject into the EventEmitter. */
export function guardListener<A extends unknown[]>(
  options: ListenerGuardOptions,
  handler: (...args: A) => unknown,
): (...args: A) => void {
  return (...args: A) => {
    let result: unknown;
    try {
      result = handler(...args);
    } catch (error) {
      report(options, error);
      return;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      Promise.resolve(result).catch((error: unknown) => report(options, error));
    }
  };
}
