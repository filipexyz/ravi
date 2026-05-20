// GENERATED FILE - DO NOT EDIT.
// Run `ravi sdk swift generate` to regenerate.
// Drift is detected by `ravi sdk swift check`.

import Foundation
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

public struct EventsStreamOptions: Sendable {
  public var subject: String?
  public var filter: String?
  public var only: String?
  public var noClaude: Bool
  public var noHeartbeat: Bool
  public init(
    subject: String? = nil,
    filter: String? = nil,
    only: String? = nil,
    noClaude: Bool = false,
    noHeartbeat: Bool = false
  ) {
    self.subject = subject
    self.filter = filter
    self.only = only
    self.noClaude = noClaude
    self.noHeartbeat = noHeartbeat
  }
}

public struct TasksStreamOptions: Sendable {
  public var taskId: String?
  public init(
    taskId: String? = nil
  ) {
    self.taskId = taskId
  }
}

public struct SessionStreamOptions: Sendable {
  /// Seconds before the stream emits `event: end` and closes. `0` means no natural timeout.
  public var timeout: Double?
  public init(
    timeout: Double? = nil
  ) {
    self.timeout = timeout
  }
}

public struct ChatStreamOptions: Sendable {
  public init() {}
}

public struct InstanceStreamOptions: Sendable {
  public init() {}
}

public struct AuditStreamOptions: Sendable {
  public init() {}
}

public struct GatewayTopicEvent: Decodable, Sendable {
  public let type: String
  public let topic: String
  public let data: RaviJSON
  public let timestamp: String?
  public let count: Double?

  public init(
    type: String,
    topic: String,
    data: RaviJSON,
    timestamp: String? = nil,
    count: Double? = nil
  ) {
    self.type = type
    self.topic = topic
    self.data = data
    self.timestamp = timestamp
    self.count = count
  }
}

public struct TaskStreamPayload: Decodable, Sendable {
  public let type: RaviJSON
  public let topic: String

  /// Extra fields the upstream payload may carry beyond the declared ones.
  /// Keys are walked through dynamic decoding so the wire shape is preserved.
  public let extraFields: [String: RaviJSON]

  public init(
    type: RaviJSON,
    topic: String,
    extraFields: [String: RaviJSON] = [:]
  ) {
    self.type = type
    self.topic = topic
    self.extraFields = extraFields
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: DynamicCodingKey.self)
    self.type = try container.decode(RaviJSON.self, forKey: DynamicCodingKey("type"))
    self.topic = try container.decode(String.self, forKey: DynamicCodingKey("topic"))
    var extras: [String: RaviJSON] = [:]
    let declared: Set<String> = ["type", "topic"]
    for key in container.allKeys where !declared.contains(key.stringValue) {
      extras[key.stringValue] = try container.decode(RaviJSON.self, forKey: key)
    }
    self.extraFields = extras
  }
}

public struct SessionStreamPayload: Decodable, Sendable {
  public let type: RaviJSON
  public let sessionName: String
  public let topic: String?
  public let data: RaviJSON?
  public let reason: String?
  public let timeoutMs: Double?
  public let timestamp: String?

  public init(
    type: RaviJSON,
    sessionName: String,
    topic: String? = nil,
    data: RaviJSON? = nil,
    reason: String? = nil,
    timeoutMs: Double? = nil,
    timestamp: String? = nil
  ) {
    self.type = type
    self.sessionName = sessionName
    self.topic = topic
    self.data = data
    self.reason = reason
    self.timeoutMs = timeoutMs
    self.timestamp = timestamp
  }
}

public struct ChatStreamPayload: Decodable, Sendable {
  public let type: RaviJSON
  public let chatId: String
  public let topic: String
  public let data: RaviJSON
  public let timestamp: String

  public init(
    type: RaviJSON,
    chatId: String,
    topic: String,
    data: RaviJSON,
    timestamp: String
  ) {
    self.type = type
    self.chatId = chatId
    self.topic = topic
    self.data = data
    self.timestamp = timestamp
  }
}

