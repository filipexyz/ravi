import Foundation

public enum RaviJSON: Codable, Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([RaviJSON])
  case object([String: RaviJSON])

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
      return
    }
    if let value = try? container.decode(Bool.self) {
      self = .bool(value)
      return
    }
    if let value = try? container.decode(Double.self) {
      self = .number(value)
      return
    }
    if let value = try? container.decode(String.self) {
      self = .string(value)
      return
    }
    if let value = try? container.decode([RaviJSON].self) {
      self = .array(value)
      return
    }
    if let value = try? container.decode([String: RaviJSON].self) {
      self = .object(value)
      return
    }
    throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null:
      try container.encodeNil()
    case .bool(let value):
      try container.encode(value)
    case .number(let value):
      try container.encode(value)
    case .string(let value):
      try container.encode(value)
    case .array(let value):
      try container.encode(value)
    case .object(let value):
      try container.encode(value)
    }
  }

  public static func fromEncodable<T: Encodable>(_ value: T) throws -> RaviJSON {
    if let json = value as? RaviJSON {
      return json
    }
    let data = try JSONEncoder().encode(EncodableBox(value))
    let foundation = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    return try fromFoundation(foundation)
  }

  static func fromFoundation(_ value: Any) throws -> RaviJSON {
    switch value {
    case is NSNull:
      return .null
    case let value as Bool:
      return .bool(value)
    case let value as NSNumber:
      return .number(value.doubleValue)
    case let value as String:
      return .string(value)
    case let value as [Any]:
      return .array(try value.map(fromFoundation))
    case let value as [String: Any]:
      return .object(try value.mapValues(fromFoundation))
    default:
      throw EncodingError.invalidValue(
        value,
        EncodingError.Context(codingPath: [], debugDescription: "Unsupported JSON value")
      )
    }
  }
}

private struct EncodableBox<Value: Encodable>: Encodable {
  let value: Value

  init(_ value: Value) {
    self.value = value
  }

  func encode(to encoder: Encoder) throws {
    try value.encode(to: encoder)
  }
}
