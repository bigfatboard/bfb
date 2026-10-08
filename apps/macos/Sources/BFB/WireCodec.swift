// ABOUTME: Validates bounded Local RPC JSON before decoding the app's generated Codable models.
// ABOUTME: Rejects duplicate keys, malformed Unicode, unknown fields and lossy numeric coercion.

import Foundation

enum WireFailure: Error {
  case invalidEnvelope
}

indirect enum WireJSON: Equatable {
  case object([String: WireJSON])
  case array([WireJSON])
  case string(String)
  case number(String)
  case bool(Bool)
  case null

  subscript(_ key: String) -> WireJSON? {
    if case .object(let fields) = self { return fields[key] }
    return nil
  }

  var text: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  var list: [WireJSON]? {
    if case .array(let values) = self { return values }
    return nil
  }

  var integer: Int64? {
    guard case .number(let raw) = self else { return nil }
    let negative = raw.hasPrefix("-")
    let unsigned = negative ? String(raw.dropFirst()) : raw
    let parts = unsigned.lowercased().split(separator: "e", omittingEmptySubsequences: false)
    let mantissa = parts[0].split(separator: ".", omittingEmptySubsequences: false)
    var digits = mantissa.joined().drop(while: { $0 == "0" }).description
    if digits.isEmpty { return 0 }
    var exponent = 0
    if parts.count == 2 {
      let exponentText = String(parts[1])
      let magnitude = exponentText.drop(while: { $0 == "+" || $0 == "-" || $0 == "0" })
      guard magnitude.count <= 5, let parsed = Int(magnitude.isEmpty ? "0" : String(magnitude))
      else {
        return nil
      }
      exponent = exponentText.hasPrefix("-") ? -parsed : parsed
    }
    let shift = exponent - (mantissa.count == 2 ? mantissa[1].count : 0)
    if shift < 0 {
      guard -shift < digits.count, digits.suffix(-shift).allSatisfy({ $0 == "0" }) else {
        return nil
      }
      digits.removeLast(-shift)
    } else {
      guard digits.count + shift <= 19 else { return nil }
      digits += String(repeating: "0", count: shift)
    }
    return Int64((negative ? "-" : "") + digits)
  }

  func encoded() throws -> String {
    switch self {
    case .object(let fields):
      return "{"
        + (try fields.keys.sorted().map {
          try WireJSON.string($0).encoded() + ":" + fields[$0]!.encoded()
        }).joined(separator: ",") + "}"
    case .array(let values):
      return "[" + (try values.map { try $0.encoded() }).joined(separator: ",") + "]"
    case .string(let value): return String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
    case .number:
      guard let value = integer else { throw WireFailure.invalidEnvelope }
      return String(value)
    case .bool(let value): return value ? "true" : "false"
    case .null: return "null"
    }
  }

  func equivalent(to other: WireJSON) -> Bool {
    if case .number = self, case .number = other {
      return integer != nil && integer == other.integer
    }
    return self == other
  }
}

struct WireJSONParser {
  private let bytes: [UInt8]
  private var offset = 0

  init(_ data: Data, maximumBytes: Int = 64 * 1024) throws {
    guard !data.isEmpty, data.count <= maximumBytes, String(data: data, encoding: .utf8) != nil
    else {
      throw WireFailure.invalidEnvelope
    }
    bytes = Array(data)
  }

  mutating func parse() throws -> WireJSON {
    let value = try parseValue(depth: 0)
    whitespace()
    guard offset == bytes.count else { throw WireFailure.invalidEnvelope }
    return value
  }

  private mutating func whitespace() {
    while offset < bytes.count && [9, 10, 13, 32].contains(bytes[offset]) { offset += 1 }
  }

  private mutating func take(_ byte: UInt8) -> Bool {
    guard offset < bytes.count, bytes[offset] == byte else { return false }
    offset += 1
    return true
  }

