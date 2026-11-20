import Foundation

/// Free-form JSON: request bodies where `null` matters (PATCH clears a field with null, omits it to keep it)
/// and response fields typed `unknown` / `Record<string, unknown>` on the web.
///
///     try await api.send(.patch, "/api/tasks/\(id)", json: ["dueDate": .null, "title": "새 제목"])
enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value") }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case let .bool(b): try c.encode(b)
        case let .number(n):
            if n.rounded() == n, abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case let .string(s): try c.encode(s)
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
        }
    }

    // MARK: reading

    subscript(key: String) -> JSONValue? {
        if case let .object(o) = self { return o[key] }
        return nil
    }

    subscript(index: Int) -> JSONValue? {
        if case let .array(a) = self, a.indices.contains(index) { return a[index] }
        return nil
    }

    var string: String? { if case let .string(s) = self { return s }; return nil }
    var double: Double? { if case let .number(n) = self { return n }; return nil }
    var int: Int? { double.map { Int($0) } }
    var bool: Bool? { if case let .bool(b) = self { return b }; return nil }
    var array: [JSONValue]? { if case let .array(a) = self { return a }; return nil }
    var object: [String: JSONValue]? { if case let .object(o) = self { return o }; return nil }
    var isNull: Bool { self == .null }

    // MARK: building

    /// An optional that encodes nil as JSON `null` (for PATCH bodies).
    static func orNull(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }
    static func orNull(_ n: Int?) -> JSONValue { n.map { .number(Double($0)) } ?? .null }

    /// Any Encodable value as JSON (round-trips through JSONEncoder).
    static func from<T: Encodable>(_ value: T) throws -> JSONValue {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Decode this JSON into a Decodable type.
    func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let data = try JSONEncoder().encode(self)
        return try JSONDecoder().decode(type, from: data)
    }
}

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
    init(nilLiteral: ()) { self = .null }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(floatLiteral value: Double) { self = .number(value) }
    init(stringLiteral value: String) { self = .string(value) }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, b in b }))
    }
}
