import { randomUUID } from "node:crypto";
import { serve } from "bun";
import type { ModelCallFence } from "./model-call-fence.js";
import { ModelCallFenceError } from "./model-call-fence.js";

const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
];

type ModelCallProxyCommonOptions = {
  readonly fence: ModelCallFence;
  readonly maxRequestBytes?: number;
  readonly requestTimeoutMs?: number;
  /** Synchronous inspection of a private request draft, not proof of upstream delivery. */
  readonly beforeDispatch?: (request: ModelCallProxyInspection) => void;
};

export type ModelCallProxyInspection = {
  readonly method: "GET" | "POST";
  readonly path: string;
  /** Defensive copy: inspector writes never change the actual transport bytes. */
  readonly body: Uint8Array;
};

export type ModelCallProxyUpstream = {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type ModelCallProxyRoute = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly upstream: ModelCallProxyUpstream;
  readonly queryKeys?: readonly string[];
};

export type ModelCallProxySingleEndpointOptions = ModelCallProxyCommonOptions & {
  readonly requestPath: string;
  readonly upstream: ModelCallProxyUpstream;
  readonly routes?: never;
};

export type ModelCallProxyOptions =
  | ModelCallProxySingleEndpointOptions
  | (ModelCallProxyCommonOptions & {
      readonly routes: readonly ModelCallProxyRoute[];
      readonly requestPath?: never;
      readonly upstream?: never;
    });

export type ModelCallProxy = {
  /** Private local binding URL. Never persist it or include it in telemetry. */
  readonly url: string;
  readonly origin: string;
  readonly path: string;
  /** Private SDK base URL; only explicitly registered relative routes exist. */
  readonly baseUrl: string;
  close(): Promise<void>;
};

/**
 * Fixed HTTP inference routes, not a general HTTP/CONNECT proxy. Adapters must
 * independently prove that all their model calls use this binding; this server
 * does not establish an OS principal boundary or implement WebSocket admission.
 */
export function startModelCallProxy(options: ModelCallProxyOptions): ModelCallProxy {
  const routes = prepareRoutes(options);
  const fence = options.fence;
  const beforeDispatch = options.beforeDispatch;
  const maxRequestBytes = positiveInteger(options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES);
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const prefix = `/model-call/${randomUUID()}`;
  const path = `${prefix}${routes.primaryPath}`;
  const activeRequests = new Set<AbortController>();
  let closed = false;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    idleTimeout: 0,
    maxRequestBodySize: maxRequestBytes,
    async fetch(request) {
      const target = new URL(request.url);
      if (closed) return errorResponse(503, "RAVI_MODEL_CALL_PROXY_CLOSED");
      const relativePath = target.pathname.slice(prefix.length);
      const route = routes.byEndpoint.get(`${request.method}:${relativePath}`);
      if (
        target.origin !== server.url.origin ||
        !target.pathname.startsWith(`${prefix}/`) ||
        !route ||
        request.headers.has("origin") ||
        request.headers.has("upgrade")
      ) {
        return errorResponse(404, "RAVI_MODEL_CALL_ROUTE_REJECTED");
      }
      if (
        target.search.length > 4096 ||
        [...target.searchParams.keys()].some(
          (key) => !route.queryKeys.has(key) || target.searchParams.getAll(key).length !== 1,
        )
      ) {
        return errorResponse(400, "RAVI_MODEL_CALL_QUERY_REJECTED");
      }
      const upstreamUrl = new URL(route.upstreamUrl);
      target.searchParams.forEach((value, key) => {
        upstreamUrl.searchParams.set(key, value);
      });
      const length = request.headers.get("content-length");
      if (length !== null && Number(length) > maxRequestBytes) {
        return errorResponse(413, "RAVI_MODEL_CALL_BODY_TOO_LARGE");
      }

      const abort = new AbortController();
      const cancel = () => abort.abort();
      request.signal.addEventListener("abort", cancel, { once: true });
      if (request.signal.aborted) cancel();
      activeRequests.add(abort);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        cancel();
      }, requestTimeoutMs);
      const finish = () => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", cancel);
        activeRequests.delete(abort);
      };

      try {
        const body = await readRequestBody(request, maxRequestBytes, abort.signal);
        if (route.method === "GET" && body.byteLength > 0) {
          finish();
          return errorResponse(400, "RAVI_MODEL_CALL_BODY_REJECTED");
        }
        const headers = endToEndHeaders(request.headers);
        // Fixed host routing and credentials override untrusted client headers.
        route.fixedHeaders.forEach((value, name) => {
          headers.set(name, value);
        });
        abort.signal.throwIfAborted();
        if (beforeDispatch) {
          try {
            inspectModelRequest(beforeDispatch, route.method, relativePath, body);
          } catch {
            // Seal the binding before any asynchronous notification. Neither
            // the parser's exception nor its request bytes leave the host.
            await abortable(fence.invalidate("verification-failed"), abort.signal);
            throw new ModelCallFenceError();
          }
        }
        const response = await abortable(
          fence.run(() => {
            abort.signal.throwIfAborted();
            if (closed) throw new Error("Model call proxy closed.");
            return fetch(upstreamUrl, {
              method: route.method,
              headers,
              ...(route.method === "POST" ? { body } : {}),
              signal: abort.signal,
              redirect: "manual",
              decompress: false,
              verbose: false,
            });
          }),
          abort.signal,
        );

        if (response.status >= 300 && response.status < 400) {
          // Returning Location would let an SDK follow the redirect outside
          // the fence even though the host fetch itself uses manual redirects.
          cancel();
          finish();
          return errorResponse(502, "RAVI_MODEL_CALL_REDIRECT_REJECTED");
        }
        return streamResponse(response, abort, finish);
      } catch (error) {
        cancel();
        finish();
        if (error instanceof ModelCallFenceError) {
          return errorResponse(409, "RAVI_SKILL_POLICY_STALE");
        }
        if (error instanceof ModelCallBodyTooLargeError) {
          return errorResponse(413, "RAVI_MODEL_CALL_BODY_TOO_LARGE");
        }
        return errorResponse(timedOut ? 504 : 502, "RAVI_MODEL_CALL_UNAVAILABLE");
      }
    },
    // Bun's development error page can reveal request/configuration contents.
    error() {
      return errorResponse(502, "RAVI_MODEL_CALL_UNAVAILABLE");
    },
  });
  const origin = server.url.origin;
  return {
    url: `${origin}${path}`,
    origin,
    path,
    baseUrl: `${origin}${prefix}`,
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of activeRequests) controller.abort();
      await server.stop(true);
    },
  };
}

