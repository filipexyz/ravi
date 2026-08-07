import Foundation

public enum RaviError: Error, Sendable, Equatable {
  case contract(body: RaviContractErrorBody, statusCode: Int)
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

public enum RaviContractOutcome: String, Decodable, Sendable, Equatable {
  case blocked
  case usageError = "usage_error"
  case failed
}

public struct RaviContractErrorPayload: Decodable, Sendable, Equatable {
  public let code: String
  public let message: String
  public let retryable: Bool
  public let details: [String: RaviJSON]

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: RaviErrorCodingKey.self)
    self.code = try container.decode(String.self, forKey: RaviErrorCodingKey("code"))
    self.message = try container.decode(String.self, forKey: RaviErrorCodingKey("message"))
    self.retryable = try container.decode(Bool.self, forKey: RaviErrorCodingKey("retryable"))

    let declared: Set<String> = ["code", "message", "retryable"]
    var details: [String: RaviJSON] = [:]
    for key in container.allKeys where !declared.contains(key.stringValue) {
      details[key.stringValue] = try container.decode(RaviJSON.self, forKey: key)
    }
    self.details = details
  }
}

public struct RaviContractErrorBody: Decodable, Sendable, Equatable {
  public let success: Bool
  public let op: String
  public let error: RaviContractErrorPayload
  public let exitCode: Int
  public let outcome: RaviContractOutcome
  public let extraFields: [String: RaviJSON]

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: RaviErrorCodingKey.self)
    self.success = try container.decode(Bool.self, forKey: RaviErrorCodingKey("success"))
    self.op = try container.decode(String.self, forKey: RaviErrorCodingKey("op"))
    self.error = try container.decode(RaviContractErrorPayload.self, forKey: RaviErrorCodingKey("error"))
    self.exitCode = try container.decode(Int.self, forKey: RaviErrorCodingKey("exitCode"))
    self.outcome = try container.decode(RaviContractOutcome.self, forKey: RaviErrorCodingKey("outcome"))

    let declared: Set<String> = ["success", "op", "error", "exitCode", "outcome"]
    var extraFields: [String: RaviJSON] = [:]
    for key in container.allKeys where !declared.contains(key.stringValue) {
      extraFields[key.stringValue] = try container.decode(RaviJSON.self, forKey: key)
    }
    self.extraFields = extraFields
  }
}

struct RaviErrorBody: Decodable, Sendable {
  let error: String?
  let message: String?
  let reason: String?
  let issues: [RaviIssue]?
}

func buildRaviError(statusCode: Int, data: Data) -> RaviError {
  let decoder = JSONDecoder()
  if let contractBody = try? decoder.decode(RaviContractErrorBody.self, from: data),
    !contractBody.success,
    (1...3).contains(contractBody.exitCode)
  {
    return .contract(body: contractBody, statusCode: statusCode)
  }

  let body = try? decoder.decode(RaviErrorBody.self, from: data)
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

private struct RaviErrorCodingKey: CodingKey, Hashable {
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

