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
  case denied
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

    let allowedDetails: Set<String> = [
      "suggestedAction", "suggestions", "acceptedFlags", "acceptedPositionals",
      "acceptedValues", "usage", "dryRun", "plan", "issues", "status",
    ]
    var details: [String: RaviJSON] = [:]
    for key in container.allKeys where allowedDetails.contains(key.stringValue) {
      let value = try container.decode(RaviJSON.self, forKey: key)
      if let projected = projectContractDetail(value, key: key.stringValue) {
        details[key.stringValue] = projected
      }
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

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: RaviErrorCodingKey.self)
    self.success = try container.decode(Bool.self, forKey: RaviErrorCodingKey("success"))
    self.op = try container.decode(String.self, forKey: RaviErrorCodingKey("op"))
    self.error = try container.decode(RaviContractErrorPayload.self, forKey: RaviErrorCodingKey("error"))
    self.exitCode = try container.decode(Int.self, forKey: RaviErrorCodingKey("exitCode"))
    self.outcome = try container.decode(RaviContractOutcome.self, forKey: RaviErrorCodingKey("outcome"))
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
    isCoherentContractFailure(
      exitCode: contractBody.exitCode,
      outcome: contractBody.outcome,
      code: contractBody.error.code
    )
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

private let contractDetailMaxItems = 64
private let contractDetailMaxDepth = 8
private let contractRedactionMarkerPattern = #"^\[REDACTED(?::(?:path|rctx|token|content(?: length=\d+)?))?\]$"#
private let contractContentKeys: Set<String> = ["body", "caption", "content", "message", "output", "prompt", "text"]
private let contractSecretSegments: Set<String> = ["password", "passwords", "secret", "secrets", "token", "tokens"]
private let contractSafeNumericSecretSuffixes: Set<String> = ["chars", "count", "length"]
private let contractSecretKeys: Set<String> = [
  "accesstoken", "apikey", "authorization", "contextkey", "credentialref", "credentialsref",
  "password", "refreshtoken", "secret", "secretref", "token",
]
private let rawContractKeys: Set<String> = [
  "errorbody", "providerbody", "providererror", "providerresponse", "raw", "rawbody",
  "rawerror", "rawpayload", "rawresponse", "responsebody", "stack", "stacktrace",
]

private func isCoherentContractFailure(exitCode: Int, outcome: RaviContractOutcome, code: String) -> Bool {
  if outcome == .denied && code != "PERMISSION_DENIED" { return false }
  if code == "PERMISSION_DENIED" && outcome != .denied { return false }
  switch exitCode {
  case 1:
    return outcome == .failed || outcome == .denied
  case 2:
    return outcome == .usageError
  case 3:
    return outcome == .blocked
  default:
    return false
  }
}

private func projectContractDetail(_ value: RaviJSON, key: String) -> RaviJSON? {
  switch key {
  case "suggestedAction", "usage":
    guard case .string = value else { return nil }
    return sanitizeContractJSON(value, key: key)
  case "suggestions", "acceptedFlags", "acceptedPositionals", "acceptedValues":
    guard case .array(let values) = value else { return nil }
    let strings = values.compactMap { item -> RaviJSON? in
      guard case .string = item else { return nil }
      return sanitizeContractJSON(item)
    }
    return strings.isEmpty ? nil : .array(Array(strings.prefix(contractDetailMaxItems)))
  case "dryRun":
    guard case .bool = value else { return nil }
    return value
  case "plan":
    guard case .object = value else { return nil }
    return sanitizeContractJSON(value)
  case "issues":
    guard case .array(let values) = value else { return nil }
    let issues = values.prefix(contractDetailMaxItems).compactMap(projectContractIssue)
    return issues.isEmpty ? nil : .array(issues)
  case "status":
    guard case .number = value else { return nil }
    return value
  default:
    return nil
  }
}

private func projectContractIssue(_ value: RaviJSON) -> RaviJSON? {
  guard case .object(let issue) = value,
    case .string(let code)? = issue["code"],
    case .string(let message)? = issue["message"],
    case .array(let rawPath)? = issue["path"]
  else {
    return nil
  }

  let path = rawPath.prefix(contractDetailMaxItems).compactMap { item -> RaviJSON? in
    switch item {
    case .string(let component):
      return .string(sanitizeContractString(component))
    case .number:
      return item
    default:
      return nil
    }
  }
  return .object([
    "path": .array(path),
    "code": .string(sanitizeContractString(code)),
    "message": sanitizeContractJSON(.string(message), key: "message"),
  ])
}

