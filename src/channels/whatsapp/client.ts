/**
 * Typed WhatsApp client.
 *
 * Resolves an instance ref (instance UUID or account name) to its WhatsApp binding on
 * the live router config and calls the runner over the RPC (rpc-client.ts) with the
 * binding's instance UUID. An unbound ref fails with 404 `WHATSAPP_NOT_BOUND` and never
 * reaches the network. Every failure is a `WhatsAppRpcError` (errors.ts).
 */

import { configStore } from "../../config-store.js";
import type { RouterConfig } from "../../router/types.js";
import {
  DEFAULT_WHATSAPP_RPC_TIMEOUT_MS,
  WHATSAPP_RPC_ERROR_CODES,
  resolveWhatsAppBinding,
  type WhatsAppBinding,
  type WhatsAppRpcMethod,
  type WhatsAppRpcParams,
  type WhatsAppRpcResult,
} from "./contract.js";
import { WhatsAppRpcError } from "./errors.js";
import { requestWhatsAppRpc, type WhatsAppRpcConnection } from "./rpc-client.js";

/** Per-call RPC timeouts. Anything else uses DEFAULT_WHATSAPP_RPC_TIMEOUT_MS (60 s). */
export const WHATSAPP_CLIENT_TIMEOUTS_MS = {
  /** Status probe while listing instances: an offline runner must not stall the list (pass it explicitly). */
  listStatus: 2_500,
  status: 10_000,
  presence: 10_000,
  markRead: 15_000,
  /** Media may need ffmpeg/sharp conversion and an upload in the runner. */
  media: 120_000,
} as const;

/** Default timeout per method when the caller passes none. */
export function defaultWhatsAppClientTimeoutMs(method: WhatsAppRpcMethod): number {
  switch (method) {
    case "connection.status":
      return WHATSAPP_CLIENT_TIMEOUTS_MS.status;
    case "presence.set":
      return WHATSAPP_CLIENT_TIMEOUTS_MS.presence;
    case "messages.markRead":
      return WHATSAPP_CLIENT_TIMEOUTS_MS.markRead;
    case "messages.sendMedia":
    case "messages.sendSticker":
      return WHATSAPP_CLIENT_TIMEOUTS_MS.media;
    default:
      return DEFAULT_WHATSAPP_RPC_TIMEOUT_MS;
  }
}

export interface WhatsAppClientCallOptions {
  timeoutMs?: number;
}

type Call<M extends WhatsAppRpcMethod> = (
  ref: string,
  params: WhatsAppRpcParams<M>,
  options?: WhatsAppClientCallOptions,
) => Promise<WhatsAppRpcResult<M>>;

export interface WhatsAppClient {
  /** Binding for an instance UUID or account name (resolveWhatsAppBinding on live config). */
  resolveBinding(ref: string | null | undefined): WhatsAppBinding | null;
  /**
   * Resolves ref → binding.instanceId, else rejects with WhatsAppRpcError(404, WHATSAPP_NOT_BOUND,
   * "Instance <ref> is not bound to a WhatsApp channel. Run: ravi instances connect <name>").
   */
  request<M extends WhatsAppRpcMethod>(
    ref: string,
    method: M,
    params: WhatsAppRpcParams<M>,
    options?: WhatsAppClientCallOptions,
  ): Promise<WhatsAppRpcResult<M>>;
  readonly connection: {
    status: Call<"connection.status">;
    connect: Call<"connection.connect">;
    disconnect: Call<"connection.disconnect">;
    logout: Call<"connection.logout">;
    pairingCode: Call<"connection.pairingCode">;
  };
  readonly groups: {
    list: Call<"groups.list">;
    create: Call<"groups.create">;
    addParticipants: Call<"groups.addParticipants">;
    updateParticipants: Call<"groups.updateParticipants">;
    getInvite: Call<"groups.getInvite">;
    revokeInvite: Call<"groups.revokeInvite">;
    join: Call<"groups.join">;
    leave: Call<"groups.leave">;
    rename: Call<"groups.rename">;
    setDescription: Call<"groups.setDescription">;
    setSettings: Call<"groups.setSettings">;
    metadata: Call<"groups.metadata">;
  };
  readonly messages: {
    sendText: Call<"messages.sendText">;
    sendMedia: Call<"messages.sendMedia">;
    sendSticker: Call<"messages.sendSticker">;
    react: Call<"messages.react">;
    edit: Call<"messages.edit">;
    delete: Call<"messages.delete">;
    markRead: Call<"messages.markRead">;
  };
  readonly presence: { set: Call<"presence.set"> };
}

