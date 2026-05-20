/**
 * Emit `packages/ravi-os-swift-sdk/Sources/RaviSDK/RaviStreaming.generated.swift`
 * from the declarative channel metadata in
 * `src/sdk/gateway/streaming/channels.ts`. One method per channel, with
 * `*StreamOptions` and `*StreamPayload` structs derived from each channel's
 * JSON Schema. The static SSE plumbing (parser, transport helpers) is
 * inlined as a prelude/epilogue so the generated file is self-contained —
 * Skip transpiles plain Codable/Sendable values cleanly to Kotlin for the
 * Android target.
 *
 * Determinism: channels are walked in registry order; struct properties are
 * walked in the order declared in the JSON Schema.
 */

import type { StreamChannel, StreamChannelMeta } from "../gateway/streaming/types.js";

const HEADER = [
  "// GENERATED FILE - DO NOT EDIT.",
  "// Run `ravi sdk swift generate` to regenerate.",
  "// Drift is detected by `ravi sdk swift check`.",
].join("\n");

const STATIC_PRELUDE = `import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct RaviSseEvent<Data: Decodable & Sendable>: Sendable {
  public let id: String?
  public let event: String
  public let data: Data

  public init(id: String? = nil, event: String, data: Data) {
    self.id = id
    self.event = event
    self.data = data
  }
}
`;

const STATIC_EPILOGUE = `public struct RaviSseParser<T: Decodable & Sendable> {
  private var eventName = "message"
  private var eventId: String?
  private var dataLines: [String] = []
  private let decoder: JSONDecoder
  private let dataType: T.Type

  public init(dataType: T.Type = T.self, decoder: JSONDecoder = JSONDecoder()) {
    self.dataType = dataType
    self.decoder = decoder
  }

  public mutating func feedLine(_ rawLine: String) throws -> RaviSseEvent<T>? {
    let line = rawLine.hasSuffix("\\r") ? String(rawLine.dropLast()) : rawLine
    if line.isEmpty {
      return try flush()
    }
    if line.hasPrefix(":") {
      return nil
    }
    let parts = splitSseField(line)
    switch parts.field {
    case "event":
      eventName = parts.value.isEmpty ? "message" : parts.value
    case "id":
      eventId = parts.value
    case "data":
      dataLines.append(parts.value)
    default:
      break
    }
    return nil
  }

  public mutating func finish() throws -> RaviSseEvent<T>? {
    try flush()
  }

  private mutating func flush() throws -> RaviSseEvent<T>? {
    if dataLines.isEmpty {
      eventName = "message"
      eventId = nil
      return nil
    }
    let raw = dataLines.joined(separator: "\\n")
    guard let data = raw.data(using: .utf8) else {
      throw RaviError.decoding(message: "SSE event data is not valid UTF-8")
    }
    do {
      let decoded = try decoder.decode(dataType, from: data)
      let event = RaviSseEvent(id: eventId, event: eventName, data: decoded)
      eventName = "message"
      eventId = nil
      dataLines = []
      return event
    } catch {
      throw RaviError.decoding(message: error.localizedDescription)
    }
  }
}

private struct DynamicCodingKey: CodingKey, Hashable {
  let stringValue: String
  let intValue: Int?

  init(_ stringValue: String) {
    self.stringValue = stringValue
    self.intValue = nil
  }

  init?(stringValue: String) {
    self.init(stringValue)
  }

  init?(intValue: Int) {
    self.stringValue = String(intValue)
    self.intValue = intValue
  }
}

private func appendString(_ queryItems: inout [URLQueryItem], _ name: String, _ value: String?) {
  guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
    return
  }
  queryItems.append(URLQueryItem(name: name, value: value))
}

private func appendDouble(_ queryItems: inout [URLQueryItem], _ name: String, _ value: Double?) {
  guard let value = value, value.isFinite else { return }
  if value.rounded(.towardZero) == value {
    queryItems.append(URLQueryItem(name: name, value: String(Int(value))))
  } else {
    queryItems.append(URLQueryItem(name: name, value: String(value)))
  }
}

private func appendBool(_ queryItems: inout [URLQueryItem], _ name: String, _ value: Bool) {
  if value {
    queryItems.append(URLQueryItem(name: name, value: "1"))
  }
}

private func percentEncodePathSegment(_ value: String) -> String {
  var allowed = CharacterSet.urlPathAllowed
  allowed.remove(charactersIn: "/")
  return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}

private func splitSseField(_ line: String) -> (field: String, value: String) {
  guard let colon = line.firstIndex(of: ":") else {
    return (line, "")
  }
  let field = String(line[..<colon])
  var value = String(line[line.index(after: colon)...])
  if value.hasPrefix(" ") {
    value.removeFirst()
  }
  return (field, value)
}

private func readData(from bytes: URLSession.AsyncBytes) async throws -> Data {
  var data = Data()
  for try await byte in bytes {
    data.append(byte)
  }
  return data
}
`;

