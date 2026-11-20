import Foundation

// JavaScript-compatible building blocks for the Core port. The web code works on UTF-16 strings with
// JS regex semantics; these helpers reproduce exactly that so Korean text, slices and matches line up
// with the TypeScript. Internal plumbing: screens should not need anything in here.

enum JS {
    /// The characters JavaScript's `\s` and `String.prototype.trim` treat as white space.
    static let whitespace: Set<UInt16> = [
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680,
        0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
        0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
    ]

    /// The body of a character class equal to JS `\s` (for ICU patterns).
    static let spaceClassBody = "\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}"

    /// `s.length`
    static func length(_ s: String) -> Int { s.utf16.count }

    /// `s.trim()`
    static func trim(_ s: String) -> String {
        let u = Array(s.utf16)
        var a = 0
        var b = u.count
        while a < b, whitespace.contains(u[a]) { a += 1 }
        while b > a, whitespace.contains(u[b - 1]) { b -= 1 }
        if a == 0, b == u.count { return s }
        return String(decoding: u[a ..< b], as: UTF16.self)
    }

    /// `s.slice(start, end)` with JS index rules (negative counts from the end), on UTF-16 units.
    static func slice(_ s: String, _ start: Int, _ end: Int? = nil) -> String {
        let u = Array(s.utf16)
        let n = u.count
        func clampIndex(_ i: Int) -> Int { i < 0 ? max(0, n + i) : min(i, n) }
        let from = clampIndex(start)
        let to = end.map(clampIndex) ?? n
        if from >= to { return "" }
        return String(decoding: u[from ..< to], as: UTF16.self)
    }

    /// `String(n).padStart(width, '0')`
    static func pad(_ n: Int, _ width: Int = 2) -> String {
        let s = String(n)
        let count = s.utf16.count
        return count >= width ? s : String(repeating: "0", count: width - count) + s
    }

    /// `s.padStart(width, fill)`
    static func padStart(_ s: String, _ width: Int, _ fill: String = " ") -> String {
        let count = s.utf16.count
        if count >= width || fill.isEmpty { return s }
        var prefix = ""
        while prefix.utf16.count < width - count { prefix += fill }
        return slice(prefix, 0, width - count) + s
    }

    /// `a.includes(b)` (code-unit search, no Unicode normalisation).
    static func includes(_ a: String, _ b: String) -> Bool {
        if b.isEmpty { return true }
        return (a as NSString).range(of: b, options: .literal).location != NSNotFound
    }

    /// `a.startsWith(b)`
    static func startsWith(_ a: String, _ b: String) -> Bool { a.utf16.starts(with: b.utf16) }

    /// `a.endsWith(b)`
    static func endsWith(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf16)
        let y = Array(b.utf16)
        return y.count <= x.count && Array(x[(x.count - y.count)...]) == y
    }

    /// `s.split(sep)` with a plain string separator.
    static func split(_ s: String, _ sep: String) -> [String] {
        s.components(separatedBy: sep)
    }

    /// `String(n)` for a JS number.
    static func numberString(_ d: Double) -> String {
        if d.isNaN { return "NaN" }
        if d.isInfinite { return d > 0 ? "Infinity" : "-Infinity" }
        if d == d.rounded(), abs(d) < 1e21 { return String(Int64(d)) }
        return "\(d)"
    }

    /// `String(v)` for a JSON value (nil = `undefined`).
    static func string(_ v: JSONValue?) -> String {
        guard let v else { return "undefined" }
        switch v {
        case .null: return "null"
        case let .bool(b): return b ? "true" : "false"
        case let .number(n): return numberString(n)
        case let .string(s): return s
        case let .array(a):
            return a.map { item -> String in
                if item == .null { return "" }
                return string(item)
            }.joined(separator: ",")
        case .object: return "[object Object]"
        }
    }

    /// `!!v` for a JSON value (nil = `undefined`).
    static func truthy(_ v: JSONValue?) -> Bool {
        guard let v else { return false }
        switch v {
        case .null: return false
        case let .bool(b): return b
        case let .number(n): return n != 0 && !n.isNaN
        case let .string(s): return !s.isEmpty
        case .array, .object: return true
        }
    }

    /// `Number(v)` for a JSON value (nil = `undefined` → NaN).
    static func number(_ v: JSONValue?) -> Double {
        guard let v else { return .nan }
        switch v {
        case .null: return 0
        case let .bool(b): return b ? 1 : 0
        case let .number(n): return n
        case let .string(s):
            let t = trim(s)
            if t.isEmpty { return 0 }
            return Double(t) ?? .nan
        case let .array(a):
            if a.isEmpty { return 0 }
            if a.count == 1 { return number(.string(string(a[0]))) }
            return .nan
        case .object: return .nan
        }
    }

    /// `a ?? b` for JSON values: only `undefined` and `null` fall through.
    static func coalesce(_ a: JSONValue?, _ b: JSONValue?) -> JSONValue? {
        if let a, a != .null { return a }
        return b
    }

    /// Array.prototype.sort with a comparator: stable, like every modern JS engine.
    static func sorted<T>(_ list: [T], _ compare: (T, T) -> Int) -> [T] {
        list.enumerated()
            .sorted { x, y in
                let c = compare(x.element, y.element)
                return c != 0 ? c < 0 : x.offset < y.offset
            }
            .map(\.element)
    }

    /// Double-valued comparator variant (`(a, b) => b.score - a.score`).
    static func sorted<T>(_ list: [T], by compare: (T, T) -> Double) -> [T] {
        list.enumerated()
            .sorted { x, y in
                let c = compare(x.element, y.element)
                return c != 0 && !c.isNaN ? c < 0 : x.offset < y.offset
            }
            .map(\.element)
    }
}

