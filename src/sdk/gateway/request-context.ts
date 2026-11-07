import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface GatewayRequestContext {
  requestId: string;
  op: string;
  diagnosticRequestId?: string;
}

const requests = new AsyncLocalStorage<GatewayRequestContext>();

/** Server-generated: never trust a caller's correlation id or echo arbitrary paths. */
export function withGatewayRequest<T>(op: string, run: () => T): T {
  return requests.getStore() ? run() : requests.run({ requestId: randomUUID(), op }, run);
}

export function gatewayRequestContext(): GatewayRequestContext {
  return requests.getStore() ?? { requestId: randomUUID(), op: "gateway" };
}
