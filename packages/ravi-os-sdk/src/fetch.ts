/**
 * Resolve the `fetch` implementation used by browser-safe SDK clients.
 *
 * Native `Window.fetch` / `WorkerGlobalScope.fetch` throw
 * `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`
 * when the method is extracted and called without its original receiver.
 * The default path therefore binds `globalThis.fetch` so Electron and
 * browsers work without a `config.fetch` workaround.
 *
 * A caller-supplied `custom` implementation is returned as-is so tests,
 * retry wrappers, and edge runtimes keep control of `this`.
 */
export function resolveFetch(custom: typeof fetch | undefined, missingError: string): typeof fetch {
  const impl = custom ?? globalThis.fetch;
  if (typeof impl !== "function") {
    throw new Error(missingError);
  }
  return custom === undefined ? impl.bind(globalThis) : impl;
}
