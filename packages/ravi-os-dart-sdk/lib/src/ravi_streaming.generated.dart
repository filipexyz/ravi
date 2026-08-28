// GENERATED FILE - DO NOT EDIT.
// Run `ravi sdk dart generate` to regenerate.
// Drift is detected by `ravi sdk dart check`.

import 'dart:async';
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

class EventsStreamOptions {
  const EventsStreamOptions({this.subject, this.filter, this.only, this.noClaude = false, this.noHeartbeat = false});

  final String? subject;
  final String? filter;
  final String? only;
  final bool noClaude;
  final bool noHeartbeat;
}

class TasksStreamOptions {
  const TasksStreamOptions({this.taskId});

  final String? taskId;
}

class SessionStreamOptions {
  const SessionStreamOptions({this.timeout});

  /// Seconds before the stream emits `event: end` and closes. `0` means no natural timeout.
  final double? timeout;
}

class ChatStreamOptions {
  const ChatStreamOptions();
}

class InstanceStreamOptions {
  const InstanceStreamOptions();
}

class AuditStreamOptions {
  const AuditStreamOptions();
}

class GatewayTopicEvent {
  const GatewayTopicEvent({required this.type, required this.topic, required this.data, this.timestamp, this.count});

  final String type;
  final String topic;
  final RaviJson data;
  final String? timestamp;
  final double? count;

  factory GatewayTopicEvent.fromJson(Map<String, Object?> json) {
    return GatewayTopicEvent(
      type: raviJsonAsString(json["type"]),
      topic: raviJsonAsString(json["topic"]),
      data: RaviJson.from(json["data"]),
      timestamp: json["timestamp"] == null ? null : raviJsonAsString(json["timestamp"]),
      count: json["count"] == null ? null : raviJsonAsDouble(json["count"]),
    );
  }

  static GatewayTopicEvent fromJsonValue(Object? json) {
    return GatewayTopicEvent.fromJson(raviJsonObject(json, "GatewayTopicEvent"));
  }
}

GatewayTopicEvent gatewayTopicEventFromJson(Object? json) => GatewayTopicEvent.fromJsonValue(json);

class TaskStreamPayload {
  const TaskStreamPayload({required this.type, required this.topic, this.extraFields = const {}});

  final RaviJson type;
  final String topic;

  /// Extra fields the upstream payload may carry beyond the declared ones.
  final Map<String, RaviJson> extraFields;

  factory TaskStreamPayload.fromJson(Map<String, Object?> json) {
    final extraFields = <String, RaviJson>{
      for (final entry in json.entries)
        if (!const {"type", "topic"}.contains(entry.key)) entry.key: RaviJson.from(entry.value),
    };
    return TaskStreamPayload(
      type: RaviJson.from(json["type"]),
      topic: raviJsonAsString(json["topic"]),
      extraFields: extraFields,
    );
  }

  static TaskStreamPayload fromJsonValue(Object? json) {
    return TaskStreamPayload.fromJson(raviJsonObject(json, "TaskStreamPayload"));
  }
}

TaskStreamPayload taskStreamPayloadFromJson(Object? json) => TaskStreamPayload.fromJsonValue(json);

class SessionStreamPayload {
  const SessionStreamPayload({required this.type, required this.sessionName, this.topic, this.data, this.reason, this.timeoutMs, this.timestamp});

  final RaviJson type;
  final String sessionName;
  final String? topic;
  final RaviJson? data;
  final String? reason;
  final double? timeoutMs;
  final String? timestamp;

  factory SessionStreamPayload.fromJson(Map<String, Object?> json) {
    return SessionStreamPayload(
      type: RaviJson.from(json["type"]),
      sessionName: raviJsonAsString(json["sessionName"]),
      topic: json["topic"] == null ? null : raviJsonAsString(json["topic"]),
      data: json["data"] == null ? null : RaviJson.from(json["data"]),
      reason: json["reason"] == null ? null : raviJsonAsString(json["reason"]),
      timeoutMs: json["timeoutMs"] == null ? null : raviJsonAsDouble(json["timeoutMs"]),
      timestamp: json["timestamp"] == null ? null : raviJsonAsString(json["timestamp"]),
    );
  }

  static SessionStreamPayload fromJsonValue(Object? json) {
    return SessionStreamPayload.fromJson(raviJsonObject(json, "SessionStreamPayload"));
  }
}

SessionStreamPayload sessionStreamPayloadFromJson(Object? json) => SessionStreamPayload.fromJsonValue(json);

class ChatStreamPayload {
  const ChatStreamPayload({required this.type, required this.chatId, required this.topic, required this.data, required this.timestamp});

