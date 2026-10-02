/**
 * Runner side of the WhatsApp RPC.
 *
 * One server per WhatsApp runtime. It queue-subscribes
 * `_RAVI.channels.whatsapp.rpc.<instanceId>` (queue `ravi-whatsapp-rpc`), validates
 * every request against the contract, dispatches it to the runtime and always
 * answers with a `WhatsAppRpcResponse`:
 *
 * - `{ok:true, requestId, data}`, where `data` is exactly the runtime's
 *   `WhatsAppRpcResults[method]`;
 * - `{ok:false, requestId, error:{message, status, code}}` for every failure:
 *   400 `INVALID_REQUEST` for a malformed envelope, unknown method, invalid params or
 *   an `instanceId` that does not match the subject; the runtime's typed error
 *   (`{status, code}`) otherwise; 502 `TRANSPORT_ERROR` for anything untyped.
 *
 * Requests are handled concurrently (a send may wait on typing simulation, a
 * pairing-code request waits for the socket). This module imports no Baileys code
 * and does not depend on the runtime implementation, only on its `call` surface.
 */

import { JSONCodec } from "nats";
import { logger } from "../../utils/logger.js";
import {
  WHATSAPP_RPC_ERROR_CODES,
  WHATSAPP_RPC_QUEUE,
  WhatsAppRpcParamsSchemas,
  WhatsAppRpcRequestSchema,
  whatsappRpcSubject,
  type WhatsAppRpcErrorBody,
  type WhatsAppRpcMethod,
  type WhatsAppRpcResponse,
  type WhatsAppRpcResult,
} from "./contract.js";

const codec = JSONCodec<unknown>();
const log = logger.child("channels:whatsapp:rpc");

export const DEFAULT_WHATSAPP_RPC_DRAIN_TIMEOUT_MS = 5_000;

/** The runtime surface the server dispatches to (`WhatsAppRuntime.call`). */
export interface WhatsAppRpcDispatcher {
  call<M extends WhatsAppRpcMethod>(method: M, params: unknown): Promise<WhatsAppRpcResult<M>>;
}

export interface WhatsAppRpcServerMessage {
  readonly data: Uint8Array;
  readonly reply?: string;
  respond(data: Uint8Array): boolean;
}

export interface WhatsAppRpcServerSubscription extends AsyncIterable<WhatsAppRpcServerMessage> {
  unsubscribe(): void;
}

/** The subset of a NATS connection the server needs (lets tests pass a fake). */
export interface WhatsAppRpcServerConnection {
  subscribe(subject: string, options: { queue: string }): WhatsAppRpcServerSubscription;
}

export interface WhatsAppRpcServer {
  readonly subject: string;
  /** Requests being handled right now. */
  inFlight(): number;
  /**
   * Unsubscribe (no new requests), then wait up to `drainTimeoutMs` for in-flight
   * requests to be answered. Idempotent.
   */
  stop(options?: { drainTimeoutMs?: number }): Promise<void>;
}

export interface StartWhatsAppRpcServerOptions {
  instanceId: string;
  connection: WhatsAppRpcServerConnection;
  dispatcher: WhatsAppRpcDispatcher;
}

