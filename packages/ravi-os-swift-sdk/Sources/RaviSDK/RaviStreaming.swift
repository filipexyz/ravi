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

  public init(taskId: String? = nil) {
    self.taskId = taskId
  }
}

public struct SessionStreamOptions: Sendable {
  /// Seconds. `0` means no natural timeout.
  public var timeout: TimeInterval?

  public init(timeout: TimeInterval? = nil) {
    self.timeout = timeout
  }
}

public struct AuditStreamOptions: Sendable {
  public init() {}
}

public struct GatewayTopicEvent: Decodable, Sendable {
  public let type: String
  public let topic: String
  public let data: RaviJSON
  public let timestamp: String?
  public let count: Int?

  public init(type: String, topic: String, data: RaviJSON, timestamp: String? = nil, count: Int? = nil) {
    self.type = type
    self.topic = topic
    self.data = data
    self.timestamp = timestamp
    self.count = count
  }
}

public struct TaskStreamPayload: Decodable, Sendable {
  public let type: String
  public let topic: String
  public let fields: [String: RaviJSON]

  public init(type: String, topic: String, fields: [String: RaviJSON] = [:]) {
    self.type = type
    self.topic = topic
    self.fields = fields
  }

  public subscript(field: String) -> RaviJSON? {
    fields[field]
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: DynamicCodingKey.self)
    self.type = try container.decode(String.self, forKey: DynamicCodingKey("type"))
    self.topic = try container.decode(String.self, forKey: DynamicCodingKey("topic"))
    var fields: [String: RaviJSON] = [:]
    for key in container.allKeys where key.stringValue != "type" && key.stringValue != "topic" {
      fields[key.stringValue] = try container.decode(RaviJSON.self, forKey: key)
    }
    self.fields = fields
  }
}

public struct SessionStreamPayload: Decodable, Sendable {
  public let type: String
  public let sessionName: String
  public let topic: String?
  public let data: RaviJSON?
  public let reason: String?
  public let timeoutMs: Int?
  public let timestamp: String?

  public init(
    type: String,
    sessionName: String,
    topic: String? = nil,
    data: RaviJSON? = nil,
    reason: String? = nil,
    timeoutMs: Int? = nil,
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

  public func events(_ options: EventsStreamOptions = .init()) -> AsyncThrowingStream<RaviSseEvent<GatewayTopicEvent>, Error> {
    stream(pathSegments: ["events"], queryItems: eventsQueryItems(options), as: GatewayTopicEvent.self)
  }

  public func tasks(_ options: TasksStreamOptions = .init()) -> AsyncThrowingStream<RaviSseEvent<TaskStreamPayload>, Error> {
    var queryItems: [URLQueryItem] = []
    append(&queryItems, "taskId", options.taskId)
    return stream(pathSegments: ["tasks"], queryItems: queryItems, as: TaskStreamPayload.self)
  }

  public func session(
    _ name: String,
    options: SessionStreamOptions = .init()
  ) -> AsyncThrowingStream<RaviSseEvent<SessionStreamPayload>, Error> {
    var queryItems: [URLQueryItem] = []
    if let timeout = options.timeout {
      append(&queryItems, "timeout", formatTimeout(timeout))
    }
    return stream(pathSegments: ["sessions", name], queryItems: queryItems, as: SessionStreamPayload.self)
  }

  public func audit(_ options: AuditStreamOptions = .init()) -> AsyncThrowingStream<RaviSseEvent<GatewayTopicEvent>, Error> {
    _ = options
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

private func eventsQueryItems(_ options: EventsStreamOptions) -> [URLQueryItem] {
  var queryItems: [URLQueryItem] = []
  append(&queryItems, "subject", options.subject)
  append(&queryItems, "filter", options.filter)
  append(&queryItems, "only", options.only)
  appendBool(&queryItems, "noClaude", options.noClaude)
  appendBool(&queryItems, "noHeartbeat", options.noHeartbeat)
  return queryItems
}

private func append(_ queryItems: inout [URLQueryItem], _ name: String, _ value: String?) {
  guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
    return
  }
  queryItems.append(URLQueryItem(name: name, value: value))
}

private func appendBool(_ queryItems: inout [URLQueryItem], _ name: String, _ value: Bool) {
  if value {
    queryItems.append(URLQueryItem(name: name, value: "1"))
  }
}

private func formatTimeout(_ value: TimeInterval) -> String {
  if value.rounded(.towardZero) == value {
    return String(Int(value))
  }
  return String(value)
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