private func sanitizeContractJSON(
  _ value: RaviJSON,
  key: String? = nil,
  parent: [String: RaviJSON]? = nil,
  depth: Int = 0
) -> RaviJSON {
  if depth > contractDetailMaxDepth { return .string("[REDACTED]") }

  if let key, isContractSecretKey(key), !isTypedContractSecretMetadata(key: key, value: value) {
    return .string("[REDACTED]")
  }
  if key == "value", parentNamesContractSecret(parent: parent, value: value) {
    return .string("[REDACTED]")
  }
  if let key, normalizeContractKey(key).hasSuffix("path"), case .string = value {
    return .string("[REDACTED:path]")
  }
  if let key, contractContentKeys.contains(key.lowercased()) {
    if case .string(let string) = value {
      return .string("[REDACTED:content length=\(string.count)]")
    }
    return .string("[REDACTED:content]")
  }

  switch value {
  case .string(let string):
    return .string(sanitizeContractString(string))
  case .array(let values):
    return .array(
      Array(values.prefix(contractDetailMaxItems)).map {
        sanitizeContractJSON($0, depth: depth + 1)
      }
    )
  case .object(let object):
    var sanitized: [String: RaviJSON] = [:]
    let publicKeys = object.keys.filter { !rawContractKeys.contains(normalizeContractKey($0)) }
    for nestedKey in publicKeys.sorted().prefix(contractDetailMaxItems) {
      if let nestedValue = object[nestedKey] {
        sanitized[nestedKey] = sanitizeContractJSON(
          nestedValue,
          key: nestedKey,
          parent: object,
          depth: depth + 1
        )
      }
    }
    return .object(sanitized)
  default:
    return value
  }
}

private func sanitizeContractString(_ value: String) -> String {
  if matchesContractPattern(value, pattern: contractRedactionMarkerPattern) { return value }
  return value
    .replacingOccurrences(of: #"rctx_[A-Za-z0-9_-]+"#, with: "[REDACTED:rctx]", options: .regularExpression)
    .replacingOccurrences(
      of: #"\bBearer\s+[A-Za-z0-9._~+/-]+=*"#,
      with: "Bearer [REDACTED]",
      options: [.regularExpression, .caseInsensitive]
    )
    .replacingOccurrences(
      of: #"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b"#,
      with: "[REDACTED:token]",
      options: .regularExpression
    )
}

private func matchesContractPattern(_ value: String, pattern: String) -> Bool {
  value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
}

private func normalizeContractKey(_ key: String) -> String {
  key.replacingOccurrences(of: "-", with: "").replacingOccurrences(of: "_", with: "").lowercased()
}

private func contractKeySegments(_ key: String) -> [String] {
  let camelSeparated = key.replacingOccurrences(
    of: #"([a-z0-9])([A-Z])"#,
    with: "$1 $2",
    options: .regularExpression
  )
  return camelSeparated
    .split { character in character == "." || character == " " || character == "_" || character == "-" }
    .map { $0.lowercased() }
}

private func isContractSecretKey(_ key: String) -> Bool {
  if contractSecretKeys.contains(normalizeContractKey(key)) { return true }
  let segments = contractKeySegments(key)
  if segments.contains(where: { contractSecretSegments.contains($0) }) { return true }
  return segments.enumerated().contains { index, segment in
    segment == "key" && index > 0 && ["api", "private"].contains(segments[index - 1])
  }
}

private func isTypedContractSecretMetadata(key: String, value: RaviJSON) -> Bool {
  let segments = contractKeySegments(key)
  let suffix = segments.last ?? ""
  if case .number = value, contractSafeNumericSecretSuffixes.contains(suffix) { return true }
  if case .bool = value, segments.count > 1 { return true }
  let normalized = normalizeContractKey(key)
  let compoundTokenKey = normalized != "token" && normalized != "tokens"
    && segments.contains(where: { $0 == "token" || $0 == "tokens" })
  if compoundTokenKey {
    if case .number = value { return true }
    if case .bool = value { return true }
  }
  return false
}

private func parentNamesContractSecret(parent: [String: RaviJSON]?, value: RaviJSON) -> Bool {
  guard let parent, case .string(let key)? = parent["key"] else { return false }
  return isContractSecretKey(key) && !isTypedContractSecretMetadata(key: key, value: value)
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