export function startWhatsAppRpcServer(options: StartWhatsAppRpcServerOptions): WhatsAppRpcServer {
  const subject = whatsappRpcSubject(options.instanceId);
  const subscription = options.connection.subscribe(subject, { queue: WHATSAPP_RPC_QUEUE });
  const pending = new Set<Promise<void>>();
  let stopped = false;
  let stopping: Promise<void> | null = null;

  const loop = (async () => {
    for await (const message of subscription) {
      if (stopped) break;
      const task = answer(message, options.instanceId, options.dispatcher);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  })().catch((error: unknown) => {
    if (!stopped) {
      log.warn("WhatsApp RPC subscription ended with an error", {
        instanceId: options.instanceId,
        error: errorText(error),
      });
    }
  });

  return {
    subject,
    inFlight: () => pending.size,
    stop(stopOptions = {}) {
      if (stopping) return stopping;
      stopped = true;
      try {
        subscription.unsubscribe();
      } catch {
        // The connection may already be closed; the loop ends either way.
      }
      const drainTimeoutMs = stopOptions.drainTimeoutMs ?? DEFAULT_WHATSAPP_RPC_DRAIN_TIMEOUT_MS;
      stopping = (async () => {
        await loop;
        if (pending.size === 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, drainTimeoutMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
      })();
      return stopping;
    },
  };
}

/**
 * Validate and dispatch one raw request. Never rejects: every failure becomes an
 * `{ok:false}` response.
 */
export async function handleWhatsAppRpcRequest(
  instanceId: string,
  raw: unknown,
  dispatcher: WhatsAppRpcDispatcher,
): Promise<WhatsAppRpcResponse> {
  const fallbackRequestId = requestIdOf(raw);
  const parsed = WhatsAppRpcRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return failure(fallbackRequestId, invalidRequest(`Invalid WhatsApp RPC request: ${issuesText(parsed.error)}`));
  }
  const request = parsed.data;
  if (request.instanceId !== instanceId) {
    return failure(
      request.requestId,
      invalidRequest(`WhatsApp RPC instanceId ${request.instanceId} does not match the subject instance ${instanceId}`),
    );
  }
  const params = WhatsAppRpcParamsSchemas[request.method].safeParse(request.params ?? {});
  if (!params.success) {
    return failure(
      request.requestId,
      invalidRequest(`Invalid params for ${request.method}: ${issuesText(params.error)}`),
    );
  }
  try {
    const data = await dispatcher.call(request.method, params.data);
    return { ok: true, requestId: request.requestId, data };
  } catch (error) {
    const mapped = toRpcError(error);
    log.debug("WhatsApp RPC failed", {
      instanceId,
      method: request.method,
      requestId: request.requestId,
      status: mapped.status,
      code: mapped.code,
    });
    return failure(request.requestId, mapped);
  }
}

/**
 * Map any thrown value to the response `error`. The runtime throws
 * `WhatsAppRuntimeError` (it carries `toRpcError()`, or `{status, code}`), which
 * passes through; anything untyped is a 502 `TRANSPORT_ERROR`.
 */
export function toRpcError(error: unknown): WhatsAppRpcErrorBody {
  if (isRecord(error)) {
    const typed = error as { toRpcError?: unknown };
    if (typeof typed.toRpcError === "function") {
      try {
        const value = (typed.toRpcError as () => unknown).call(error);
        if (isRpcError(value)) return value;
      } catch {
        // Fall through to the structural checks.
      }
    }
    const status = error.status;
    const code = error.code;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && typeof code === "string" && code) {
      return { message: errorText(error), status, code };
    }
  }
  return {
    message: errorText(error) || "WhatsApp transport error",
    status: 502,
    code: WHATSAPP_RPC_ERROR_CODES.transportError,
  };
}

async function answer(
  message: WhatsAppRpcServerMessage,
  instanceId: string,
  dispatcher: WhatsAppRpcDispatcher,
): Promise<void> {
  let response: WhatsAppRpcResponse;
  try {
    let raw: unknown;
    try {
      raw = codec.decode(message.data);
    } catch {
      response = failure("", invalidRequest("WhatsApp RPC request is not valid JSON"));
      respond(message, response, instanceId);
      return;
    }
    response = await handleWhatsAppRpcRequest(instanceId, raw, dispatcher);
  } catch (error) {
    // handleWhatsAppRpcRequest never rejects; this is a last-resort guard.
    response = failure("", toRpcError(error));
  }
  respond(message, response, instanceId);
}

function respond(message: WhatsAppRpcServerMessage, response: WhatsAppRpcResponse, instanceId: string): void {
  if (!message.reply) {
    log.debug("WhatsApp RPC request had no reply subject; dropping response", { instanceId });
    return;
  }
  try {
    message.respond(codec.encode(response));
  } catch (error) {
    // Typically a payload over the server's max_payload or a closed connection.
    log.warn("Failed to send WhatsApp RPC response", {
      instanceId,
      requestId: response.requestId,
      error: errorText(error),
    });
    if (!response.ok) return;
    try {
      message.respond(
        codec.encode(
          failure(response.requestId, {
            message: `WhatsApp RPC response could not be delivered: ${errorText(error)}`,
            status: 502,
            code: WHATSAPP_RPC_ERROR_CODES.transportError,
          }),
        ),
      );
    } catch {
      // Nothing else can be sent; the client times out.
    }
  }
}

function failure(requestId: string, error: WhatsAppRpcErrorBody): WhatsAppRpcResponse {
  return { ok: false, requestId, error };
}

function invalidRequest(message: string): WhatsAppRpcErrorBody {
  return { message, status: 400, code: WHATSAPP_RPC_ERROR_CODES.invalidRequest };
}

function requestIdOf(raw: unknown): string {
  if (!isRecord(raw)) return "";
  const requestId = raw.requestId;
  return typeof requestId === "string" && requestId.length <= 128 ? requestId : "";
}

function issuesText(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return (
    error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message))
      .join("; ") || "invalid"
  );
}

function isRpcError(value: unknown): value is WhatsAppRpcErrorBody {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    typeof value.code === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}
