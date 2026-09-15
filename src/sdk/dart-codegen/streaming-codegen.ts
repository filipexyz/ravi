/**
 * Emit `packages/ravi-os-dart-sdk/lib/src/ravi_streaming.generated.dart`
 * from the declarative channel metadata in
 * `src/sdk/gateway/streaming/channels.ts`.
 *
 * Determinism: channels are walked in registry order; schema properties are
 * walked in declaration order.
 */

import type { StreamChannel, StreamChannelMeta } from "../gateway/streaming/types.js";

const HEADER = [
  "// GENERATED FILE - DO NOT EDIT.",
  "// Run `ravi sdk dart generate` to regenerate.",
  "// Drift is detected by `ravi sdk dart check`.",
].join("\n");

const STATIC_PRELUDE = `import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'ravi_error.dart';
import 'ravi_json.dart';
import 'ravi_version.generated.dart';

class RaviSseEvent<T> {
  const RaviSseEvent({
    this.id,
    required this.event,
    required this.data,
  });

  final String? id;
  final String event;
  final T data;
}
`;

const STATIC_EPILOGUE = `class RaviSseParser<T> {
  RaviSseParser(this.decode);

  final T Function(Object? json) decode;
  String _eventName = 'message';
  String? _eventId;
  final List<String> _dataLines = <String>[];

  RaviSseEvent<T>? feedLine(String rawLine) {
    final line = rawLine.endsWith('\\r') ? rawLine.substring(0, rawLine.length - 1) : rawLine;
    if (line.isEmpty) {
      return _flush();
    }
    if (line.startsWith(':')) {
      return null;
    }
    final parts = _splitSseField(line);
    switch (parts.field) {
      case 'event':
        _eventName = parts.value.isEmpty ? 'message' : parts.value;
      case 'id':
        _eventId = parts.value;
      case 'data':
        _dataLines.add(parts.value);
      default:
        break;
    }
    return null;
  }

  RaviSseEvent<T>? finish() => _flush();

  RaviSseEvent<T>? _flush() {
    if (_dataLines.isEmpty) {
      _eventName = 'message';
      _eventId = null;
      return null;
    }
    final raw = _dataLines.join('\\n');
    Object? parsed;
    try {
      parsed = jsonDecode(raw);
    } on FormatException catch (error) {
      throw RaviContractError.returnShape('SSE event data is not valid JSON: \${error.message}');
    }
    final event = RaviSseEvent<T>(
      id: _eventId,
      event: _eventName,
      data: decode(parsed),
    );
    _eventName = 'message';
    _eventId = null;
    _dataLines.clear();
    return event;
  }
}

class _SseField {
  const _SseField(this.field, this.value);
  final String field;
  final String value;
}

_SseField _splitSseField(String line) {
  final colon = line.indexOf(':');
  if (colon == -1) {
    return _SseField(line, '');
  }
  var value = line.substring(colon + 1);
  if (value.startsWith(' ')) {
    value = value.substring(1);
  }
  return _SseField(line.substring(0, colon), value);
}

void _appendString(Map<String, String> query, String name, String? value) {
  final trimmed = value?.trim();
  if (trimmed == null || trimmed.isEmpty) return;
  query[name] = trimmed;
}

void _appendDouble(Map<String, String> query, String name, double? value) {
  if (value == null || value.isNaN || value.isInfinite) return;
  query[name] = value == value.truncateToDouble() ? value.toInt().toString() : value.toString();
}

void _appendBool(Map<String, String> query, String name, bool value) {
  if (value) query[name] = '1';
}

String _percentEncodePathSegment(String value) {
  return Uri.encodeComponent(value);
}
`;

interface ResolvedField {
  key: string;
  identifier: string;
  dartType: string;
  defaultExpr: string;
  encoder: "appendString" | "appendDouble" | "appendBool" | null;
  description?: string;
  required: boolean;
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
  return { params, expr: `[${segments.join(", ")}]` };
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
    let dartType: string;
    let encoder: ResolvedField["encoder"] = "appendString";
    let defaultExpr: string;
    switch (t) {
      case "boolean":
        dartType = "bool";
        defaultExpr = " = false";
        encoder = "appendBool";
        break;
      case "number":
      case "integer":
        dartType = "double?";
        defaultExpr = "";
        encoder = "appendDouble";
        break;
      default:
        dartType = "String?";
        defaultExpr = "";
        encoder = "appendString";
    }
    fields.push({
      key,
      identifier: key,
      dartType,
      defaultExpr,
      encoder,
      description,
      required: false,
    });
  }
  return fields;
}