public struct InstanceStreamPayload: Decodable, Sendable {
  public let type: RaviJSON
  public let instanceId: String
  public let topic: String
  public let data: RaviJSON
  public let timestamp: String

  public init(
    type: RaviJSON,
    instanceId: String,
    topic: String,
    data: RaviJSON,
    timestamp: String
  ) {
    self.type = type
    self.instanceId = instanceId
    self.topic = topic
    self.data = data
    self.timestamp = timestamp
  }
}

public struct OmniMessageReceivedEnvelope: Decodable, Sendable {
  public let id: String
  public let type: String
  public let payload: RaviJSON
  public let metadata: RaviJSON?
  public let timestamp: Double

  /// Extra fields the upstream payload may carry beyond the declared ones.
  /// Keys are walked through dynamic decoding so the wire shape is preserved.
  public let extraFields: [String: RaviJSON]

  public init(
    id: String,
    type: String,
    payload: RaviJSON,
    metadata: RaviJSON? = nil,
    timestamp: Double,
    extraFields: [String: RaviJSON] = [:]
  ) {
    self.id = id
    self.type = type
    self.payload = payload
    self.metadata = metadata
    self.timestamp = timestamp
    self.extraFields = extraFields
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: DynamicCodingKey.self)
    self.id = try container.decode(String.self, forKey: DynamicCodingKey("id"))
    self.type = try container.decode(String.self, forKey: DynamicCodingKey("type"))
    self.payload = try container.decode(RaviJSON.self, forKey: DynamicCodingKey("payload"))
    self.metadata = try container.decodeIfPresent(RaviJSON.self, forKey: DynamicCodingKey("metadata"))
    self.timestamp = try container.decode(Double.self, forKey: DynamicCodingKey("timestamp"))
    var extras: [String: RaviJSON] = [:]
    let declared: Set<String> = ["id", "type", "payload", "metadata", "timestamp"]
    for key in container.allKeys where !declared.contains(key.stringValue) {
      extras[key.stringValue] = try container.decode(RaviJSON.self, forKey: key)
    }
    self.extraFields = extras
  }
}

public struct OmniReactionReceivedEnvelope: Decodable, Sendable {
  public let id: String
  public let type: String
  public let payload: RaviJSON
  public let metadata: RaviJSON?
  public let timestamp: Double

  /// Extra fields the upstream payload may carry beyond the declared ones.
  /// Keys are walked through dynamic decoding so the wire shape is preserved.
  public let extraFields: [String: RaviJSON]

  public init(
    id: String,
    type: String,
    payload: RaviJSON,
    metadata: RaviJSON? = nil,
    timestamp: Double,
    extraFields: [String: RaviJSON] = [:]
  ) {
    self.id = id
    self.type = type
    self.payload = payload
    self.metadata = metadata
    self.timestamp = timestamp
    self.extraFields = extraFields
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: DynamicCodingKey.self)
    self.id = try container.decode(String.self, forKey: DynamicCodingKey("id"))
    self.type = try container.decode(String.self, forKey: DynamicCodingKey("type"))
    self.payload = try container.decode(RaviJSON.self, forKey: DynamicCodingKey("payload"))
    self.metadata = try container.decodeIfPresent(RaviJSON.self, forKey: DynamicCodingKey("metadata"))
    self.timestamp = try container.decode(Double.self, forKey: DynamicCodingKey("timestamp"))
    var extras: [String: RaviJSON] = [:]
    let declared: Set<String> = ["id", "type", "payload", "metadata", "timestamp"]
    for key in container.allKeys where !declared.contains(key.stringValue) {
      extras[key.stringValue] = try container.decode(RaviJSON.self, forKey: key)
    }
    self.extraFields = extras
  }
}

public struct PresenceTypingPayload: Decodable, Sendable {
  public let chatId: String?
  public let from: String?
  public let isTyping: Bool?
  public let timestamp: Double?

  /// Extra fields the upstream payload may carry beyond the declared ones.
  /// Keys are walked through dynamic decoding so the wire shape is preserved.
  public let extraFields: [String: RaviJSON]

