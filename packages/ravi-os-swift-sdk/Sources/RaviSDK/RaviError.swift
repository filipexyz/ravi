import Foundation

public enum RaviError: Error, Sendable, Equatable {
  case auth(message: String, statusCode: Int)
  case permission(message: String, statusCode: Int)
  case validation(message: String, issues: [RaviIssue], statusCode: Int)
  case internalError(message: String, statusCode: Int)
  case transport(message: String)
  case decoding(message: String)
  case unexpectedStatus(message: String, statusCode: Int)
}

public struct RaviIssue: Codable, Sendable, Equatable {
  public let path: [String]?
  public let code: String?
  public let message: String?

  public init(path: [String]? = nil, code: String? = nil, message: String? = nil) {
    self.path = path
    self.code = code
    self.message = message
  }
}

struct RaviErrorBody: Decodable, Sendable {
  let error: String?
  let message: String?
  let reason: String?
  let issues: [RaviIssue]?
}

func buildRaviError(statusCode: Int, data: Data) -> RaviError {
  let body = try? JSONDecoder().decode(RaviErrorBody.self, from: data)
  let message = body?.message ?? body?.reason ?? body?.error ?? "Ravi gateway returned HTTP \(statusCode)"

  switch statusCode {
  case 401:
    return .auth(message: message, statusCode: statusCode)
  case 403:
    return .permission(message: message, statusCode: statusCode)
  case 400:
    return .validation(message: message, issues: body?.issues ?? [], statusCode: statusCode)
  case 500...599:
    return .internalError(message: message, statusCode: statusCode)
  default:
    return .unexpectedStatus(message: message, statusCode: statusCode)
  }
}

