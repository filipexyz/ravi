/**
 * Emit `packages/ravi-os-sdk/src/streaming.generated.ts` from the declarative
 * channel metadata in `src/sdk/gateway/streaming/channels.ts`. One method per
 * channel, with options + payload types derived from each channel's JSON
 * Schema. The static SSE plumbing (parser, transport, helpers) is included
 * in the emitted output as a deterministic prelude so the generated file
 * is fully self-contained — no hand-written sibling required.
 *
 * Determinism: channels are walked in their registry order (the registry is
 * authoritative). Inside each channel, schema properties are walked in the
 * order declared so the output stays diff-friendly.
 */

import { jsonSchemaToTs, type JsonSchema } from "./json-schema-to-ts.js";
import type { StreamChannel, StreamChannelMeta } from "../gateway/streaming/types.js";

const HEADER = [
  "// GENERATED FILE — DO NOT EDIT.",
  "// Run `ravi sdk client generate` to regenerate.",
  "// Drift is detected by `ravi sdk client check` (CI).",
].join("\n");

const STATIC_PRELUDE = `import { buildErrorFromGateway, RaviTransportError, type RaviErrorBody } from "./errors.js";
import { REGISTRY_HASH, SDK_VERSION } from "./version.js";

export interface StreamClientConfig {
  /** Base URL of the Ravi gateway. Example: \`http://127.0.0.1:7777\`. */
  baseUrl: string;
  /** Runtime context key (\`rctx_*\`). Sent as \`Authorization: Bearer <key>\`. */
  contextKey: string;
  /** Optional fetch override (testing, custom retry layers, edge runtimes). */
  fetch?: typeof fetch;
  /** Extra headers merged into every request (after SDK headers). */
  headers?: Record<string, string>;
}

export interface RaviSseEvent<TData = unknown> {
  id?: string;
  event: string;
  data: TData;
}
`;

const STATIC_EPILOGUE = `export function createStreamClient(config: StreamClientConfig): RaviStreamClient {
  return new RaviStreamClient(config);
}

export async function* parseSse<TData = unknown>(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<RaviSseEvent<TData>> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let eventId: string | undefined;
  let dataLines: string[] = [];
  let completed = false;

  const flush = (): RaviSseEvent<TData> | null => {
    if (dataLines.length === 0) {
      eventName = "message";
      eventId = undefined;
      return null;
    }
    const raw = dataLines.join("\\n");
    const out = {
      ...(eventId !== undefined ? { id: eventId } : {}),
      event: eventName,
      data: JSON.parse(raw) as TData,
    };
    eventName = "message";
    eventId = undefined;
    dataLines = [];
    return out;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");

      let newlineIndex = buffer.indexOf("\\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line === "") {
          const event = flush();
          if (event) yield event;
        } else if (!line.startsWith(":")) {
          const colonIndex = line.indexOf(":");
          const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
          const valuePart = colonIndex === -1 ? "" : line.slice(colonIndex + 1).replace(/^ /, "");
          if (field === "event") eventName = valuePart || "message";
          if (field === "id") eventId = valuePart;
          if (field === "data") dataLines.push(valuePart);
        }
        newlineIndex = buffer.indexOf("\\n");
      }
    }

    const tail = decoder.decode();
    if (tail) buffer += tail;
    if (buffer.length > 0) {
      for (const line of buffer.split("\\n")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        if (line.startsWith("event:")) eventName = line.slice(6).replace(/^ /, "") || "message";
        if (line.startsWith("id:")) eventId = line.slice(3).replace(/^ /, "");
      }
    }
    const event = flush();
    if (event) yield event;
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function appendString(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value.trim() !== "") params.set(key, value);
}

function appendNumber(params: URLSearchParams, key: string, value: number | undefined): void {
  if (value !== undefined && Number.isFinite(value)) params.set(key, String(value));
}

function appendBool(params: URLSearchParams, key: string, value: boolean | undefined): void {
  if (value === true) params.set(key, "1");
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
`;

interface ResolvedPathParam {
  name: string;
  identifier: string;
}

interface ResolvedOptionsField {
  /** JSON key on the query string (matches the JSON Schema property). */
  key: string;
  /** TypeScript identifier (camelCase mirror of `key`). */
  identifier: string;
  /** TypeScript type expression. */
  type: string;
  /** Encoder helper to use. */
  encoder: "appendString" | "appendNumber" | "appendBool";
  /** Optional doc string lifted from the JSON Schema `description`. */
  description?: string;
}

interface ResolvedChannel {
  meta: StreamChannelMeta;
  pathParams: ResolvedPathParam[];
  pathLiteral: string;
  optionsTypeName: string;
  payloadTypeName: string;
  optionsFields: ResolvedOptionsField[];
  payloadType: string;
}