  public init(
    chatId: String? = nil,
    from: String? = nil,
    isTyping: Bool? = nil,
    timestamp: Double? = nil,
    extraFields: [String: RaviJSON] = [:]
  ) {
    self.chatId = chatId
    self.from = from
    self.isTyping = isTyping
    self.timestamp = timestamp
    self.extraFields = extraFields
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: DynamicCodingKey.self)
    self.chatId = try container.decodeIfPresent(String.self, forKey: DynamicCodingKey("chatId"))
    self.from = try container.decodeIfPresent(String.self, forKey: DynamicCodingKey("from"))
    self.isTyping = try container.decodeIfPresent(Bool.self, forKey: DynamicCodingKey("isTyping"))
    self.timestamp = try container.decodeIfPresent(Double.self, forKey: DynamicCodingKey("timestamp"))
    var extras: [String: RaviJSON] = [:]
    let declared: Set<String> = ["chatId", "from", "isTyping", "timestamp"]
    for key in container.allKeys where !declared.contains(key.stringValue) {
      extras[key.stringValue] = try container.decode(RaviJSON.self, forKey: key)
    }
    self.extraFields = extras
  }
}

public struct ChatUnreadUpdatedPayload: Decodable, Sendable {
  public let chatId: String?
  public let unreadCount: Int?
  public let lastReadMessageId: String?
  public let timestamp: Double?

  /// Extra fields the upstream payload may carry beyond the declared ones.
  /// Keys are walked through dynamic decoding so the wire shape is preserved.
  public let extraFields: [String: RaviJSON]

  public init(
    chatId: String? = nil,
    unreadCount: Int? = nil,
    lastReadMessageId: String? = nil,
    timestamp: Double? = nil,
    extraFields: [String: RaviJSON] = [:]
  ) {
    self.chatId = chatId
    self.unreadCount = unreadCount
    self.lastReadMessageId = lastReadMessageId
    self.timestamp = timestamp
    self.extraFields = extraFields
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: DynamicCodingKey.self)
    self.chatId = try container.decodeIfPresent(String.self, forKey: DynamicCodingKey("chatId"))
    self.unreadCount = try container.decodeIfPresent(Int.self, forKey: DynamicCodingKey("unreadCount"))
    self.lastReadMessageId = try container.decodeIfPresent(String.self, forKey: DynamicCodingKey("lastReadMessageId"))
    self.timestamp = try container.decodeIfPresent(Double.self, forKey: DynamicCodingKey("timestamp"))
    var extras: [String: RaviJSON] = [:]
    let declared: Set<String> = ["chatId", "unreadCount", "lastReadMessageId", "timestamp"]
    for key in container.allKeys where !declared.contains(key.stringValue) {
      extras[key.stringValue] = try container.decode(RaviJSON.self, forKey: key)
    }
    self.extraFields = extras
  }
}

public final class RaviStreamClient: @unchecked Sendable {
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

  /// Subscribe to the full NATS event bus. Mirrors `ravi events stream` and suppresses the same noisy topics (message.*, reaction.*, instance.*, presence.typing, chat.unread-updated, .stream, claude stream chunks).
  public func events(options: EventsStreamOptions = .init()) -> AsyncThrowingStream<RaviSseEvent<GatewayTopicEvent>, Error> {
    var queryItems: [URLQueryItem] = []
    appendString(&queryItems, "subject", options.subject)
    appendString(&queryItems, "filter", options.filter)
    appendString(&queryItems, "only", options.only)
    appendBool(&queryItems, "noClaude", options.noClaude)
    appendBool(&queryItems, "noHeartbeat", options.noHeartbeat)
    return stream(pathSegments: ["events"], queryItems: queryItems, as: GatewayTopicEvent.self)
  }

  /// Subscribe to task lifecycle events (`ravi.task.<id>.event`).
  public func tasks(options: TasksStreamOptions = .init()) -> AsyncThrowingStream<RaviSseEvent<TaskStreamPayload>, Error> {
    var queryItems: [URLQueryItem] = []
    appendString(&queryItems, "taskId", options.taskId)
    return stream(pathSegments: ["tasks"], queryItems: queryItems, as: TaskStreamPayload.self)
  }