extension Optional where Wrapped == String {
    /// JavaScript truthiness of a string that may be null: nil and "" are false.
    var jsTruthy: Bool {
        switch self {
        case .none: false
        case let .some(s): !s.isEmpty
        }
    }
}

/// A regular expression with JavaScript semantics, on UTF-16 indices (NSRegularExpression underneath).
///
/// Patterns are written as in the TypeScript. They are translated so that `\d` is ASCII only, `\s`/`\S`
/// use JavaScript's white-space set and an unescaped `$` matches only at the very end (no `m` flag).
final class JSRegex: @unchecked Sendable {
    let regex: NSRegularExpression

    init(_ pattern: String, ignoreCase: Bool = false, dotAll: Bool = false) {
        var options: NSRegularExpression.Options = []
        if ignoreCase { options.insert(.caseInsensitive) }
        if dotAll { options.insert(.dotMatchesLineSeparators) }
        do {
            regex = try NSRegularExpression(pattern: JSRegex.translate(pattern), options: options)
        } catch {
            fatalError("Invalid regex \(pattern): \(error)")
        }
    }

    private static func translate(_ p: String) -> String {
        var out = ""
        var inClass = false
        var chars = Array(p)
        var i = 0
        chars.append("\0")
        while i < chars.count - 1 {
            let c = chars[i]
            if c == "\\" {
                let n = chars[i + 1]
                switch n {
                case "d": out += inClass ? "0-9" : "[0-9]"
                case "D": out += "[^0-9]"
                case "s": out += inClass ? JS.spaceClassBody : "[\(JS.spaceClassBody)]"
                case "S": out += "[^\(JS.spaceClassBody)]"
                default: out += "\\\(n)"
                }
                i += 2
                continue
            }
            if inClass {
                if c == "]" { inClass = false }
                out.append(c)
            } else if c == "[" {
                inClass = true
                out.append(c)
                // A literal "]" right after "[" or "[^" is part of the class in ICU but closes it in JS;
                // none of the ported patterns use that form.
            } else if c == "$" {
                out += "(?![\\s\\S])"
            } else {
                out.append(c)
            }
            i += 1
        }
        return out
    }

    /// `re.exec(s)`: index 0 is the whole match, then each group (nil when it did not take part).
    func exec(_ s: String) -> [String?]? {
        let ns = s as NSString
        guard let m = regex.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0 ..< m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
    }

    /// `re.test(s)`
    func test(_ s: String) -> Bool {
        let ns = s as NSString
        return regex.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) != nil
    }

    /// `s.replace(re, replacement)` (first match only, no `$` templates).
    func replaceFirst(_ s: String, _ replacement: String) -> String {
        let ns = s as NSString
        guard let m = regex.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) else { return s }
        return ns.replacingCharacters(in: m.range, with: replacement)
    }

    /// `s.replace(/…/g, replacement)` with a fixed replacement string.
    func replaceAll(_ s: String, _ replacement: String) -> String {
        let ns = s as NSString
        return regex.stringByReplacingMatches(
            in: s, options: [], range: NSRange(location: 0, length: ns.length),
            withTemplate: NSRegularExpression.escapedTemplate(for: replacement)
        )
    }

    /// `s.replace(/…/g, fn)` where the function sees the groups (index 0 = whole match).
    func replaceAll(_ s: String, _ transform: ([String?]) -> String) -> String {
        let ns = s as NSString
        var out = ""
        var last = 0
        for m in regex.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let groups: [String?] = (0 ..< m.numberOfRanges).map { i in
                let r = m.range(at: i)
                return r.location == NSNotFound ? nil : ns.substring(with: r)
            }
            out += transform(groups)
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    /// `s.split(re)` for patterns without capture groups.
    func split(_ s: String) -> [String] {
        let ns = s as NSString
        var out: [String] = []
        var last = 0
        for m in regex.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length)) {
            if m.range.length == 0 { continue }
            out.append(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
            last = m.range.location + m.range.length
        }
        out.append(ns.substring(from: last))
        return out
    }
}