  private mutating func parseValue(depth: Int) throws -> WireJSON {
    guard depth < 64 else { throw WireFailure.invalidEnvelope }
    whitespace()
    guard offset < bytes.count else { throw WireFailure.invalidEnvelope }
    if take(123) {
      whitespace()
      var fields: [String: WireJSON] = [:]
      if take(125) { return .object(fields) }
      repeat {
        whitespace()
        let key = try parseString()
        whitespace()
        guard fields[key] == nil, take(58) else { throw WireFailure.invalidEnvelope }
        fields[key] = try parseValue(depth: depth + 1)
        whitespace()
        if take(125) { return .object(fields) }
        guard take(44) else { throw WireFailure.invalidEnvelope }
      } while true
    }
    if take(91) {
      whitespace()
      var values: [WireJSON] = []
      if take(93) { return .array(values) }
      repeat {
        values.append(try parseValue(depth: depth + 1))
        whitespace()
        if take(93) { return .array(values) }
        guard take(44) else { throw WireFailure.invalidEnvelope }
      } while true
    }
    if bytes[offset] == 34 { return .string(try parseString()) }
    for (literal, value) in [
      ("true", WireJSON.bool(true)), ("false", .bool(false)), ("null", .null),
    ] {
      let text = Array(literal.utf8)
      if bytes[offset...].starts(with: text) {
        offset += text.count
        return value
      }
    }
    let start = offset
    while offset < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[offset]) {
      offset += 1
    }
    let raw = String(decoding: bytes[start..<offset], as: UTF8.self)
    guard
      raw.range(
        of: #"\A-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?\z"#, options: .regularExpression)
        != nil
    else {
      throw WireFailure.invalidEnvelope
    }
    return .number(raw)
  }

  private mutating func hexUnit() throws -> UInt16 {
    guard offset + 4 <= bytes.count else { throw WireFailure.invalidEnvelope }
    let text = String(decoding: bytes[offset..<(offset + 4)], as: UTF8.self)
    guard
      text.utf8.allSatisfy({
        (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
      }),
      let unit = UInt16(text, radix: 16)
    else { throw WireFailure.invalidEnvelope }
    offset += 4
    return unit
  }

  private mutating func parseString() throws -> String {
    let start = offset
    guard take(34) else { throw WireFailure.invalidEnvelope }
    while offset < bytes.count {
      if take(34) {
        return try JSONDecoder().decode(String.self, from: Data(bytes[start..<offset]))
      }
      guard bytes[offset] >= 32 else { throw WireFailure.invalidEnvelope }
      if take(92) {
        if take(117) {
          let unit = try hexUnit()
          if (0xD800...0xDBFF).contains(unit) {
            guard take(92), take(117), (0xDC00...0xDFFF).contains(try hexUnit()) else {
              throw WireFailure.invalidEnvelope
            }
          } else if (0xDC00...0xDFFF).contains(unit) {
            throw WireFailure.invalidEnvelope
          }
        } else {
          guard offset < bytes.count, [34, 47, 92, 98, 102, 110, 114, 116].contains(bytes[offset])
          else {
            throw WireFailure.invalidEnvelope
          }
          offset += 1
        }
      } else {
        offset += 1
      }
    }
    throw WireFailure.invalidEnvelope
  }
}

struct WireSchemaValidator {
  private let schemas: WireJSON

  init() throws {
    var parser = try WireJSONParser(Data(WireSchemas.json.utf8), maximumBytes: 1024 * 1024)
    schemas = try parser.parse()
  }