export interface CreateWhatsAppClientOptions {
  /** Live router config. Default `configStore.getConfig()`. */
  getConfig?: () => Pick<RouterConfig, "instances" | "channels" | "instanceToAccount">;
  /** Default: the shared lazy NATS connection. */
  connection?: WhatsAppRpcConnection;
  /** Test seam; default requestWhatsAppRpc. */
  request?: typeof requestWhatsAppRpc;
}

function notBound(ref: string, accountName: string): WhatsAppRpcError {
  return new WhatsAppRpcError(
    `Instance ${ref} is not bound to a WhatsApp channel. Run: ravi instances connect ${accountName}`,
    { status: 404, code: WHATSAPP_RPC_ERROR_CODES.notBound, instanceId: ref },
  );
}

export function createWhatsAppClient(options: CreateWhatsAppClientOptions = {}): WhatsAppClient {
  const getConfig = options.getConfig ?? (() => configStore.getConfig());
  const send = options.request ?? requestWhatsAppRpc;
  const connection = options.connection;

  function resolveBinding(ref: string | null | undefined): WhatsAppBinding | null {
    return resolveWhatsAppBinding(getConfig(), ref);
  }

  async function request<M extends WhatsAppRpcMethod>(
    ref: string,
    method: M,
    params: WhatsAppRpcParams<M>,
    callOptions?: WhatsAppClientCallOptions,
  ): Promise<WhatsAppRpcResult<M>> {
    const config = getConfig();
    const binding = resolveWhatsAppBinding(config, ref);
    if (!binding) {
      const trimmed = typeof ref === "string" ? ref.trim() : "";
      throw notBound(trimmed, config.instanceToAccount?.[trimmed] ?? (trimmed || "<name>"));
    }
    return send(binding.instanceId, method, params, {
      timeoutMs: callOptions?.timeoutMs ?? defaultWhatsAppClientTimeoutMs(method),
      ...(connection ? { connection } : {}),
    });
  }

  function call<M extends WhatsAppRpcMethod>(method: M): Call<M> {
    return (ref, params, callOptions) => request(ref, method, params, callOptions);
  }

  return {
    resolveBinding,
    request,
    connection: {
      status: call("connection.status"),
      connect: call("connection.connect"),
      disconnect: call("connection.disconnect"),
      logout: call("connection.logout"),
      pairingCode: call("connection.pairingCode"),
    },
    groups: {
      list: call("groups.list"),
      create: call("groups.create"),
      addParticipants: call("groups.addParticipants"),
      updateParticipants: call("groups.updateParticipants"),
      getInvite: call("groups.getInvite"),
      revokeInvite: call("groups.revokeInvite"),
      join: call("groups.join"),
      leave: call("groups.leave"),
      rename: call("groups.rename"),
      setDescription: call("groups.setDescription"),
      setSettings: call("groups.setSettings"),
      metadata: call("groups.metadata"),
    },
    messages: {
      sendText: call("messages.sendText"),
      sendMedia: call("messages.sendMedia"),
      sendSticker: call("messages.sendSticker"),
      react: call("messages.react"),
      edit: call("messages.edit"),
      delete: call("messages.delete"),
      markRead: call("messages.markRead"),
    },
    presence: { set: call("presence.set") },
  };
}