function inspectModelRequest(
  inspector: (request: ModelCallProxyInspection) => void,
  method: "GET" | "POST",
  path: string,
  body: Uint8Array,
): void {
  // Uint8Array.from copies Buffer inputs too; Buffer.slice would share memory.
  const result: unknown = inspector(Object.freeze({ method, path, body: Uint8Array.from(body) }));
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    "then" in result &&
    typeof result.then === "function"
  ) {
    // A Promise fits a TypeScript void callback slot, but cannot certify a
    // synchronous inspection. Consume rejection only to keep errors private.
    void Promise.resolve(result).catch(() => undefined);
    throw new ModelCallFenceError();
  }
}

type PreparedModelCallRoute = {
  readonly method: "GET" | "POST";
  readonly upstreamUrl: string;
  readonly fixedHeaders: Headers;
  readonly queryKeys: ReadonlySet<string>;
};

function prepareRoutes(options: ModelCallProxyOptions) {
  let input: readonly ModelCallProxyRoute[];
  if (options.routes !== undefined) {
    if (options.upstream !== undefined || options.requestPath !== undefined) {
      throw new Error("Model call proxy requires one explicit routing configuration.");
    }
    input = options.routes;
  } else {
    input = [{ method: "POST", path: options.requestPath, upstream: options.upstream }];
  }
  if (!isNonemptyRouteList(input)) throw new Error("Model call proxy routes are required.");
  const byEndpoint = new Map<string, PreparedModelCallRoute>();
  for (const route of input) {
    if (!route || (route.method !== "GET" && route.method !== "POST") || !route.upstream) {
      throw new Error("Model call proxy route is invalid.");
    }
    validateRequestPath(route.path);
    const key = `${route.method}:${route.path}`;
    if (byEndpoint.has(key)) throw new Error("Duplicate model call proxy route.");
    const queryKeys = new Set(route.queryKeys ?? []);
    if (
      queryKeys.size !== (route.queryKeys ?? []).length ||
      [...queryKeys].some((name) => !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name))
    ) {
      throw new Error("Model call proxy query keys are invalid.");
    }
    byEndpoint.set(key, {
      method: route.method,
      upstreamUrl: validateUpstream(route.upstream.url),
      fixedHeaders: readFixedHeaders(route.upstream.headers),
      queryKeys,
    });
  }
  return { primaryPath: input[0].path, byEndpoint };
}

function isNonemptyRouteList(value: readonly ModelCallProxyRoute[]): boolean {
  return Array.isArray(value) && value.length > 0;
}

function streamResponse(response: Response, abort: AbortController, finish: () => void): Response {
  const headers = endToEndHeaders(response.headers);
  const reader = response.body?.getReader();
  if (!reader) {
    finish();
    return new Response(null, { status: response.status, headers });
  }
  let settled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (settled) return;
        if (next.done) {
          settled = true;
          reader.releaseLock();
          finish();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch {
        if (settled) return;
        settled = true;
        abort.abort();
        finish();
        controller.error(new Error("Model response stream interrupted."));
      }
    },
    async cancel() {
      settled = true;
      abort.abort();
      finish();
      try {
        await reader.cancel();
      } catch {
        // Cancellation is already enforced by the fetch signal. Never expose
        // an upstream reader exception, which may contain private routing data.
        throw new Error("Model response stream cancelled.");
      }
    },
  });
  return new Response(body, { status: response.status, headers });
}

async function readRequestBody(request: Request, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new ModelCallBodyTooLargeError();
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(new Error("Model call cancelled."));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function endToEndHeaders(input: Headers): Headers {
  const result = new Headers(input);
  for (const name of (input.get("connection") ?? "").split(",")) {
    if (name.trim()) result.delete(name.trim());
  }
  for (const name of HOP_HEADERS) result.delete(name);
  result.delete("forwarded");
  result.delete("x-forwarded-host");
  result.delete("x-forwarded-proto");
  result.delete("x-forwarded-for");
  return result;
}

function readFixedHeaders(input: Readonly<Record<string, string>> | undefined): Headers {
  let headers: Headers;
  try {
    headers = new Headers(input);
  } catch {
    throw new Error("Model call routing headers are invalid.");
  }
  for (const name of HOP_HEADERS) {
    if (headers.has(name)) throw new Error("Model call routing contains a forbidden transport header.");
  }
  return headers;
}

function validateUpstream(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Model call upstream URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")
  ) {
    throw new Error("Model call upstream must be HTTPS or loopback HTTP without URL credentials.");
  }
  return url.toString();
}

function validateRequestPath(path: string): void {
  if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.includes("//") || path.endsWith("/")) {
    throw new Error("Model call request path must be an explicit inference endpoint.");
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error("Model call request limits must be positive bounded integers.");
  }
  return value;
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status, headers: { "cache-control": "no-store" } });
}

class ModelCallBodyTooLargeError extends Error {}
