/**
 * HTTP transport for `@ravi-os/sdk`. Browser-safe — depends only on `fetch`.
 *
 * Routing matches the gateway: every call POSTs to
 * `${baseUrl}/api/v1/${groupSegments.join("/")}/${command}` with a flat JSON
 * body and `Authorization: Bearer ${contextKey}`.
 *
 * Error mapping is centralised in `errors.ts#buildErrorFromGateway` so the
 * HTTP and in-process transports never drift on which status maps to which
 * error class.
 */

import type { Transport, TransportCallInput } from "./types.js";
import {
  RaviTransportError,
  buildErrorFromGateway,
  type RaviErrorBody,
} from "../errors.js";
import { REGISTRY_HASH, SDK_VERSION } from "../version.js";

export interface HttpTransportConfig {
  /** Base URL of the Ravi gateway. Example: `http://127.0.0.1:7777`. */
  baseUrl: string;
  /** Runtime context key (`rctx_*`). Sent as `Authorization: Bearer <key>`. */
  contextKey: string;
  /** Optional fetch override (testing, custom retry layers, edge runtimes). */
  fetch?: typeof fetch;
  /** Request timeout in ms. `0` or omitted = no timeout. */
  timeoutMs?: number;
  /** Extra headers merged into every request (after SDK headers). */
  headers?: Record<string, string>;
}

const API_PREFIX = "/api/v1";

export function createHttpTransport(config: HttpTransportConfig): Transport {
  const baseUrl = stripTrailingSlash(config.baseUrl);
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "createHttpTransport: no global `fetch` available. Pass `config.fetch` explicitly when running in a stripped-down runtime.",
    );
  }
  const timeoutMs = config.timeoutMs ?? 0;

  return {
    async call<T>(input: TransportCallInput): Promise<T> {
      const path = `${API_PREFIX}/${[...input.groupSegments, input.command].join("/")}`;
      const url = `${baseUrl}${path}`;
      const commandLabel = `${input.groupSegments.join(".")}.${input.command}`;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${config.contextKey}`,
        "x-ravi-sdk-version": SDK_VERSION,
        "x-ravi-registry-hash": REGISTRY_HASH,
        ...(config.headers ?? {}),
      };

      const controller = timeoutMs > 0 ? new AbortController() : null;
      const timeoutHandle =
        controller !== null ? setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs) : null;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(input.body ?? {}),
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch (err) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        throw new RaviTransportError(
          err instanceof Error ? err.message : `network error calling ${commandLabel}`,
          err,
          commandLabel,
        );
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const rawText = await safeText(response);
      const parsed = parseJson(rawText);

      if (!response.ok) {
        throw buildErrorFromGateway(response.status, parsed, commandLabel);
      }

      if (parsed === null && rawText.length === 0) {
        return {} as T;
      }
      return parsed as T;
    },
  };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseJson(raw: string): RaviErrorBody | null {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw) as RaviErrorBody;
  } catch {
    return { error: "MalformedResponse", message: raw.slice(0, 1024) };
  }
}