interface ResolvedField {
  /** JSON Schema property name (matches the wire). */
  key: string;
  /** Swift property name (kept identical to the JSON key — the registry
   *  already uses camelCase keys for stream channel options). */
  identifier: string;
  /** Swift type expression, including optionality / default suffix. */
  swiftType: string;
  /** Default value to emit in the synthesised init (or empty string). */
  defaultExpr: string;
  /** Encoder helper name to invoke. */
  encoder: "appendString" | "appendDouble" | "appendBool" | null;
  /** Optional doc string lifted from the JSON Schema `description`. */
  description?: string;
  /** Whether the field is required by the schema (only relevant for
   *  payload structs — options are always optional on the wire). */
  required: boolean;
  /** Raw schema JSON type (`string` / `number` / `boolean` / `object` / …). */
  schemaType: string;
}

interface ResolvedPathParam {
  name: string;
}

interface ResolvedChannel {
  meta: StreamChannelMeta;
  pathParams: ResolvedPathParam[];
  pathExpr: string;
  optionsTypeName: string;
  payloadTypeName: string;
  optionsFields: ResolvedField[];
  payloadFields: ResolvedField[];
  payloadAdditionalProperties: boolean;
}

interface ResolvedSubPayload {
  eventName: string;
  typeName: string;
  helperName: string;
  fields: ResolvedField[];
  additionalProperties: boolean;
}

function resolvePathParams(pattern: string): { params: ResolvedPathParam[]; expr: string } {
  // Build a `[String]` literal for `pathSegments` (Swift `streamURL` takes
  // an array, not a concatenated string). Each pattern segment is either a
  // static literal or `{name}` — params become positional method args.
  const params: ResolvedPathParam[] = [];
  const segments: string[] = [];
  for (const piece of pattern.split("/")) {
    const paramMatch = piece.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
    if (paramMatch) {
      params.push({ name: paramMatch[1] });
      segments.push(paramMatch[1]);
    } else {
      segments.push(JSON.stringify(piece));
    }
  }
  const expr = `[${segments.join(", ")}]`;
  return { params, expr };
}

function describeJsonType(propSchema: Record<string, unknown>): string {
  const t = propSchema.type;
  return typeof t === "string" ? t : "";
}

function resolveOptionsFields(schema: Record<string, unknown>): ResolvedField[] {
  const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
  if (!props) return [];
  const fields: ResolvedField[] = [];
  for (const [key, propSchema] of Object.entries(props)) {
    const description = typeof propSchema.description === "string" ? propSchema.description : undefined;
    const t = describeJsonType(propSchema);
    let swiftType: string;
    let encoder: ResolvedField["encoder"] = "appendString";
    let defaultExpr: string;
    switch (t) {
      case "boolean":
        swiftType = "Bool";
        defaultExpr = " = false";
        encoder = "appendBool";
        break;
      case "number":
      case "integer":
        swiftType = "Double?";
        defaultExpr = " = nil";
        encoder = "appendDouble";
        break;
      default:
        swiftType = "String?";
        defaultExpr = " = nil";
        encoder = "appendString";
    }
    fields.push({
      key,
      identifier: key,
      swiftType,
      defaultExpr,
      encoder,
      description,
      required: false,
      schemaType: t,
    });
  }
  return fields;
}

