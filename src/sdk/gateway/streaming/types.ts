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

/**
 * JSON Schema (Draft 2020-12 subset) used by codegen to derive TypeScript
 * and Swift types. Use plain JS objects — `jsonSchemaToTs.ts` and
 * `jsonSchemaToSwift.ts` already handle the shapes we need.
 */
export type StreamChannelJsonSchema = Record<string, unknown>;

/**
 * Sub-payload declaration for one SSE event a channel emits. When a channel
 * declares `eventPayloads` (Phase 3 of streaming codegen), each entry yields:
 *
 *  - a named typed struct/interface for the inner `data` value of the
 *    `StreamChannelPayload` when this event fires;
 *  - a generated `decode<Event>()` helper on the parent payload type that
 *    re-decodes the raw envelope into the typed struct.
 *
 * Channels can omit this and stay on the generic envelope.
 */
export interface StreamChannelEventPayload {
  /** Generated type/struct name (e.g. `OmniMessageReceivedEnvelope`). */
  typeName: string;
  /** JSON Schema describing the inner `data` shape for this event. */
  schema: StreamChannelJsonSchema;
  /** Override for the generated helper method name. Defaults to
   *  `decode<EventName>` with PascalCase eventName. */
  helperName?: string;
}

/**
 * Declarative metadata for each stream channel. Drives SDK codegen across
 * languages (`packages/ravi-os-sdk/src/streaming.generated.ts`,
 * `RaviStreaming.generated.swift`, future Kotlin/web). When you add a
 * channel, only fill this in — the SDK methods, query-string plumbing,
 * payload types, and (optional) sub-event helpers fall out for every
 * supported client.
 */
export interface StreamChannelMeta {
  /** Method name on the SDK client. e.g. `events`, `chat`, `session`. */
  methodName: string;
  /** Path pattern relative to `/api/v1/_stream/`, templated with `{name}`
   *  placeholders. Templated segments become positional parameters on the
   *  generated method in the order they appear. */
  pathPattern: string;
  /** Human description rendered as JSDoc/Swift comment above the method. */
  description?: string;
  /** Override for the TypeScript options type name; defaults to a stable
   *  derivation of `methodName`. Useful when an existing public type name
   *  must be preserved during the codegen migration. */
  optionsTypeName?: string;
  /** Override for the TypeScript payload type name; same rationale. */
  payloadTypeName?: string;
  /** JSON Schema for the query-string options object (the second method
   *  argument after path parameters). Each top-level property becomes a
   *  query param; the codegen emits the right `URLSearchParams` plumbing
   *  based on `type` (`string` → string, `boolean` → `"1"` flag, `number`
   *  → coerced via `String()`). `signal?: AbortSignal` is implicit. */
  optionsSchema: StreamChannelJsonSchema;
  /** JSON Schema for the SSE event payload (the `data` field of each
   *  emitted `StreamEvent`). */
  payloadSchema: StreamChannelJsonSchema;
  /** Optional list of SSE `event:` names this channel emits. When set,
   *  codegen can later derive a discriminated union or typed dispatcher.
   *  When omitted, all events surface as the generic envelope. */
  eventNames?: readonly string[];
  /** Typed sub-payloads for individual SSE events. When set, the codegen
   *  emits one struct per event plus `decode<Event>()` helpers on the
   *  generic payload type so consumers can opt into typed access. */
  eventPayloads?: Readonly<Record<string, StreamChannelEventPayload>>;
}

export interface StreamChannel {
  name: string;
  /** Declarative metadata driving SDK codegen. */
  meta: StreamChannelMeta;
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
