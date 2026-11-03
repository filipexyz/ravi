/**
 * `ravi-connectors` Worker entrypoint.
 *
 * Hosted at `link.ravi.so`. Routes connector OAuth, vault, and proxy
 * traffic (see `router.ts`) and runs the scheduled maintenance on the
 * wrangler cron. The Vercel runtime never executes any path served here.
 */

import type { ConnectorsWorkerEnv } from "./env";
import { createConnectorsWorker, type DurableObjectState } from "./router";

export default createConnectorsWorker();

// --------------------------------------------------------------------------
// Durable Object stubs (real impls land with the KMS rate-limit module)
// --------------------------------------------------------------------------

export class OrgRateLimitDO {
  constructor(_state: DurableObjectState, _env: ConnectorsWorkerEnv) {}
  async fetch(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ error: "not_implemented" }), {
      status: 501,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export class ConnectorRateLimitDO {
  constructor(_state: DurableObjectState, _env: ConnectorsWorkerEnv) {}
  async fetch(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ error: "not_implemented" }), {
      status: 501,
      headers: { "Content-Type": "application/json" },
    });
  }
}