function isAdditionalPropertiesPassthrough(schema: Record<string, unknown>): boolean {
  const value = (schema as { additionalProperties?: unknown }).additionalProperties;
  if (value === undefined) return false;
  if (value === false) return false;
  // `true`, `{}`, or any nested schema all mean "accept any extra keys" for
  // the purpose of the typed struct — we expose them as `[String: RaviJSON]`.
  return true;
}

function swiftTypeForSchema(propSchema: Record<string, unknown>): string {
  const t = describeJsonType(propSchema);
  switch (t) {
    case "boolean":
      return "Bool";
    case "integer":
      return "Int";
    case "number":
      return "Double";
    case "string":
      return "String";
    case "array": {
      const items = (propSchema as { items?: Record<string, unknown> }).items;
      if (items && typeof items === "object" && !Array.isArray(items)) {
        return `[${swiftTypeForSchema(items)}]`;
      }
      return "[RaviJSON]";
    }
    case "object": {
      // Object with declared properties → too rich for a nested generated
      // struct in this pass; surface as RaviJSON to keep the helper-decoder
      // story simple. Callers can pull typed access from the sub-payload
      // schema directly when needed.
      return "RaviJSON";
    }
    default:
      return "RaviJSON";
  }
}

function resolvePayloadFields(schema: Record<string, unknown>): ResolvedField[] {
  const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
  if (!props) return [];
  const required = new Set(((schema as { required?: string[] }).required ?? []) as string[]);
  const fields: ResolvedField[] = [];
  for (const [key, propSchema] of Object.entries(props)) {
    const description = typeof propSchema.description === "string" ? propSchema.description : undefined;
    const t = describeJsonType(propSchema);
    const base = swiftTypeForSchema(propSchema);
    const isRequired = required.has(key);
    const swiftType = isRequired ? base : `${base}?`;
    fields.push({
      key,
      identifier: key,
      swiftType,
      defaultExpr: isRequired ? "" : " = nil",
      encoder: null,
      description,
      required: isRequired,
      schemaType: t,
    });
  }
  return fields;
}

function resolveChannel(channel: StreamChannel): ResolvedChannel {
  const meta = channel.meta;
  const { params, expr } = resolvePathParams(meta.pathPattern);
  return {
    meta,
    pathParams: params,
    pathExpr: expr,
    optionsTypeName: meta.optionsTypeName ?? defaultOptionsTypeName(meta.methodName),
    payloadTypeName: meta.payloadTypeName ?? defaultPayloadTypeName(meta.methodName),
    optionsFields: resolveOptionsFields(meta.optionsSchema),
    payloadFields: resolvePayloadFields(meta.payloadSchema),
    payloadAdditionalProperties: isAdditionalPropertiesPassthrough(meta.payloadSchema),
  };
}

function defaultHelperName(eventName: string): string {
  const camel = eventName
    .replace(/[^a-zA-Z0-9]+(.)/g, (_match, ch: string) => ch.toUpperCase())
    .replace(/^(.)/, (m) => m.toLowerCase());
  return `decode${camel[0]?.toUpperCase() ?? ""}${camel.slice(1)}`;
}

function resolveSubPayloads(channels: ResolvedChannel[]): {
  perChannel: Map<string, ResolvedSubPayload[]>;
  uniqueByTypeName: ResolvedSubPayload[];
} {
  const perChannel = new Map<string, ResolvedSubPayload[]>();
  const seen = new Set<string>();
  const uniqueByTypeName: ResolvedSubPayload[] = [];
  for (const resolved of channels) {
    const meta = resolved.meta;
    if (!meta.eventPayloads) continue;
    const entries: ResolvedSubPayload[] = [];
    for (const [eventName, payload] of Object.entries(meta.eventPayloads)) {
      const helperName = payload.helperName ?? defaultHelperName(eventName);
      const entry: ResolvedSubPayload = {
        eventName,
        typeName: payload.typeName,
        helperName,
        fields: resolvePayloadFields(payload.schema as Record<string, unknown>),
        additionalProperties: isAdditionalPropertiesPassthrough(payload.schema as Record<string, unknown>),
      };
      entries.push(entry);
      if (!seen.has(payload.typeName)) {
        seen.add(payload.typeName);
        uniqueByTypeName.push(entry);
      }
    }
    perChannel.set(resolved.payloadTypeName, entries);
  }
  return { perChannel, uniqueByTypeName };
}