const PATH_PARAM_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function resolvePathParams(pattern: string): { params: ResolvedPathParam[]; literal: string } {
  const params: ResolvedPathParam[] = [];
  const literalParts: string[] = [];
  let cursor = 0;
  for (const match of pattern.matchAll(PATH_PARAM_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) literalParts.push(JSON.stringify(pattern.slice(cursor, index)));
    const name = match[1];
    params.push({ name, identifier: name });
    literalParts.push(`encodeURIComponent(${name})`);
    cursor = index + match[0].length;
  }
  if (cursor < pattern.length) literalParts.push(JSON.stringify(pattern.slice(cursor)));
  const literal = literalParts.length === 0 ? JSON.stringify(pattern) : literalParts.join(" + ");
  return { params, literal };
}

function resolveOptionsFields(schema: JsonSchema): ResolvedOptionsField[] {
  const props = (schema as { properties?: Record<string, JsonSchema> }).properties;
  if (!props) return [];
  const fields: ResolvedOptionsField[] = [];
  for (const [key, propSchema] of Object.entries(props)) {
    const description =
      typeof (propSchema as { description?: unknown }).description === "string"
        ? (propSchema as { description: string }).description
        : undefined;
    const type = jsonSchemaToTs(propSchema as JsonSchema, 0);
    const propType = (propSchema as { type?: unknown }).type;
    let encoder: ResolvedOptionsField["encoder"] = "appendString";
    if (propType === "boolean") encoder = "appendBool";
    else if (propType === "number" || propType === "integer") encoder = "appendNumber";
    fields.push({ key, identifier: key, type, encoder, description });
  }
  return fields;
}

function resolveChannel(channel: StreamChannel): ResolvedChannel {
  const meta = channel.meta;
  const { params, literal } = resolvePathParams(meta.pathPattern);
  return {
    meta,
    pathParams: params,
    pathLiteral: literal,
    optionsTypeName: meta.optionsTypeName ?? defaultOptionsTypeName(meta.methodName),
    payloadTypeName: meta.payloadTypeName ?? defaultPayloadTypeName(meta.methodName),
    optionsFields: resolveOptionsFields(meta.optionsSchema),
    payloadType: jsonSchemaToTs(meta.payloadSchema as JsonSchema, 0),
  };
}

function defaultOptionsTypeName(methodName: string): string {
  return `${methodName[0]?.toUpperCase() ?? ""}${methodName.slice(1)}StreamOptions`;
}

function defaultPayloadTypeName(methodName: string): string {
  return `${methodName[0]?.toUpperCase() ?? ""}${methodName.slice(1)}StreamPayload`;
}

function emitOptionsType(resolved: ResolvedChannel): string {
  const lines: string[] = [];
  lines.push(`export interface ${resolved.optionsTypeName} {`);
  for (const field of resolved.optionsFields) {
    if (field.description) lines.push(`  /** ${field.description} */`);
    lines.push(`  ${field.identifier}?: ${field.type};`);
  }
  lines.push(`  signal?: AbortSignal;`);
  lines.push(`}`);
  return lines.join("\n");
}

function emitPayloadType(resolved: ResolvedChannel): string {
  return `export type ${resolved.payloadTypeName} = ${resolved.payloadType};`;
}

function emitMethod(resolved: ResolvedChannel): string {
  const params = [
    ...resolved.pathParams.map((p) => `${p.identifier}: string`),
    `options: ${resolved.optionsTypeName} = {}`,
  ];
  const lines: string[] = [];
  if (resolved.meta.description) {
    lines.push("  /**");
    for (const docLine of resolved.meta.description.split(/\n/)) {
      lines.push(`   * ${docLine}`);
    }
    lines.push("   */");
  }
  lines.push(
    `  ${resolved.meta.methodName}(${params.join(", ")}): AsyncIterable<RaviSseEvent<${resolved.payloadTypeName}>> {`,
  );
  lines.push(`    const params = new URLSearchParams();`);
  for (const field of resolved.optionsFields) {
    lines.push(`    ${field.encoder}(params, ${JSON.stringify(field.key)}, options.${field.identifier});`);
  }
  lines.push(`    return this.stream<${resolved.payloadTypeName}>(${resolved.pathLiteral}, params, options.signal);`);
  lines.push(`  }`);
  return lines.join("\n");
}

