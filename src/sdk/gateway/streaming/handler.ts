import { emitCliAuditEvent } from "../../../cli/audit.js";
import { canWithCapabilityContext } from "../../../permissions/engine.js";
import { publish } from "../../../nats.js";
import type { ContextRecord } from "../../../router/router-db.js";
import { methodNotAllowed, notFound, permissionDenied, unauthorized } from "../errors.js";
import { resolveAuth, type AuthFailureReason, type GatewayAuthConfig } from "../auth.js";
import { API_PREFIX } from "../route-table.js";
import { createSseResponse, DEFAULT_KEEPALIVE_MS, DEFAULT_MAX_QUEUE } from "./sse.js";
import { defaultStreamChannels } from "./channels.js";
import type {
  StreamAuditEvent,
  StreamChannel,
  StreamChannelMatch,
  StreamRequestContext,
  StreamingGatewayConfig,
} from "./types.js";

export interface StreamingHandlerOptions {
  auth: GatewayAuthConfig;
  hasLiveAdminContext: () => boolean;
  authFailureMessage: (reason: AuthFailureReason) => string;
  streaming?: StreamingGatewayConfig;
}

export async function handleStreamingRequest(
  request: Request,
  url: URL,
  options: StreamingHandlerOptions,
): Promise<Response | null> {
  const streamPrefix = `${API_PREFIX}/_stream`;
  if (url.pathname !== streamPrefix && !url.pathname.startsWith(`${streamPrefix}/`)) {
    return null;
  }

  if (request.method !== "GET") {
    return methodNotAllowed(request.method, url.pathname);
  }

  const resolved = resolveAuth(request, options.auth);
  if (!options.hasLiveAdminContext()) {
    return unauthorized(
      "no admin context configured; run 'ravi daemon init-admin-key' on the daemon host before issuing gateway requests",
    );
  }
  if (!resolved.authenticated || !resolved.contextRecord) {
    return unauthorized(options.authFailureMessage(resolved.reason));
  }
  const contextRecord = resolved.contextRecord;

  const matched = matchStreamChannel(url, options.streaming?.channels ?? defaultStreamChannels);
  if (!matched) {
    return notFound(url.pathname);
  }

  const allowed = canWithCapabilityContext(
    resolved.contextRecord,
    matched.match.scope.permission,
    matched.match.scope.objectType,
    matched.match.scope.objectId,
  );
  if (!allowed) {
    const audit = buildAuditEvent(
      "sdk.gateway.stream.denied",
      matched.channel,
      matched.match,
      url,
      contextRecord,
      0,
      "permission_denied",
    );
    await emitStreamAudit(audit, options.streaming?.emitAudit);
    await publishDeniedAudit(audit, options.streaming?.emitAudit);
    return permissionDenied(
      `Permission denied: requires ${matched.match.scope.permission} on ${matched.match.scope.objectType}:${matched.match.scope.objectId}`,
    );
  }

  const startedAt = Date.now();
  const openAudit = buildAuditEvent("sdk.gateway.stream.opened", matched.channel, matched.match, url, contextRecord, 0);
  await emitStreamAudit(openAudit, options.streaming?.emitAudit);

  const streamAbort = new AbortController();
  const abortFromRequest = () => streamAbort.abort();
  request.signal.addEventListener("abort", abortFromRequest, { once: true });

  const ctx: StreamRequestContext = {
    url,
    signal: streamAbort.signal,
    context: resolved.context,
    contextRecord,
  };

  return createSseResponse(matched.channel.subscribe(ctx, matched.match), {
    signal: request.signal,
    keepaliveMs: options.streaming?.keepaliveMs ?? DEFAULT_KEEPALIVE_MS,
    maxQueue: options.streaming?.maxQueue ?? DEFAULT_MAX_QUEUE,
    lastEventId: request.headers.get("last-event-id"),
    onClose: async (reason) => {
      streamAbort.abort();
      request.signal.removeEventListener("abort", abortFromRequest);
      const closeAudit = buildAuditEvent(
        "sdk.gateway.stream.closed",
        matched.channel,
        matched.match,
        url,
        contextRecord,
        Date.now() - startedAt,
        reason,
      );
      await emitStreamAudit(closeAudit, options.streaming?.emitAudit);
    },
  });
}

function matchStreamChannel(
  url: URL,
  channels: StreamChannel[],
): { channel: StreamChannel; match: StreamChannelMatch } | null {
  const prefix = `${API_PREFIX}/_stream/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const raw = url.pathname.slice(prefix.length);
  const segments: string[] = [];
  for (const segment of raw.split("/").filter(Boolean)) {
    const decoded = safeDecodePathSegment(segment);
    if (decoded === null) return null;
    segments.push(decoded);
  }

  for (const channel of channels) {
    const match = channel.match(segments, url);
    if (match) return { channel, match };
  }
  return null;
}

function safeDecodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function buildAuditEvent(
  type: StreamAuditEvent["type"],
  channel: StreamChannel,
  match: StreamChannelMatch,
  url: URL,
  contextRecord: ContextRecord,
  durationMs: number,
  reason?: string,
): StreamAuditEvent {
  const parentContextId =
    typeof contextRecord.metadata?.parentContextId === "string" ? contextRecord.metadata.parentContextId : null;
  const filters: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) filters[key] = value;
  return {
    type,
    channel: channel.name,
    channelPath: match.channelPath,
    path: url.pathname,
    contextId: contextRecord.contextId,
    parentContextId,
    agentId: contextRecord.agentId ?? null,
    timestamp: new Date().toISOString(),
    ...(durationMs > 0 ? { durationMs } : {}),
    ...(reason ? { reason } : {}),
    scope: match.scope,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  };
}

async function emitStreamAudit(
  event: StreamAuditEvent,
  override?: (event: StreamAuditEvent) => Promise<void> | void,
): Promise<void> {
  if (override) {
    await override(event);
    return;
  }

  const topic = `ravi.audit.${event.type}`;
  await publish(topic, event as unknown as Record<string, unknown>).catch(() => undefined);

  await emitCliAuditEvent({
    group: "sdk_gateway_stream",
    name: event.type.endsWith(".opened") ? "opened" : event.type.endsWith(".closed") ? "closed" : "denied",
    tool: event.type,
    input: {
      channel: event.channel,
      channelPath: event.channelPath,
      path: event.path,
      filters: event.filters ?? {},
      reason: event.reason,
    },
    isError: event.type.endsWith(".denied"),
    durationMs: event.durationMs,
    contextId: event.contextId,
    parentContextId: event.parentContextId,
    agentId: event.agentId,
  }).catch(() => undefined);
}

async function publishDeniedAudit(
  event: StreamAuditEvent,
  override?: (event: StreamAuditEvent) => Promise<void> | void,
): Promise<void> {
  if (override) return;
  await publish("ravi.audit.denied", {
    type: "sdk_gateway_stream",
    agentId: event.agentId,
    denied: `${event.scope?.permission}:${event.scope?.objectType}:${event.scope?.objectId}`,
    reason: event.reason ?? "permission_denied",
    detail: {
      channel: event.channel,
      channelPath: event.channelPath,
      path: event.path,
      contextId: event.contextId,
    },
  }).catch(() => undefined);
}
