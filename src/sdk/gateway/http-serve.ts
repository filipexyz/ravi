import { DEFAULT_HTTP_IDLE_TIMEOUT_SECONDS } from "./streaming/sse.js";

export interface RaviHttpServeOptions {
  hostname: string;
  port: number;
  fetch: (request: Request) => Response | Promise<Response>;
  idleTimeout?: number;
}

/**
 * Shared Bun.serve options for the daemon HTTP listener and the test-only
 * standalone gateway. Always sets `idleTimeout` so long-lived SSE is not
 * closed by Bun's 10s default before {@link DEFAULT_KEEPALIVE_MS}.
 */
export function raviHttpServeOptions(options: RaviHttpServeOptions) {
  return {
    hostname: options.hostname,
    port: options.port,
    fetch: options.fetch,
    idleTimeout: options.idleTimeout ?? DEFAULT_HTTP_IDLE_TIMEOUT_SECONDS,
  };
}
