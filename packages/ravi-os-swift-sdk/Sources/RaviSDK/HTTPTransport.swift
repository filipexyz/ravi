import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public final class HTTPTransport: RaviTransport, @unchecked Sendable {
  private let baseURL: URL
  private let contextKey: String
  private let session: URLSession
  private let timeout: TimeInterval
  private let extraHeaders: [String: String]

  public init(
    baseURL: URL,
    contextKey: String,
    session: URLSession = .shared,
    timeout: TimeInterval = 0,
    headers: [String: String] = [:]
  ) {
    self.baseURL = baseURL
    self.contextKey = contextKey
    self.session = session
    self.timeout = timeout
    self.extraHeaders = headers
  }

  public func call<T: Decodable & Sendable>(
    groupSegments: [String],
    command: String,
    body: [String: RaviJSON],
    as type: T.Type
  ) async throws -> T {
    let (data, response) = try await send(groupSegments: groupSegments, command: command, body: body, binary: false)
    guard (200..<300).contains(response.statusCode) else {
      throw buildRaviError(statusCode: response.statusCode, data: data)
    }
    if data.isEmpty, T.self == RaviJSON.self {
      return RaviJSON.object([:]) as! T
    }
    do {
      return try JSONDecoder().decode(type, from: data.isEmpty ? Data("{}".utf8) : data)
    } catch {
      throw RaviError.decoding(message: error.localizedDescription)
    }
  }

  public func callBinary(
    groupSegments: [String],
    command: String,
    body: [String: RaviJSON]
  ) async throws -> RaviBinaryResponse {
    let (data, response) = try await send(groupSegments: groupSegments, command: command, body: body, binary: true)
    guard (200..<300).contains(response.statusCode) else {
      throw buildRaviError(statusCode: response.statusCode, data: data)
    }
    return RaviBinaryResponse(
      data: data,
      contentType: response.value(forHTTPHeaderField: "content-type"),
      statusCode: response.statusCode,
      headers: response.allHeaderFields.reduce(into: [String: String]()) { acc, item in
        acc[String(describing: item.key)] = String(describing: item.value)
      }
    )
  }

  private func send(
    groupSegments: [String],
    command: String,
    body: [String: RaviJSON],
    binary: Bool
  ) async throws -> (Data, HTTPURLResponse) {
    let url = (["api", "v1"] + groupSegments + [command]).reduce(baseURL) { partial, component in
      partial.appendingPathComponent(component)
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    if timeout > 0 {
      request.timeoutInterval = timeout
    }
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(binary ? "application/octet-stream, */*" : "application/json", forHTTPHeaderField: "accept")
    request.setValue("Bearer \(contextKey)", forHTTPHeaderField: "authorization")
    request.setValue(RAVI_SDK_VERSION, forHTTPHeaderField: "x-ravi-sdk-version")
    request.setValue(RAVI_REGISTRY_HASH, forHTTPHeaderField: "x-ravi-registry-hash")
    for (key, value) in extraHeaders {
      request.setValue(value, forHTTPHeaderField: key)
    }
    request.httpBody = try JSONEncoder().encode(RaviJSON.object(body))

    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else {
        throw RaviError.transport(message: "Ravi gateway returned a non-HTTP response")
      }
      return (data, http)
    } catch let error as RaviError {
      throw error
    } catch {
      throw RaviError.transport(message: error.localizedDescription)
    }
  }
}
