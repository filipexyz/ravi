/**
 * Ravi Webhook HTTP Server
 *
 * Small daemon-owned HTTP surface for provider callbacks. This is intentionally
 * narrow: it is not the overlay bridge and not a general public API.
 */

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import {
  AGORA_MCP_TOOLS_PATH,
  handleAgoraWebhook,
  normalizeAgoraWebhookPayload,
  verifyAgoraWebhookSignature,
  type AgoraWebhookPayload,
} from "../prox/calls/agora.js";
import { handleToolBridgeRequest } from "../prox/calls/tool-bridge.js";
import { handlePostCallWebhook, normalizeCallWebhookPayload, type CallWebhookPayload } from "../prox/calls/webhook.js";
import {
  API_PREFIX,
  createGatewayHandlerContext,
  handleGatewayRequest,
  type GatewayConfig,
  type GatewayHandlerContext,
} from "../sdk/gateway/index.js";
import { logger } from "../utils/logger.js";

const log = logger.child("webhooks:http");

export const ELEVENLABS_POST_CALL_WEBHOOK_PATH = "/webhooks/elevenlabs/post-call";
export const AGORA_CONVOAI_WEBHOOK_PATH = "/webhooks/agora/convoai";
const ELEVENLABS_POST_CALL_WEBHOOK_ALIASES = new Set([
  ELEVENLABS_POST_CALL_WEBHOOK_PATH,
  "/api/webhooks/elevenlabs/post-call",
]);
const AGORA_CONVOAI_WEBHOOK_ALIASES = new Set([AGORA_CONVOAI_WEBHOOK_PATH, "/api/webhooks/agora/convoai"]);
export const PROX_CALLS_TOOLS_PATH = "/webhooks/prox/calls/tools";
const AGORA_MCP_TOOLS_ALIASES = new Set([AGORA_MCP_TOOLS_PATH, "/api/webhooks/agora/tools"]);
const ALL_TOOL_BRIDGE_PATHS = new Set([PROX_CALLS_TOOLS_PATH, ...AGORA_MCP_TOOLS_ALIASES]);

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

interface ServeLike {
  port: number;
  hostname: string;
  stop(force?: boolean): void;
}

declare const Bun: {
  serve(options: { hostname: string; port: number; fetch(request: Request): Response | Promise<Response> }): ServeLike;
};

export interface WebhookHttpServerConfig {
  host: string;
  port: number;
  elevenLabsWebhookSecret?: string;
  allowUnsignedElevenLabs?: boolean;
  agoraWebhookSecret?: string;
  allowUnsignedAgora?: boolean;
  maxBodyBytes?: number;
  /**
   * SDK gateway mount config. The gateway shares the daemon's single
   * `Bun.serve` and dispatches `/api/v1/*` requests. Pass `null` to disable
   * the mount entirely (used by tests that only exercise webhook paths and do
   * not want to load the CLI command graph). Pass `{}` (or omit) to mount
   * with defaults.
   */
  gateway?: GatewayConfig | null;
}