  func accepts(_ value: WireJSON, schema: WireJSON? = nil, owner: String = "local-rpc.json") -> Bool
  {
    guard let schema = schema ?? schemas[owner] else { return false }
    if let ref = schema["$ref"]?.text {
      let parts = ref.split(separator: "#", omittingEmptySubsequences: false)
      let file = parts[0].isEmpty ? owner : String(parts[0])
      var target = schemas[file]
      if parts.count == 2 {
        for component in parts[1].split(separator: "/") { target = target?[String(component)] }
      }
      guard let target, accepts(value, schema: target, owner: file) else { return false }
    }
    if let constant = schema["const"], !value.equivalent(to: constant) { return false }
    if let choices = schema["enum"]?.list, !choices.contains(where: { value.equivalent(to: $0) }) {
      return false
    }
    if let all = schema["allOf"]?.list,
      !all.allSatisfy({ accepts(value, schema: $0, owner: owner) })
    {
      return false
    }
    if let any = schema["anyOf"]?.list,
      !any.contains(where: { accepts(value, schema: $0, owner: owner) })
    {
      return false
    }
    if let not = schema["not"], accepts(value, schema: not, owner: owner) { return false }
    if let condition = schema["if"], accepts(value, schema: condition, owner: owner),
      let then = schema["then"], !accepts(value, schema: then, owner: owner)
    {
      return false
    }
    if let type = schema["type"] {
      let names = type.list?.compactMap(\.text) ?? [type.text ?? ""]
      guard names.contains(where: { matches(value, type: $0) }) else { return false }
    }
    switch value {
    case .object(let fields):
      if let max = schema["maxProperties"]?.integer, fields.count > max { return false }
      if let required = schema["required"]?.list,
        !required.allSatisfy({ fields[$0.text ?? ""] != nil })
      {
        return false
      }
      for (key, child) in fields {
        if let property = schema["properties"]?[key] {
          if !accepts(child, schema: property, owner: owner) { return false }
        } else if schema["additionalProperties"] == .bool(false) {
          return false
        }
      }
    case .array(let values):
      if let min = schema["minItems"]?.integer, values.count < min { return false }
      if let max = schema["maxItems"]?.integer, values.count > max { return false }
      if schema["uniqueItems"] == .bool(true) {
        for index in values.indices where values[..<index].contains(values[index]) { return false }
      }
      if let item = schema["items"], !values.allSatisfy({ accepts($0, schema: item, owner: owner) })
      {
        return false
      }
    case .string(let text):
      if let min = schema["minLength"]?.integer, text.unicodeScalars.count < min { return false }
      if let max = schema["maxLength"]?.integer, text.unicodeScalars.count > max { return false }
      if let pattern = schema["pattern"]?.text {
        // ECMAScript's ASCII character classes and absolute wire bounds, not ICU's final-newline shortcut.
        let strict = pattern.replacingOccurrences(of: "$", with: #"\z"#)
        guard text.range(of: strict, options: .regularExpression) != nil else { return false }
      }
      if schema["format"]?.text == "date-time", !validTimestamp(text) { return false }
    case .number:
      guard let integer = value.integer else { return false }
      if let min = schema["minimum"]?.integer, integer < min { return false }
      if let max = schema["maximum"]?.integer, integer > max { return false }
    default: break
    }
    return true
  }

  private func matches(_ value: WireJSON, type: String) -> Bool {
    switch (value, type) {
    case (.object, "object"), (.array, "array"), (.string, "string"), (.bool, "boolean"),
      (.null, "null"):
      return true
    case (.number, "integer"): return value.integer != nil
    default: return false
    }
  }

  private func validTimestamp(_ text: String) -> Bool {
    let parts = text.prefix(19).split(whereSeparator: { "-T:".contains($0) }).compactMap { Int($0) }
    guard parts.count == 6 else { return false }
    let year = parts[0]
    let month = parts[1]
    let day = parts[2]
    guard (1...12).contains(month), (0...23).contains(parts[3]), (0...59).contains(parts[4]),
      (0...59).contains(parts[5])
    else { return false }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
    let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return (1...days[month - 1]).contains(day)
  }
}

enum WireCodec {
  static func decode(_ data: Data) throws -> WireLocalRpcEnvelope {
    var parser = try WireJSONParser(data)
    let value = try parser.parse()
    guard try WireSchemaValidator().accepts(value) else { throw WireFailure.invalidEnvelope }
    return try JSONDecoder().decode(WireLocalRpcEnvelope.self, from: Data(value.encoded().utf8))
  }

  static func encode(_ envelope: WireLocalRpcEnvelope) throws -> Data {
    let data = try JSONEncoder().encode(envelope)
    _ = try decode(data)
    return data + Data([10])
  }
}
