import { consoleOperations, type ConsoleOperationName } from "@ravi/operation-contracts/console";
import type { Transport, TransportCallInput } from "./transport/types.ts";
import { REGISTRY_HASH, SDK_VERSION } from "./version.ts";

export class ConsoleApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); this.name = "ConsoleApiError"; }
}
/** Human same-origin session. No runtime key, installation key or privileged handler is imported. */
export class ConsoleSessionTransport implements Transport {
  constructor(private options: { baseUrl?: string; fetch?: typeof fetch; headers?: () => HeadersInit } = {}) {}
  async call<T>(request: TransportCallInput): Promise<T> {
    const name = [...request.groupSegments, request.command].join(".") as ConsoleOperationName;
    const operation = consoleOperations[name];
    if (!operation) throw new ConsoleApiError("operation_unknown", 400);
    const input = operation.args[0]!.schema.parse(request.body.input);
    const base = this.options.baseUrl ?? (typeof location !== "undefined" ? location.origin : undefined);
    if (!base) throw new ConsoleApiError("origin_required", 400);
    const url = new URL(`/api/console/v1/${request.groupSegments.join("/")}/${request.command}`, base);
    if (typeof location !== "undefined" && url.origin !== location.origin) throw new ConsoleApiError("origin_mismatch", 400);
    const headers = new Headers(this.options.headers?.());
    headers.set("content-type", "application/json");
    headers.set("x-ravi-sdk-version", SDK_VERSION); headers.set("x-ravi-registry-hash", REGISTRY_HASH);
    const response = await (this.options.fetch ?? fetch)(url, {
      method: "POST", credentials: "same-origin", redirect: "error", headers,
      body: JSON.stringify({ input }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: { code?: string } };
      throw new ConsoleApiError(data.error?.code ?? "request_failed", response.status);
    }
    return operation.returns.parse(await response.json()) as T;
  }
}