  final RaviJson type;
  final String chatId;
  final String topic;
  final RaviJson data;
  final String timestamp;

  factory ChatStreamPayload.fromJson(Map<String, Object?> json) {
    return ChatStreamPayload(
      type: RaviJson.from(json["type"]),
      chatId: raviJsonAsString(json["chatId"]),
      topic: raviJsonAsString(json["topic"]),
      data: RaviJson.from(json["data"]),
      timestamp: raviJsonAsString(json["timestamp"]),
    );
  }

  static ChatStreamPayload fromJsonValue(Object? json) {
    return ChatStreamPayload.fromJson(raviJsonObject(json, "ChatStreamPayload"));
  }
}

ChatStreamPayload chatStreamPayloadFromJson(Object? json) => ChatStreamPayload.fromJsonValue(json);

class InstanceStreamPayload {
  const InstanceStreamPayload({required this.type, required this.instanceId, required this.topic, required this.data, required this.timestamp});

  final RaviJson type;
  final String instanceId;
  final String topic;
  final RaviJson data;
  final String timestamp;

  factory InstanceStreamPayload.fromJson(Map<String, Object?> json) {
    return InstanceStreamPayload(
      type: RaviJson.from(json["type"]),
      instanceId: raviJsonAsString(json["instanceId"]),
      topic: raviJsonAsString(json["topic"]),
      data: RaviJson.from(json["data"]),
      timestamp: raviJsonAsString(json["timestamp"]),
    );
  }

  static InstanceStreamPayload fromJsonValue(Object? json) {
    return InstanceStreamPayload.fromJson(raviJsonObject(json, "InstanceStreamPayload"));
  }
}

InstanceStreamPayload instanceStreamPayloadFromJson(Object? json) => InstanceStreamPayload.fromJsonValue(json);

class OmniMessageReceivedEnvelope {
  const OmniMessageReceivedEnvelope({required this.id, required this.type, required this.payload, this.metadata, required this.timestamp, this.extraFields = const {}});

  final String id;
  final String type;
  final RaviJson payload;
  final RaviJson? metadata;
  final double timestamp;

  /// Extra fields the upstream payload may carry beyond the declared ones.
  final Map<String, RaviJson> extraFields;

  factory OmniMessageReceivedEnvelope.fromJson(Map<String, Object?> json) {
    final extraFields = <String, RaviJson>{
      for (final entry in json.entries)
        if (!const {"id", "type", "payload", "metadata", "timestamp"}.contains(entry.key)) entry.key: RaviJson.from(entry.value),
    };
    return OmniMessageReceivedEnvelope(
      id: raviJsonAsString(json["id"]),
      type: raviJsonAsString(json["type"]),
      payload: RaviJson.from(json["payload"]),
      metadata: json["metadata"] == null ? null : RaviJson.from(json["metadata"]),
      timestamp: raviJsonAsDouble(json["timestamp"]),
      extraFields: extraFields,
    );
  }

  static OmniMessageReceivedEnvelope fromJsonValue(Object? json) {
    return OmniMessageReceivedEnvelope.fromJson(raviJsonObject(json, "OmniMessageReceivedEnvelope"));
  }
}

OmniMessageReceivedEnvelope omniMessageReceivedEnvelopeFromJson(Object? json) => OmniMessageReceivedEnvelope.fromJsonValue(json);

class OmniReactionReceivedEnvelope {
  const OmniReactionReceivedEnvelope({required this.id, required this.type, required this.payload, this.metadata, required this.timestamp, this.extraFields = const {}});

  final String id;
  final String type;
  final RaviJson payload;
  final RaviJson? metadata;
  final double timestamp;

  /// Extra fields the upstream payload may carry beyond the declared ones.
  final Map<String, RaviJson> extraFields;

  factory OmniReactionReceivedEnvelope.fromJson(Map<String, Object?> json) {
    final extraFields = <String, RaviJson>{
      for (final entry in json.entries)
        if (!const {"id", "type", "payload", "metadata", "timestamp"}.contains(entry.key)) entry.key: RaviJson.from(entry.value),
    };
    return OmniReactionReceivedEnvelope(
      id: raviJsonAsString(json["id"]),
      type: raviJsonAsString(json["type"]),
      payload: RaviJson.from(json["payload"]),
      metadata: json["metadata"] == null ? null : RaviJson.from(json["metadata"]),
      timestamp: raviJsonAsDouble(json["timestamp"]),
      extraFields: extraFields,
    );
  }