function emitClient(resolveds: ResolvedChannel[]): string {
  const methods = resolveds.map(emitMethod).join("\n\n");
  return `export class RaviStreamClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: StreamClientConfig) {
    this.baseUrl = stripTrailingSlash(config.baseUrl);
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "RaviStreamClient: no global \`fetch\` available. Pass \`config.fetch\` explicitly when running in a stripped-down runtime.",
      );
    }
  }

${methods}

  private async *stream<TData>(
    channelPath: string,
    params: URLSearchParams,
    signal?: AbortSignal,
  ): AsyncIterable<RaviSseEvent<TData>> {
    const suffix = params.toString();
    const url = \`\${this.baseUrl}/api/v1/_stream/\${channelPath}\${suffix ? \`?\${suffix}\` : ""}\`;
    const response = await this.fetchStream(url, signal);
    yield* parseSse<TData>(response.body);
  }

  private async fetchStream(url: string, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: \`Bearer \${this.config.contextKey}\`,
          "x-ravi-sdk-version": SDK_VERSION,
          "x-ravi-registry-hash": REGISTRY_HASH,
          ...(this.config.headers ?? {}),
        },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new RaviTransportError(err instanceof Error ? err.message : "network error opening Ravi stream", err);
    }

    if (!response.ok) {
      const rawText = await safeText(response);
      throw buildErrorFromGateway(response.status, parseJson(rawText), "sdk.stream");
    }
    return response;
  }
}`;
}

interface EventPayloadEntry {
  eventName: string;
  typeName: string;
  helperName: string;
  schema: JsonSchema;
}

function collectEventPayloads(resolveds: ResolvedChannel[]): {
  perChannel: Map<string, EventPayloadEntry[]>;
  uniqueByTypeName: EventPayloadEntry[];
} {
  const perChannel = new Map<string, EventPayloadEntry[]>();
  const seenTypeNames = new Set<string>();
  const uniqueByTypeName: EventPayloadEntry[] = [];
  for (const resolved of resolveds) {
    const meta = resolved.meta;
    if (!meta.eventPayloads) continue;
    const entries: EventPayloadEntry[] = [];
    for (const [eventName, payload] of Object.entries(meta.eventPayloads)) {
      const helperName = payload.helperName ?? defaultHelperName(eventName);
      const entry: EventPayloadEntry = {
        eventName,
        typeName: payload.typeName,
        helperName,
        schema: payload.schema as JsonSchema,
      };
      entries.push(entry);
      if (!seenTypeNames.has(payload.typeName)) {
        seenTypeNames.add(payload.typeName);
        uniqueByTypeName.push(entry);
      }
    }
    perChannel.set(resolved.payloadTypeName, entries);
  }
  return { perChannel, uniqueByTypeName };
}

function defaultHelperName(eventName: string): string {
  const camel = eventName
    .replace(/[^a-zA-Z0-9]+(.)/g, (_match, ch: string) => ch.toUpperCase())
    .replace(/^(.)/, (m) => m.toLowerCase());
  return `decode${camel[0]?.toUpperCase() ?? ""}${camel.slice(1)}`;
}

function emitEventPayloadHelpers(payloadTypeName: string, entries: EventPayloadEntry[]): string {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(` * Typed decoders for the sub-events emitted by \`${payloadTypeName}\`.`);
  lines.push(" * Each helper re-decodes the raw `data` field into a concrete shape so");
  lines.push(" * callers can switch on the SSE `event` name and unwrap with confidence.");
  lines.push(" */");
  lines.push("");
  for (const entry of entries) {
    lines.push(`export function ${entry.helperName}(envelope: ${payloadTypeName}): ${entry.typeName} {`);
    lines.push(`  return envelope.data as ${entry.typeName};`);
    lines.push(`}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n$/, "");
}

export function emitStreaming(channels: StreamChannel[]): string {
  const resolveds = channels.map(resolveChannel);
  const sections: string[] = [HEADER, "", STATIC_PRELUDE];

  // Options types (always unique by `optionsTypeName`).
  const seenOptions = new Set<string>();
  for (const resolved of resolveds) {
    if (seenOptions.has(resolved.optionsTypeName)) continue;
    seenOptions.add(resolved.optionsTypeName);
    sections.push(emitOptionsType(resolved));
    sections.push("");
  }

  // Payload types — multiple channels can share a payload type name (e.g.
  // `events` and `audit` both surface `GatewayTopicEvent`). Emit each name
  // once, with the schema of the first channel that declared it.
  const seenPayloads = new Set<string>();
  for (const resolved of resolveds) {
    if (seenPayloads.has(resolved.payloadTypeName)) continue;
    seenPayloads.add(resolved.payloadTypeName);
    sections.push(emitPayloadType(resolved));
    sections.push("");
  }

  // Sub-payload types per declared SSE event (Phase 3). Same dedupe rule.
  const { perChannel, uniqueByTypeName } = collectEventPayloads(resolveds);
  for (const entry of uniqueByTypeName) {
    sections.push(`export type ${entry.typeName} = ${jsonSchemaToTs(entry.schema, 0)};`);
    sections.push("");
  }

  sections.push(emitClient(resolveds));
  sections.push("");

  // Decoder helpers per payload type that has declared sub-events. Emitted
  // as standalone functions so Skip / tree-shakers can drop them when
  // unused.
  for (const [payloadTypeName, entries] of perChannel) {
    sections.push(emitEventPayloadHelpers(payloadTypeName, entries));
    sections.push("");
  }

  sections.push(STATIC_EPILOGUE);
  return ensureTrailingNewline(sections.join("\n"));
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}