function defaultOptionsTypeName(methodName: string): string {
  return `${methodName[0]?.toUpperCase() ?? ""}${methodName.slice(1)}StreamOptions`;
}

function defaultPayloadTypeName(methodName: string): string {
  return `${methodName[0]?.toUpperCase() ?? ""}${methodName.slice(1)}StreamPayload`;
}

function emitOptionsStruct(resolved: ResolvedChannel): string {
  const lines: string[] = [];
  lines.push(`public struct ${resolved.optionsTypeName}: Sendable {`);
  for (const f of resolved.optionsFields) {
    if (f.description) lines.push(`  /// ${f.description}`);
    lines.push(`  public var ${f.identifier}: ${f.swiftType}`);
  }
  // Init
  if (resolved.optionsFields.length === 0) {
    lines.push(`  public init() {}`);
  } else {
    const initArgs = resolved.optionsFields.map((f) => `${f.identifier}: ${f.swiftType}${f.defaultExpr}`);
    lines.push(`  public init(`);
    lines.push("    " + initArgs.join(",\n    "));
    lines.push(`  ) {`);
    for (const f of resolved.optionsFields) {
      lines.push(`    self.${f.identifier} = ${f.identifier}`);
    }
    lines.push(`  }`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

function emitStructBody(typeName: string, fields: ResolvedField[], additionalProperties: boolean): string {
  const lines: string[] = [];
  // Fall back to RaviJSON only when nothing is declared (rare in practice).
  if (fields.length === 0 && !additionalProperties) {
    lines.push(`public typealias ${typeName} = RaviJSON`);
    return lines.join("\n");
  }
  lines.push(`public struct ${typeName}: Decodable, Sendable {`);
  for (const f of fields) {
    if (f.description) lines.push(`  /// ${f.description}`);
    lines.push(`  public let ${f.identifier}: ${f.swiftType}`);
  }
  if (additionalProperties) {
    lines.push("");
    lines.push(`  /// Extra fields the upstream payload may carry beyond the declared ones.`);
    lines.push(`  /// Keys are walked through dynamic decoding so the wire shape is preserved.`);
    lines.push(`  public let extraFields: [String: RaviJSON]`);
  }
  lines.push("");

  // Designated init.
  const initArgs = fields.map((f) => `${f.identifier}: ${f.swiftType}${f.defaultExpr}`);
  if (additionalProperties) initArgs.push(`extraFields: [String: RaviJSON] = [:]`);
  if (initArgs.length === 0) {
    lines.push(`  public init() {}`);
  } else {
    lines.push(`  public init(`);
    lines.push("    " + initArgs.join(",\n    "));
    lines.push(`  ) {`);
    for (const f of fields) lines.push(`    self.${f.identifier} = ${f.identifier}`);
    if (additionalProperties) lines.push(`    self.extraFields = extraFields`);
    lines.push(`  }`);
  }

  // Custom Decodable when additionalProperties is on — Swift's synthesised
  // decoder ignores unknown keys; we need to collect them into `extraFields`.
  if (additionalProperties) {
    const declaredKeys = fields.map((f) => f.key);
    lines.push("");
    lines.push(`  public init(from decoder: Decoder) throws {`);
    lines.push(`    let container = try decoder.container(keyedBy: DynamicCodingKey.self)`);
    for (const f of fields) {
      const keyExpr = `DynamicCodingKey(${JSON.stringify(f.key)})`;
      if (f.required) {
        lines.push(
          `    self.${f.identifier} = try container.decode(${baseType(f.swiftType)}.self, forKey: ${keyExpr})`,
        );
      } else {
        lines.push(
          `    self.${f.identifier} = try container.decodeIfPresent(${baseType(f.swiftType)}.self, forKey: ${keyExpr})`,
        );
      }
    }
    lines.push(`    var extras: [String: RaviJSON] = [:]`);
    if (declaredKeys.length > 0) {
      lines.push(`    let declared: Set<String> = [${declaredKeys.map((k) => JSON.stringify(k)).join(", ")}]`);
      lines.push(`    for key in container.allKeys where !declared.contains(key.stringValue) {`);
    } else {
      lines.push(`    for key in container.allKeys {`);
    }
    lines.push(`      extras[key.stringValue] = try container.decode(RaviJSON.self, forKey: key)`);
    lines.push(`    }`);
    lines.push(`    self.extraFields = extras`);
    lines.push(`  }`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

function baseType(swiftType: string): string {
  // Strip a single trailing `?` to recover the non-optional base for
  // `decode(...)` / `decodeIfPresent(...)` calls.
  return swiftType.endsWith("?") ? swiftType.slice(0, -1) : swiftType;
}

function emitPayloadStruct(resolved: ResolvedChannel): string {
  return emitStructBody(resolved.payloadTypeName, resolved.payloadFields, resolved.payloadAdditionalProperties);
}

function emitSubPayloadStruct(sub: ResolvedSubPayload): string {
  return emitStructBody(sub.typeName, sub.fields, sub.additionalProperties);
}

function emitDecodeHelper(payloadTypeName: string, sub: ResolvedSubPayload): string {
  // The raw payload's `data` field (the RaviJSON envelope) gets re-encoded
  // back to bytes, then decoded as the typed sub-struct. Costs one JSON
  // round-trip per event; readable and dependency-free.
  return [
    `public extension ${payloadTypeName} {`,
    `  /// Decode the raw \`data\` field as a \`${sub.typeName}\` — use when the SSE \`event\` name is "${sub.eventName}".`,
    `  func ${sub.helperName}() throws -> ${sub.typeName} {`,
    `    let bytes = try JSONEncoder().encode(self.data)`,
    `    return try JSONDecoder().decode(${sub.typeName}.self, from: bytes)`,
    `  }`,
    `}`,
  ].join("\n");
}

function emitMethod(resolved: ResolvedChannel): string {
  const lines: string[] = [];
  if (resolved.meta.description) {
    for (const docLine of resolved.meta.description.split(/\n/)) {
      lines.push(`  /// ${docLine}`);
    }
  }
  // Signature
  const pathArgs = resolved.pathParams.map((p) => `_ ${p.name}: String`);
  const sigArgs = [...pathArgs, `options: ${resolved.optionsTypeName} = .init()`];
  lines.push(
    `  public func ${resolved.meta.methodName}(${sigArgs.join(", ")}) -> AsyncThrowingStream<RaviSseEvent<${resolved.payloadTypeName}>, Error> {`,
  );

  // Body: build query items if any optional fields
  if (resolved.optionsFields.length > 0) {
    lines.push(`    var queryItems: [URLQueryItem] = []`);
    for (const f of resolved.optionsFields) {
      const argName = JSON.stringify(f.key);
      const ref = `options.${f.identifier}`;
      lines.push(`    ${f.encoder}(&queryItems, ${argName}, ${ref})`);
    }
    lines.push(
      `    return stream(pathSegments: ${resolved.pathExpr}, queryItems: queryItems, as: ${resolved.payloadTypeName}.self)`,
    );
  } else {
    lines.push(
      `    return stream(pathSegments: ${resolved.pathExpr}, queryItems: [], as: ${resolved.payloadTypeName}.self)`,
    );
  }
  lines.push(`  }`);
  return lines.join("\n");
}

function emitClient(resolveds: ResolvedChannel[]): string {
  const methods = resolveds.map(emitMethod).join("\n\n");
  return `public final class RaviStreamClient: @unchecked Sendable {
  private let baseURL: URL
  private let contextKey: String
  private let session: URLSession
  private let extraHeaders: [String: String]

  public init(
    baseURL: URL,
    contextKey: String,
    session: URLSession = .shared,
    headers: [String: String] = [:]
  ) {
    self.baseURL = baseURL
    self.contextKey = contextKey
    self.session = session
    self.extraHeaders = headers
  }

${methods}

  func buildStreamRequest(pathSegments: [String], queryItems: [URLQueryItem]) throws -> URLRequest {
    var request = URLRequest(url: try streamURL(pathSegments: pathSegments, queryItems: queryItems))
    request.httpMethod = "GET"
    request.setValue("text/event-stream", forHTTPHeaderField: "accept")
    request.setValue("Bearer \\(contextKey)", forHTTPHeaderField: "authorization")
    request.setValue(RAVI_SDK_VERSION, forHTTPHeaderField: "x-ravi-sdk-version")
    request.setValue(RAVI_REGISTRY_HASH, forHTTPHeaderField: "x-ravi-registry-hash")
    for (key, value) in extraHeaders {
      request.setValue(value, forHTTPHeaderField: key)
    }
    return request
  }

  private func stream<T: Decodable & Sendable>(
    pathSegments: [String],
    queryItems: [URLQueryItem],
    as type: T.Type
  ) -> AsyncThrowingStream<RaviSseEvent<T>, Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let request = try buildStreamRequest(pathSegments: pathSegments, queryItems: queryItems)
          let (bytes, response) = try await session.bytes(for: request)
          guard let http = response as? HTTPURLResponse else {
            throw RaviError.transport(message: "Ravi gateway returned a non-HTTP response")
          }
          guard (200..<300).contains(http.statusCode) else {
            let data = try await readData(from: bytes)
            throw buildRaviError(statusCode: http.statusCode, data: data)
          }

          var parser = RaviSseParser<T>(dataType: type)
          for try await rawLine in bytes.lines {
            try Task.checkCancellation()
            if let event = try parser.feedLine(rawLine) {
              continuation.yield(event)
            }
          }
          if let event = try parser.finish() {
            continuation.yield(event)
          }
          continuation.finish()
        } catch is CancellationError {
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in
        task.cancel()
      }
    }
  }

  private func streamURL(pathSegments: [String], queryItems: [URLQueryItem]) throws -> URL {
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      throw RaviError.transport(message: "Invalid Ravi stream base URL")
    }
    let existingPath = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let streamPath = (["api", "v1", "_stream"] + pathSegments).map(percentEncodePathSegment).joined(separator: "/")
    components.percentEncodedPath = "/" + [existingPath, streamPath].filter { !$0.isEmpty }.joined(separator: "/")
    components.queryItems = queryItems.isEmpty ? nil : queryItems
    guard let url = components.url else {
      throw RaviError.transport(message: "Invalid Ravi stream URL")
    }
    return url
  }
}`;
}

export function emitStreamingSwift(channels: StreamChannel[]): string {
  const resolveds = channels.map(resolveChannel);
  const sections: string[] = [HEADER, "", STATIC_PRELUDE];

  // Options structs — dedupe by `optionsTypeName`.
  const seenOptions = new Set<string>();
  for (const r of resolveds) {
    if (seenOptions.has(r.optionsTypeName)) continue;
    seenOptions.add(r.optionsTypeName);
    sections.push(emitOptionsStruct(r));
    sections.push("");
  }

  // Payload structs — dedupe by `payloadTypeName` (events + audit share
  // GatewayTopicEvent).
  const seenPayloads = new Set<string>();
  for (const r of resolveds) {
    if (seenPayloads.has(r.payloadTypeName)) continue;
    seenPayloads.add(r.payloadTypeName);
    sections.push(emitPayloadStruct(r));
    sections.push("");
  }

  // Sub-payload structs (Phase 3).
  const { perChannel: subsPerChannel, uniqueByTypeName: subsUnique } = resolveSubPayloads(resolveds);
  for (const sub of subsUnique) {
    sections.push(emitSubPayloadStruct(sub));
    sections.push("");
  }

  sections.push(emitClient(resolveds));
  sections.push("");

  // Decode helpers per payload type that declared sub-events.
  for (const [payloadTypeName, entries] of subsPerChannel) {
    for (const sub of entries) {
      sections.push(emitDecodeHelper(payloadTypeName, sub));
      sections.push("");
    }
  }

  sections.push(STATIC_EPILOGUE);
  return ensureTrailingNewline(sections.join("\n"));
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}