  static OmniReactionReceivedEnvelope fromJsonValue(Object? json) {
    return OmniReactionReceivedEnvelope.fromJson(raviJsonObject(json, "OmniReactionReceivedEnvelope"));
  }
}

OmniReactionReceivedEnvelope omniReactionReceivedEnvelopeFromJson(Object? json) => OmniReactionReceivedEnvelope.fromJsonValue(json);

class PresenceTypingPayload {
  const PresenceTypingPayload({this.chatId, this.from, this.isTyping, this.timestamp, this.extraFields = const {}});

  final String? chatId;
  final String? from;
  final bool? isTyping;
  final double? timestamp;

  /// Extra fields the upstream payload may carry beyond the declared ones.
  final Map<String, RaviJson> extraFields;

  factory PresenceTypingPayload.fromJson(Map<String, Object?> json) {
    final extraFields = <String, RaviJson>{
      for (final entry in json.entries)
        if (!const {"chatId", "from", "isTyping", "timestamp"}.contains(entry.key)) entry.key: RaviJson.from(entry.value),
    };
    return PresenceTypingPayload(
      chatId: json["chatId"] == null ? null : raviJsonAsString(json["chatId"]),
      from: json["from"] == null ? null : raviJsonAsString(json["from"]),
      isTyping: json["isTyping"] == null ? null : raviJsonAsBool(json["isTyping"]),
      timestamp: json["timestamp"] == null ? null : raviJsonAsDouble(json["timestamp"]),
      extraFields: extraFields,
    );
  }

  static PresenceTypingPayload fromJsonValue(Object? json) {
    return PresenceTypingPayload.fromJson(raviJsonObject(json, "PresenceTypingPayload"));
  }
}

PresenceTypingPayload presenceTypingPayloadFromJson(Object? json) => PresenceTypingPayload.fromJsonValue(json);

class ChatUnreadUpdatedPayload {
  const ChatUnreadUpdatedPayload({this.chatId, this.unreadCount, this.lastReadMessageId, this.timestamp, this.extraFields = const {}});

  final String? chatId;
  final int? unreadCount;
  final String? lastReadMessageId;
  final double? timestamp;

  /// Extra fields the upstream payload may carry beyond the declared ones.
  final Map<String, RaviJson> extraFields;

  factory ChatUnreadUpdatedPayload.fromJson(Map<String, Object?> json) {
    final extraFields = <String, RaviJson>{
      for (final entry in json.entries)
        if (!const {"chatId", "unreadCount", "lastReadMessageId", "timestamp"}.contains(entry.key)) entry.key: RaviJson.from(entry.value),
    };
    return ChatUnreadUpdatedPayload(
      chatId: json["chatId"] == null ? null : raviJsonAsString(json["chatId"]),
      unreadCount: json["unreadCount"] == null ? null : raviJsonAsInt(json["unreadCount"]),
      lastReadMessageId: json["lastReadMessageId"] == null ? null : raviJsonAsString(json["lastReadMessageId"]),
      timestamp: json["timestamp"] == null ? null : raviJsonAsDouble(json["timestamp"]),
      extraFields: extraFields,
    );
  }

  static ChatUnreadUpdatedPayload fromJsonValue(Object? json) {
    return ChatUnreadUpdatedPayload.fromJson(raviJsonObject(json, "ChatUnreadUpdatedPayload"));
  }
}

ChatUnreadUpdatedPayload chatUnreadUpdatedPayloadFromJson(Object? json) => ChatUnreadUpdatedPayload.fromJsonValue(json);

class RaviStreamClient {
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

  ///
  /// Subscribe to the full NATS event bus. Mirrors `ravi events stream` and suppresses the same noisy topics (message.*, reaction.*, instance.*, presence.typing, chat.unread-updated, .stream, claude stream chunks).
  ///
  Stream<RaviSseEvent<GatewayTopicEvent>> events([EventsStreamOptions options = const EventsStreamOptions()]) {
    final query = <String, String>{};
    _appendString(query, "subject", options.subject);
    _appendString(query, "filter", options.filter);
    _appendString(query, "only", options.only);
    _appendBool(query, "noClaude", options.noClaude);
    _appendBool(query, "noHeartbeat", options.noHeartbeat);
    return _stream(pathSegments: ["events"], query: query, decode: gatewayTopicEventFromJson);
  }

  ///
  /// Subscribe to task lifecycle events (`ravi.task.<id>.event`).
  ///
  Stream<RaviSseEvent<TaskStreamPayload>> tasks([TasksStreamOptions options = const TasksStreamOptions()]) {
    final query = <String, String>{};
    _appendString(query, "taskId", options.taskId);
    return _stream(pathSegments: ["tasks"], query: query, decode: taskStreamPayloadFromJson);
  }

