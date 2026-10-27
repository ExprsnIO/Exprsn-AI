import Foundation

/// A dynamic JSON value. The console's admin screens read hundreds of route shapes; the native app keeps typed
/// models for the screens it draws by hand and reads everything else through this type.
enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Builds a value from the Foundation types `JSONSerialization` produces.
    init(any: Any?) {
        switch any {
        case nil, is NSNull: self = .null
        case let s as String: self = .string(s)
        case let b as Bool: self = .bool(b)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
        case let i as Int: self = .number(Double(i))
        case let d as Double: self = .number(d)
        case let a as [Any]: self = .array(a.map { JSONValue(any: $0) })
        case let o as [String: Any]: self = .object(o.mapValues { JSONValue(any: $0) })
        case let v as JSONValue: self = v
        default: self = .string(String(describing: any!))
        }
    }

    subscript(key: String) -> JSONValue {
        if case .object(let o) = self { return o[key] ?? .null }
        return .null
    }

    subscript(index: Int) -> JSONValue {
        if case .array(let a) = self, a.indices.contains(index) { return a[index] }
        return .null
    }

    /// Reads a dotted path such as `usage.promptTokens`.
    func at(_ path: String) -> JSONValue {
        path.split(separator: ".").reduce(self) { $0[String($1)] }
    }

    var isNull: Bool { if case .null = self { return true }; return false }
    var string: String? { if case .string(let s) = self { return s }; return nil }
    var double: Double? {
        switch self {
        case .number(let n): return n
        case .string(let s): return Double(s)
        default: return nil
        }
    }
    var int: Int? { double.map { Int($0) } }
    var bool: Bool? {
        switch self {
        case .bool(let b): return b
        case .string(let s): return s == "true" ? true : s == "false" ? false : nil
        case .number(let n): return n != 0
        default: return nil
        }
    }
    var array: [JSONValue] { if case .array(let a) = self { return a }; return [] }
    var object: [String: JSONValue] { if case .object(let o) = self { return o }; return [:] }
    var isContainer: Bool {
        switch self { case .array, .object: return true; default: return false }
    }

    /// Epoch milliseconds, ISO 8601 strings and `YYYY-MM-DD` days all read as dates.
    var date: Date? {
        switch self {
        case .number(let n): return n > 10_000_000_000 ? Date(timeIntervalSince1970: n / 1000) : Date(timeIntervalSince1970: n)
        case .string(let s):
            if let d = ISO8601DateFormatter.withFractional.date(from: s) ?? ISO8601DateFormatter.plain.date(from: s) { return d }
            if let n = Double(s) { return JSONValue.number(n).date }
            return nil
        default: return nil
        }
    }

    /// One line of text for a table cell or a key-value row.
    var text: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "Yes" : "No"
        case .null: return ""
        case .array(let a): return a.count == 0 ? "" : a.allSatisfy({ !$0.isContainer }) ? a.map(\.text).joined(separator: ", ") : "\(a.count) items"
        case .object(let o):
            if let name = o["name"]?.string ?? o["displayName"]?.string ?? o["title"]?.string { return name }
            return "\(o.count) fields"
        }
    }

    var prettyPrinted: String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? enc.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? text
    }

    var data: Data { (try? JSONEncoder().encode(self)) ?? Data() }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(floatLiteral value: Double) { self = .number(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { $1 })) }
    init(nilLiteral: ()) { self = .null }
}

extension ISO8601DateFormatter {
    static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
}

/// Helpers for building request bodies without a Codable type per route.
func json(_ pairs: KeyValuePairs<String, JSONValue?>) -> JSONValue {
    var o: [String: JSONValue] = [:]
    for (k, v) in pairs { if let v { o[k] = v } }
    return .object(o)
}