function isAdditionalPropertiesPassthrough(schema: Record<string, unknown>): boolean {
  const value = (schema as { additionalProperties?: unknown }).additionalProperties;
  if (value === undefined) return false;
  if (value === false) return false;
  return true;
}

function dartTypeForSchema(propSchema: Record<string, unknown>): string {
  const t = describeJsonType(propSchema);
  switch (t) {
    case "boolean":
      return "bool";
    case "integer":
      return "int";
    case "number":
      return "double";
    case "string":
      return "String";
    case "array": {
      const items = (propSchema as { items?: Record<string, unknown> }).items;
      if (items && typeof items === "object" && !Array.isArray(items)) {
        return `List<${dartTypeForSchema(items)}>`;
      }
      return "List<RaviJson>";
    }
    case "object":
      return "RaviJson";
    default:
      return "RaviJson";
  }
}

function resolvePayloadFields(schema: Record<string, unknown>): ResolvedField[] {
  const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties;
  if (!props) return [];
  const required = new Set(((schema as { required?: string[] }).required ?? []) as string[]);
  const fields: ResolvedField[] = [];
  for (const [key, propSchema] of Object.entries(props)) {
    const description = typeof propSchema.description === "string" ? propSchema.description : undefined;
    const base = dartTypeForSchema(propSchema);
    const isRequired = required.has(key);
    fields.push({
      key,
      identifier: key,
      dartType: isRequired ? base : `${base}?`,
      defaultExpr: isRequired ? "" : "",
      encoder: null,
      description,
      required: isRequired,
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

function emitOptionsClass(resolved: ResolvedChannel): string {
  const lines: string[] = [];
  lines.push(`class ${resolved.optionsTypeName} {`);
  if (resolved.optionsFields.length === 0) {
    lines.push(`  const ${resolved.optionsTypeName}();`);
  } else {
    const initArgs = resolved.optionsFields.map((f) => {
      if (f.dartType === "bool") return `this.${f.identifier} = false`;
      return `this.${f.identifier}`;
    });
    lines.push(`  const ${resolved.optionsTypeName}({${initArgs.join(", ")}});`);
    lines.push("");
    for (const f of resolved.optionsFields) {
      if (f.description) lines.push(`  /// ${f.description}`);
      lines.push(`  final ${f.dartType} ${f.identifier};`);
    }
  }
  lines.push(`}`);
  return lines.join("\n");
}

function decodeExprForField(dartType: string, expr: string): string {
  const base = dartType.endsWith("?") ? dartType.slice(0, -1) : dartType;
  switch (base) {
    case "String":
      return `raviJsonAsString(${expr})`;
    case "bool":
      return `raviJsonAsBool(${expr})`;
    case "int":
      return `raviJsonAsInt(${expr})`;
    case "double":
      return `raviJsonAsDouble(${expr})`;
    case "RaviJson":
      return `RaviJson.from(${expr})`;
    case "List<RaviJson>":
      return `raviJsonAsList(${expr}, RaviJson.from)`;
    default:
      if (base.startsWith("List<")) return `raviJsonAsList(${expr}, RaviJson.from)`;
      return `RaviJson.from(${expr})`;
  }
}

function emitStructClass(typeName: string, fields: ResolvedField[], additionalProperties: boolean): string {
  const lines: string[] = [];
  if (fields.length === 0 && !additionalProperties) {
    return `typedef ${typeName} = RaviJson;\n\n${typeName} ${camelDecode(typeName)}(Object? json) => RaviJson.from(json);`;
  }
  lines.push(`class ${typeName} {`);
  const initArgs = fields.map((f) => (f.required ? `required this.${f.identifier}` : `this.${f.identifier}`));
  if (additionalProperties) initArgs.push("this.extraFields = const {}");
  lines.push(`  const ${typeName}({${initArgs.join(", ")}});`);
  lines.push("");
  for (const f of fields) {
    if (f.description) lines.push(`  /// ${f.description}`);
    lines.push(`  final ${f.dartType} ${f.identifier};`);
  }
  if (additionalProperties) {
    lines.push("");
    lines.push("  /// Extra fields the upstream payload may carry beyond the declared ones.");
    lines.push("  final Map<String, RaviJson> extraFields;");
  }
  lines.push("");
  lines.push(`  factory ${typeName}.fromJson(Map<String, Object?> json) {`);
  if (additionalProperties) {
    const declared = fields.map((f) => JSON.stringify(f.key));
    lines.push(
      `    final extraFields = <String, RaviJson>{`,
      `      for (final entry in json.entries)`,
      `        if (!const {${declared.join(", ")}}.contains(entry.key)) entry.key: RaviJson.from(entry.value),`,
      `    };`,
    );
  }
  lines.push(`    return ${typeName}(`);
  for (const f of fields) {
    const lookup = `json[${JSON.stringify(f.key)}]`;
    if (f.required) {
      lines.push(`      ${f.identifier}: ${decodeExprForField(f.dartType, lookup)},`);
    } else {
      lines.push(`      ${f.identifier}: ${lookup} == null ? null : ${decodeExprForField(f.dartType, lookup)},`);
    }
  }
  if (additionalProperties) lines.push("      extraFields: extraFields,");
  lines.push("    );");
  lines.push("  }");
  lines.push("");
  lines.push(`  static ${typeName} fromJsonValue(Object? json) {`);
  lines.push(`    return ${typeName}.fromJson(raviJsonObject(json, ${JSON.stringify(typeName)}));`);
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push(`${typeName} ${camelDecode(typeName)}(Object? json) => ${typeName}.fromJsonValue(json);`);
  return lines.join("\n");
}

function camelDecode(typeName: string): string {
  return `${typeName[0]?.toLowerCase() ?? ""}${typeName.slice(1)}FromJson`;
}

function emitDecodeHelper(payloadTypeName: string, sub: ResolvedSubPayload): string {
  return [
    `extension ${payloadTypeName}${sub.typeName}Decoding on ${payloadTypeName} {`,
    `  /// Decode the raw \`data\` field as a \`${sub.typeName}\` — use when the SSE \`event\` name is "${sub.eventName}".`,
    `  ${sub.typeName} ${sub.helperName}() {`,
    `    return ${sub.typeName}.fromJsonValue(data.toJson());`,
    `  }`,
    `}`,
  ].join("\n");
}

function emitMethod(resolved: ResolvedChannel): string {
  const lines: string[] = [];
  if (resolved.meta.description) {
    lines.push("  ///");
    for (const docLine of resolved.meta.description.split(/\n/)) {
      lines.push(`  /// ${docLine}`);
    }
    lines.push("  ///");
  }
  const pathArgs = resolved.pathParams.map((p) => `String ${p.name}`);
  const optionsDefault = `const ${resolved.optionsTypeName}()`;
  const sigArgs = [...pathArgs, `[${resolved.optionsTypeName} options = ${optionsDefault}]`];
  const decodeName = camelDecode(resolved.payloadTypeName);
  lines.push(
    `  Stream<RaviSseEvent<${resolved.payloadTypeName}>> ${resolved.meta.methodName}(${sigArgs.join(", ")}) {`,
  );
  if (resolved.optionsFields.length > 0) {
    lines.push("    final query = <String, String>{};");
    for (const f of resolved.optionsFields) {
      const argName = JSON.stringify(f.key);
      const ref = `options.${f.identifier}`;
      if (f.encoder === "appendBool") {
        lines.push(`    _appendBool(query, ${argName}, ${ref});`);
      } else if (f.encoder === "appendDouble") {
        lines.push(`    _appendDouble(query, ${argName}, ${ref});`);
      } else {
        lines.push(`    _appendString(query, ${argName}, ${ref});`);
      }
    }
    lines.push(`    return _stream(pathSegments: ${resolved.pathExpr}, query: query, decode: ${decodeName});`);
  } else {
    lines.push(`    return _stream(pathSegments: ${resolved.pathExpr}, query: const {}, decode: ${decodeName});`);
  }
  lines.push("  }");
  return lines.join("\n");
}

function emitClient(resolveds: ResolvedChannel[]): string {
  const methods = resolveds.map(emitMethod).join("\n\n");
  return `class RaviStreamClient {
  RaviStreamClient({
    required this.baseUrl,
    required this.contextKey,
    http.Client? client,
    this.headers = const {},
  }) : _client = client ?? http.Client(),
       _ownsClient = client == null;

  final Uri baseUrl;
  final String contextKey;
  final Map<String, String> headers;
  final http.Client _client;
  final bool _ownsClient;

${methods}

  void close() {
    if (_ownsClient) _client.close();
  }

  Stream<RaviSseEvent<T>> _stream<T>({
    required List<String> pathSegments,
    required Map<String, String> query,
    required T Function(Object? json) decode,
  }) async* {
    final request = http.Request('GET', _streamUrl(pathSegments, query));
    request.headers.addAll({
      'accept': 'text/event-stream',
      'authorization': 'Bearer $contextKey',
      'x-ravi-sdk-version': raviSdkVersion,
      'x-ravi-registry-hash': raviRegistryHash,
      ...headers,
    });

    late final http.StreamedResponse response;
    try {
      response = await _client.send(request);
    } catch (error) {
      throw RaviTransportError('network error opening Ravi stream', cause: error);
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      final body = await response.stream.bytesToString();
      throw buildRaviError(statusCode: response.statusCode, body: body, command: 'sdk.stream');
    }

    final parser = RaviSseParser<T>(decode);
    var buffer = '';
    await for (final chunk in response.stream.transform(utf8.decoder)) {
      buffer += chunk.replaceAll('\\r\\n', '\\n').replaceAll('\\r', '\\n');
      var newline = buffer.indexOf('\\n');
      while (newline != -1) {
        final line = buffer.substring(0, newline);
        buffer = buffer.substring(newline + 1);
        final event = parser.feedLine(line);
        if (event != null) yield event;
        newline = buffer.indexOf('\\n');
      }
    }
    if (buffer.isNotEmpty) {
      final event = parser.feedLine(buffer);
      if (event != null) yield event;
    }
    final tail = parser.finish();
    if (tail != null) yield tail;
  }

  Uri _streamUrl(List<String> pathSegments, Map<String, String> query) {
    final existing = baseUrl.path.replaceAll(RegExp(r'^/+|/+$'), '');
    final streamPath = ['api', 'v1', '_stream', ...pathSegments]
        .map(_percentEncodePathSegment)
        .join('/');
    final path = '/\${[existing, streamPath].where((part) => part.isNotEmpty).join('/')}';
    return baseUrl.replace(path: path, queryParameters: query.isEmpty ? null : query);
  }
}`;
}

export function emitStreamingDart(channels: StreamChannel[]): string {
  const resolveds = channels.map(resolveChannel);
  const sections: string[] = [HEADER, "", STATIC_PRELUDE];

  const seenOptions = new Set<string>();
  for (const r of resolveds) {
    if (seenOptions.has(r.optionsTypeName)) continue;
    seenOptions.add(r.optionsTypeName);
    sections.push(emitOptionsClass(r));
    sections.push("");
  }

  const seenPayloads = new Set<string>();
  for (const r of resolveds) {
    if (seenPayloads.has(r.payloadTypeName)) continue;
    seenPayloads.add(r.payloadTypeName);
    sections.push(emitStructClass(r.payloadTypeName, r.payloadFields, r.payloadAdditionalProperties));
    sections.push("");
  }

  const { perChannel: subsPerChannel, uniqueByTypeName: subsUnique } = resolveSubPayloads(resolveds);
  for (const sub of subsUnique) {
    sections.push(emitStructClass(sub.typeName, sub.fields, sub.additionalProperties));
    sections.push("");
  }

  sections.push(emitClient(resolveds));
  sections.push("");

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
