import type { ScopeContext } from "../../../permissions/scope.js";
import type { ContextRecord } from "../../../router/router-db.js";

export interface StreamScope {
  permission: string;
  objectType: string;
  objectId: string;
}

export interface StreamChannelMatch {
  channelPath: string;
  scope: StreamScope;
}

export interface StreamRequestContext {
  url: URL;
  signal: AbortSignal;
  context: ScopeContext;
  contextRecord: ContextRecord;
}

export interface StreamEvent<TData = unknown> {
  id?: string;
  event: string;
  data: TData;
}

export interface StreamChannel {
  name: string;
  match(segments: string[], url: URL): StreamChannelMatch | null;
  subscribe(ctx: StreamRequestContext, match: StreamChannelMatch): AsyncIterable<StreamEvent>;
}

export interface StreamAuditEvent {
  type: "sdk.gateway.stream.opened" | "sdk.gateway.stream.closed" | "sdk.gateway.stream.denied";
  channel: string;
  channelPath: string;
  path: string;
  contextId: string | null;
  parentContextId: string | null;
  agentId: string | null;
  timestamp: string;
  durationMs?: number;
  reason?: string;
  scope?: StreamScope;
  filters?: Record<string, string>;
}

export interface StreamingGatewayConfig {
  channels?: StreamChannel[];
  keepaliveMs?: number;
  maxQueue?: number;
  emitAudit?: (event: StreamAuditEvent) => Promise<void> | void;
}