  ///
  /// Subscribe to runtime debug events for a single session: prompts, responses, streamed chunks, tool calls, provider runtime events, claude SDK events, delivery telemetry, and approval request/response.
  ///
  Stream<RaviSseEvent<SessionStreamPayload>> session(String name, [SessionStreamOptions options = const SessionStreamOptions()]) {
    final query = <String, String>{};
    _appendDouble(query, "timeout", options.timeout);
    return _stream(pathSegments: ["sessions", name], query: query, decode: sessionStreamPayloadFromJson);
  }

  ///
  /// Subscribe to the live event stream for a single chat: new messages, reactions, presence/typing, and unread updates. The server filters by `chatId` against the upstream omni payload — events for other chats are discarded before reaching the client.
  ///
  Stream<RaviSseEvent<ChatStreamPayload>> chat(String chatId, [ChatStreamOptions options = const ChatStreamOptions()]) {
    return _stream(pathSegments: ["chats", chatId], query: const {}, decode: chatStreamPayloadFromJson);
  }

  ///
  /// Subscribe to lifecycle events for a single omni instance: QR code, connected, disconnected. Filtered server-side.
  ///
  Stream<RaviSseEvent<InstanceStreamPayload>> instance(String instanceId, [InstanceStreamOptions options = const InstanceStreamOptions()]) {
    return _stream(pathSegments: ["instances", instanceId], query: const {}, decode: instanceStreamPayloadFromJson);
  }

  ///
  /// Subscribe to the global audit event stream (`ravi.audit.>`).
  ///
  Stream<RaviSseEvent<GatewayTopicEvent>> audit([AuditStreamOptions options = const AuditStreamOptions()]) {
    return _stream(pathSegments: ["audit"], query: const {}, decode: gatewayTopicEventFromJson);
  }

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
      buffer += chunk.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      var newline = buffer.indexOf('\n');
      while (newline != -1) {
        final line = buffer.substring(0, newline);
        buffer = buffer.substring(newline + 1);
        final event = parser.feedLine(line);
        if (event != null) yield event;
        newline = buffer.indexOf('\n');
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
    final path = '/${[existing, streamPath].where((part) => part.isNotEmpty).join('/')}';
    return baseUrl.replace(path: path, queryParameters: query.isEmpty ? null : query);
  }
}

extension ChatStreamPayloadOmniMessageReceivedEnvelopeDecoding on ChatStreamPayload {
  /// Decode the raw `data` field as a `OmniMessageReceivedEnvelope` — use when the SSE `event` name is "message".
  OmniMessageReceivedEnvelope decodeMessage() {
    return OmniMessageReceivedEnvelope.fromJsonValue(data.toJson());
  }
}

extension ChatStreamPayloadOmniReactionReceivedEnvelopeDecoding on ChatStreamPayload {
  /// Decode the raw `data` field as a `OmniReactionReceivedEnvelope` — use when the SSE `event` name is "reaction".
  OmniReactionReceivedEnvelope decodeReaction() {
    return OmniReactionReceivedEnvelope.fromJsonValue(data.toJson());
  }
}

extension ChatStreamPayloadPresenceTypingPayloadDecoding on ChatStreamPayload {
  /// Decode the raw `data` field as a `PresenceTypingPayload` — use when the SSE `event` name is "presence".
  PresenceTypingPayload decodePresenceTyping() {
    return PresenceTypingPayload.fromJsonValue(data.toJson());
  }
}

extension ChatStreamPayloadChatUnreadUpdatedPayloadDecoding on ChatStreamPayload {
  /// Decode the raw `data` field as a `ChatUnreadUpdatedPayload` — use when the SSE `event` name is "unread".
  ChatUnreadUpdatedPayload decodeUnread() {
    return ChatUnreadUpdatedPayload.fromJsonValue(data.toJson());
  }
}

class RaviSseParser<T> {
  RaviSseParser(this.decode);

  final T Function(Object? json) decode;
  String _eventName = 'message';
  String? _eventId;
  final List<String> _dataLines = <String>[];

  RaviSseEvent<T>? feedLine(String rawLine) {
    final line = rawLine.endsWith('\r') ? rawLine.substring(0, rawLine.length - 1) : rawLine;
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
    final raw = _dataLines.join('\n');
    Object? parsed;
    try {
      parsed = jsonDecode(raw);
    } on FormatException catch (error) {
      throw RaviContractError.returnShape('SSE event data is not valid JSON: ${error.message}');
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
