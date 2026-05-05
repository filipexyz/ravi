import Foundation

public protocol RaviTransport: Sendable {
  func call<T: Decodable & Sendable>(
    groupSegments: [String],
    command: String,
    body: [String: RaviJSON],
    as type: T.Type
  ) async throws -> T

  func callBinary(
    groupSegments: [String],
    command: String,
    body: [String: RaviJSON]
  ) async throws -> RaviBinaryResponse
}

public struct RaviBinaryResponse: Sendable {
  public let data: Data
  public let contentType: String?
  public let statusCode: Int
  public let headers: [String: String]

  public init(data: Data, contentType: String?, statusCode: Int, headers: [String: String]) {
    self.data = data
    self.contentType = contentType
    self.statusCode = statusCode
    self.headers = headers
  }
}