extension JS {
    /// `Math.round(x)`: halves round toward +∞.
    static func round(_ x: Double) -> Double { (x + 0.5).rounded(.down) }
}

/// The parts of a WHATWG `new URL(s)` the Core reads. nil where JavaScript's URL constructor throws
/// (no scheme, or an http(s)/ws(s)/ftp URL without a host). Close to, not a full copy of, the WHATWG parser.
struct JSURL: Hashable, Sendable {
    /// "https:"
    var `protocol`: String
    /// Lower-cased host name without the port.
    var hostname: String
    /// Host name plus a non-default port ("example.com:8080").
    var host: String
    /// Percent-encoded path, "/" for an empty path on http(s).
    var pathname: String

    private static let special: [String: Int?] = ["http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21, "file": nil]

    init?(_ string: String) {
        let s = JS.trim(string)
        guard let c = URLComponents(string: s), let scheme = c.scheme?.lowercased(), !scheme.isEmpty else { return nil }
        let isSpecial = JSURL.special.keys.contains(scheme)
        let name = (c.percentEncodedHost ?? "").lowercased()
        if isSpecial, scheme != "file", name.isEmpty { return nil }
        self.protocol = "\(scheme):"
        hostname = name
        var host = name
        if let port = c.port {
            let defaultPort = JSURL.special[scheme] ?? nil
            if defaultPort != port { host += ":\(port)" }
        }
        self.host = host
        let path = c.percentEncodedPath
        pathname = isSpecial && path.isEmpty ? "/" : path
    }
}

extension JS {
    private static let isoDateTime = JSRegex(
        "^(\\d{4})-(\\d{2})-(\\d{2})(?:[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?)?(Z|[+-]\\d{2}:?\\d{2})?$",
        ignoreCase: true
    )

    /// `new Date(s)` for the ISO 8601 forms the app meets ("2026-11-13", "2026-11-13T06:30:00.000Z",
    /// "2026-11-20T15:30+09:00"); nil where JavaScript gives an Invalid Date. Like JS, a date alone is UTC
    /// and a date-time without an offset is local time (`localZone`).
    static func parseDate(_ s: String, localZone: TimeZone = .current) -> Date? {
        guard let m = isoDateTime.exec(s) else { return nil }
        let y = Int(m[1]!)!, mo = Int(m[2]!)!, d = Int(m[3]!)!
        guard (1 ... 12).contains(mo), d >= 1, d <= 31 else { return nil }
        let day = toDay("\(m[1]!)-\(m[2]!)-\(m[3]!)")
        guard fromDay(day) == "\(y)-\(m[2]!)-\(m[3]!)" || y < 1000 else { return nil }
        let h = Int(m[4] ?? "0")!, mi = Int(m[5] ?? "0")!, sec = Int(m[6] ?? "0")!
        guard h <= 24, mi <= 59, sec <= 59, h < 24 || (mi == 0 && sec == 0) else { return nil }
        if m[4] != nil, m[5] == nil { return nil }
        var ms = 0.0
        if let frac = m[7] { ms = (Double("0." + frac) ?? 0) * 1000 }
        var seconds = Double(day) * 86400 + Double(h * 3600 + mi * 60 + sec) + ms.rounded(.down) / 1000
        if let off = m[8] {
            if off.uppercased() != "Z" {
                let digits = off.dropFirst().filter { $0 != ":" }
                let oh = Int(digits.prefix(2))!, om = Int(digits.suffix(2))!
                guard oh <= 23, om <= 59 else { return nil }
                let sign: Double = off.hasPrefix("-") ? -1 : 1
                seconds -= sign * Double(oh * 3600 + om * 60)
            }
        } else if m[4] != nil {
            // Local wall-clock time: find the instant whose offset makes it read this time.
            let guess = Date(timeIntervalSince1970: seconds)
            let offset = Double(localZone.secondsFromGMT(for: guess))
            let adjusted = Date(timeIntervalSince1970: seconds - offset)
            seconds -= Double(localZone.secondsFromGMT(for: adjusted))
        }
        return Date(timeIntervalSince1970: seconds)
    }
}

extension KeyedEncodingContainer {
    /// Tri-state field: nil = omit the key, `.some(nil)` = JSON null, `.some(v)` = v.
    mutating func encodeTriState<T: Encodable>(_ v: T??, forKey key: Key) throws {
        guard let v else { return }
        if let x = v { try encode(x, forKey: key) } else { try encodeNil(forKey: key) }
    }
}

extension KeyedDecodingContainer {
    /// Tri-state field: missing key = nil, JSON null = `.some(nil)`.
    func decodeTriState<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T?? {
        guard contains(key) else { return nil }
        if try decodeNil(forKey: key) { return .some(nil) }
        return .some(try decode(T.self, forKey: key))
    }
}