export interface WebhookHttpServerHandle {
  host: string;
  port: number;
  url: string;
  stop(): Promise<void>;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function parsePort(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid Ravi HTTP port: ${value}`);
  }
  return port;
}

function boolEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function getSignature(request: Request): string | null {
  return request.headers.get("elevenlabs-signature") ?? request.headers.get("ElevenLabs-Signature");
}

function getAgoraSignature(request: Request, version: 1 | 2): string | null {
  return version === 1
    ? (request.headers.get("agora-signature") ?? request.headers.get("Agora-Signature"))
    : (request.headers.get("agora-signature-v2") ?? request.headers.get("Agora-Signature-V2"));
}

async function parseElevenLabsWebhookEvent(
  rawBody: string,
  signature: string | null,
  config: WebhookHttpServerConfig,
): Promise<unknown> {
  const secret = config.elevenLabsWebhookSecret?.trim();
  if (secret) {
    const client = new ElevenLabsClient();
    return client.webhooks.constructEvent(rawBody, signature ?? "", secret);
  }

  if (!config.allowUnsignedElevenLabs) {
    throw Object.assign(new Error("ELEVENLABS_WEBHOOK_SECRET is not configured"), { status: 503 });
  }

  return JSON.parse(rawBody) as unknown;
}

function payloadSummary(payload: CallWebhookPayload): Record<string, unknown> {
  return {
    type: payload.type,
    conversationId: "conversation_id" in payload ? payload.conversation_id : undefined,
    callSid: "call_sid" in payload ? payload.call_sid : undefined,
  };
}

function agoraPayloadSummary(payload: AgoraWebhookPayload): Record<string, unknown> {
  return {
    noticeId: payload.noticeId,
    eventType: payload.eventType,
    agentId: typeof payload.payload.agent_id === "string" ? payload.payload.agent_id : undefined,
  };
}

async function readBoundedBody(request: Request, maxBodyBytes: number, label: string): Promise<string | Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBodyBytes) {
    return jsonResponse(413, { ok: false, error: "body_too_large" });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (error) {
    log.warn(`Failed to read ${label} webhook body`, { error });
    return jsonResponse(400, { ok: false, error: "invalid_body" });
  }

  if (new TextEncoder().encode(rawBody).length > maxBodyBytes) {
    return jsonResponse(413, { ok: false, error: "body_too_large" });
  }

  return rawBody;
}

async function handleElevenLabsPostCall(request: Request, config: WebhookHttpServerConfig): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const raw = await readBoundedBody(request, maxBodyBytes, "ElevenLabs");
  if (raw instanceof Response) return raw;
  const rawBody = raw;

  let event: unknown;
  try {
    event = await parseElevenLabsWebhookEvent(rawBody, getSignature(request), config);
  } catch (error) {
    const status =
      typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 401;
    log.warn("Rejected ElevenLabs webhook", { error, status });
    return jsonResponse(status, {
      ok: false,
      error: status === 503 ? "webhook_secret_not_configured" : "invalid_signature",
    });
  }

  let payload: CallWebhookPayload | null;
  try {
    payload = normalizeCallWebhookPayload(event);
  } catch (error) {
    log.warn("Failed to normalize ElevenLabs webhook", { error });
    return jsonResponse(400, { ok: false, error: "invalid_payload" });
  }

  if (!payload) {
    log.info("Ignoring unsupported ElevenLabs webhook event");
    return jsonResponse(200, { ok: true, ignored: true });
  }

  try {
    const result = handlePostCallWebhook(payload);
    if (!result) {
      log.warn("ElevenLabs webhook did not match any call run", payloadSummary(payload));
      return jsonResponse(200, { ok: true, matched: false });
    }

    log.info("ElevenLabs webhook processed", {
      requestId: result.request_id,
      runId: result.run_id,
      outcome: result.outcome,
    });
    return jsonResponse(200, { ok: true, matched: true, result });
  } catch (error) {
    log.error("Failed to process ElevenLabs webhook", { error, ...payloadSummary(payload) });
    return jsonResponse(500, { ok: false, error: "processing_failed" });
  }
}

async function handleAgoraConvoAIWebhook(request: Request, config: WebhookHttpServerConfig): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const raw = await readBoundedBody(request, maxBodyBytes, "Agora");
  if (raw instanceof Response) return raw;
  const rawBody = raw;

  const secret = config.agoraWebhookSecret?.trim();
  if (secret) {
    const v2 = verifyAgoraWebhookSignature(rawBody, secret, getAgoraSignature(request, 2), 2);
    const v1 = verifyAgoraWebhookSignature(rawBody, secret, getAgoraSignature(request, 1), 1);
    if (!v2 && !v1) {
      log.warn("Rejected Agora webhook: invalid signature");
      return jsonResponse(401, { ok: false, error: "invalid_signature" });
    }
  } else if (!config.allowUnsignedAgora) {
    return jsonResponse(503, { ok: false, error: "webhook_secret_not_configured" });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody) as unknown;
  } catch (error) {
    log.warn("Failed to parse Agora webhook", { error });
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  let payload: AgoraWebhookPayload | null;
  try {
    payload = normalizeAgoraWebhookPayload(event);
  } catch (error) {
    log.warn("Failed to normalize Agora webhook", { error });
    return jsonResponse(400, { ok: false, error: "invalid_payload" });
  }

  if (!payload) {
    log.info("Ignoring unsupported Agora webhook event");
    return jsonResponse(200, { ok: true, ignored: true });
  }

  try {
    const result = handleAgoraWebhook(payload);
    if (!result) {
      log.warn("Agora webhook did not match any call run", agoraPayloadSummary(payload));
      return jsonResponse(200, { ok: true, matched: false });
    }

    log.info("Agora webhook processed", {
      requestId: result.request_id,
      runId: result.run_id,
      outcome: result.outcome,
      eventType: payload.eventType,
    });
    return jsonResponse(200, { ok: true, matched: true, result });
  } catch (error) {
    log.error("Failed to process Agora webhook", { error, ...agoraPayloadSummary(payload) });
    return jsonResponse(500, { ok: false, error: "processing_failed" });
  }
}

async function handleToolBridge(
  request: Request,
  config: WebhookHttpServerConfig,
  requestId: string | null,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const raw = await readBoundedBody(request, maxBodyBytes, "tool bridge");
  if (raw instanceof Response) return raw;

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    log.warn("Failed to parse tool bridge request", { error });
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  try {
    const result = await handleToolBridgeRequest({
      requestId,
      authorization: request.headers.get("authorization"),
      payload,
    });
    if (!result.body) return new Response(null, { status: result.status });
    return jsonResponse(result.status, result.body);
  } catch (error) {
    log.error("Failed to process tool bridge request", { error, requestId });
    return jsonResponse(500, { ok: false, error: "processing_failed" });
  }
}

async function handleRequest(
  request: Request,
  config: WebhookHttpServerConfig,
  gatewayCtx: GatewayHandlerContext | null,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health" || url.pathname === "/webhooks/health") {
    return jsonResponse(200, { ok: true, service: "ravi-webhooks" });
  }

  if (gatewayCtx && (url.pathname.startsWith(`${API_PREFIX}/`) || url.pathname === API_PREFIX)) {
    const response = await handleGatewayRequest(request, gatewayCtx);
    if (response) return response;
  }

  if (ELEVENLABS_POST_CALL_WEBHOOK_ALIASES.has(url.pathname)) {
    return handleElevenLabsPostCall(request, config);
  }

  if (AGORA_CONVOAI_WEBHOOK_ALIASES.has(url.pathname)) {
    return handleAgoraConvoAIWebhook(request, config);
  }

  if (ALL_TOOL_BRIDGE_PATHS.has(url.pathname)) {
    return handleToolBridge(request, config, url.searchParams.get("request_id"));
  }

  return jsonResponse(404, { ok: false, error: "not_found" });
}

export function startWebhookHttpServer(config: WebhookHttpServerConfig): WebhookHttpServerHandle {
  assertGatewayBindAuthorized(config.host);

  const gatewayCtx: GatewayHandlerContext | null =
    config.gateway === null ? null : createGatewayHandlerContext(config.gateway ?? {});

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (request) => handleRequest(request, config, gatewayCtx),
  }) as ServeLike;

  const url = `http://${config.host}:${server.port}`;
  log.info("Webhook HTTP server started", {
    url,
    elevenLabsPath: ELEVENLABS_POST_CALL_WEBHOOK_PATH,
    agoraPath: AGORA_CONVOAI_WEBHOOK_PATH,
    toolBridgePath: PROX_CALLS_TOOLS_PATH,
    agoraToolsPath: AGORA_MCP_TOOLS_PATH,
    signatureVerification: Boolean(config.elevenLabsWebhookSecret),
    allowUnsignedElevenLabs: Boolean(config.allowUnsignedElevenLabs),
    agoraSignatureVerification: Boolean(config.agoraWebhookSecret),
    allowUnsignedAgora: Boolean(config.allowUnsignedAgora),
    sdkGatewayMounted: Boolean(gatewayCtx),
    sdkGatewayCommandCount: gatewayCtx?.table.byPath.size ?? 0,
    sdkGatewayRegistryHash: gatewayCtx?.table.registryHash ?? null,
  });

  return {
    host: config.host,
    port: server.port,
    url,
    async stop() {
      server.stop(true);
      log.info("Webhook HTTP server stopped");
    },
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function assertGatewayBindAuthorized(host: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isLoopbackHost(host)) return;
  const opt = env.RAVI_GATEWAY_NETWORK_AUTHORIZED?.trim();
  if (opt === "1" || opt?.toLowerCase() === "true" || opt?.toLowerCase() === "yes") return;
  log.error(
    `Refusing to bind Ravi HTTP server to non-loopback host '${host}' without RAVI_GATEWAY_NETWORK_AUTHORIZED=1. ` +
      "The SDK gateway requires this opt-in to expose itself to the network even when bearer auth is configured. " +
      "Set RAVI_HTTP_HOST=127.0.0.1 to bind locally, or RAVI_GATEWAY_NETWORK_AUTHORIZED=1 to allow public binding.",
  );
  process.exit(2);
}

export function startWebhookHttpServerFromEnv(): WebhookHttpServerHandle | null {
  const port = parsePort(process.env.RAVI_HTTP_PORT ?? process.env.RAVI_WEBHOOK_PORT);
  if (port === null) return null;

  const gatewayDisabled = boolEnv(process.env.RAVI_SDK_GATEWAY_DISABLE);
  const allowSuperadmin = boolEnv(process.env.RAVI_SDK_GATEWAY_ALLOW_SUPERADMIN);
  const host = process.env.RAVI_HTTP_HOST?.trim() || process.env.RAVI_WEBHOOK_HOST?.trim() || "127.0.0.1";

  assertGatewayBindAuthorized(host);

  return startWebhookHttpServer({
    host,
    port,
    elevenLabsWebhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET?.trim() || undefined,
    allowUnsignedElevenLabs: boolEnv(process.env.RAVI_ELEVENLABS_WEBHOOK_ALLOW_UNSIGNED),
    agoraWebhookSecret: process.env.AGORA_WEBHOOK_SECRET?.trim() || undefined,
    allowUnsignedAgora: boolEnv(process.env.RAVI_AGORA_WEBHOOK_ALLOW_UNSIGNED),
    gateway: gatewayDisabled ? null : { allowSuperadmin },
  });
}