  /// Subscribe to runtime debug events for a single session: prompts, responses, streamed chunks, tool calls, provider runtime events, claude SDK events, delivery telemetry, and approval request/response.
  public func session(_ name: String, options: SessionStreamOptions = .init()) -> AsyncThrowingStream<RaviSseEvent<SessionStreamPayload>, Error> {
    var queryItems: [URLQueryItem] = []
    appendDouble(&queryItems, "timeout", options.timeout)
    return stream(pathSegments: ["sessions", name], queryItems: queryItems, as: SessionStreamPayload.self)
  }

  /// Subscribe to the live event stream for a single chat: new messages, reactions, presence/typing, and unread updates. The server filters by `chatId` against the upstream omni payload — events for other chats are discarded before reaching the client.
  public func chat(_ chatId: String, options: ChatStreamOptions = .init()) -> AsyncThrowingStream<RaviSseEvent<ChatStreamPayload>, Error> {
    return stream(pathSegments: ["chats", chatId], queryItems: [], as: ChatStreamPayload.self)
  }

  /// Subscribe to lifecycle events for a single omni instance: QR code, connected, disconnected. Filtered server-side.
  public func instance(_ instanceId: String, options: InstanceStreamOptions = .init()) -> AsyncThrowingStream<RaviSseEvent<InstanceStreamPayload>, Error> {
    return stream(pathSegments: ["instances", instanceId], queryItems: [], as: InstanceStreamPayload.self)
  }

  /// Subscribe to the global audit event stream (`ravi.audit.>`).
  public func audit(options: AuditStreamOptions = .init()) -> AsyncThrowingStream<RaviSseEvent<GatewayTopicEvent>, Error> {
    return stream(pathSegments: ["audit"], queryItems: [], as: GatewayTopicEvent.self)
  }

  func buildStreamRequest(pathSegments: [String], queryItems: [URLQueryItem]) throws -> URLRequest {
    var request = URLRequest(url: try streamURL(pathSegments: pathSegments, queryItems: queryItems))
    request.httpMethod = "GET"
    request.setValue("text/event-stream", forHTTPHeaderField: "accept")
    request.setValue("Bearer \(contextKey)", forHTTPHeaderField: "authorization")
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
}

public extension ChatStreamPayload {
  /// Decode the raw `data` field as a `OmniMessageReceivedEnvelope` — use when the SSE `event` name is "message".
  func decodeMessage() throws -> OmniMessageReceivedEnvelope {
    let bytes = try JSONEncoder().encode(self.data)
    return try JSONDecoder().decode(OmniMessageReceivedEnvelope.self, from: bytes)
  }
}

public extension ChatStreamPayload {
  /// Decode the raw `data` field as a `OmniReactionReceivedEnvelope` — use when the SSE `event` name is "reaction".
  func decodeReaction() throws -> OmniReactionReceivedEnvelope {
    let bytes = try JSONEncoder().encode(self.data)
    return try JSONDecoder().decode(OmniReactionReceivedEnvelope.self, from: bytes)
  }
}

public extension ChatStreamPayload {
  /// Decode the raw `data` field as a `PresenceTypingPayload` — use when the SSE `event` name is "presence".
  func decodePresenceTyping() throws -> PresenceTypingPayload {
    let bytes = try JSONEncoder().encode(self.data)
    return try JSONDecoder().decode(PresenceTypingPayload.self, from: bytes)
  }
}

public extension ChatStreamPayload {
  /// Decode the raw `data` field as a `ChatUnreadUpdatedPayload` — use when the SSE `event` name is "unread".
  func decodeUnread() throws -> ChatUnreadUpdatedPayload {
    let bytes = try JSONEncoder().encode(self.data)
    return try JSONDecoder().decode(ChatUnreadUpdatedPayload.self, from: bytes)
  }
}

public struct RaviSseParser<T: Decodable & Sendable> {
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
    let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
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
    let raw = dataLines.joined(separator: "\n")
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
