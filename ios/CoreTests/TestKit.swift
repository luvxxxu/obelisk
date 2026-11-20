import Foundation

// A tiny test harness: `test("name") { … }` groups expectations; failures print and the run exits non-zero.

enum TestRun {
    static var passed = 0
    static var failedTests = 0
    static var failures = 0
    static var current = ""
    static var suite = ""
}

func describe(_ name: String, _ body: () -> Void) {
    let outer = TestRun.suite
    TestRun.suite = outer.isEmpty ? name : "\(outer) › \(name)"
    body()
    TestRun.suite = outer
}

func test(_ name: String, _ body: () throws -> Void) {
    TestRun.current = TestRun.suite.isEmpty ? name : "\(TestRun.suite) › \(name)"
    let before = TestRun.failures
    do { try body() } catch { report("threw \(error)", "", 0) }
    if TestRun.failures == before { TestRun.passed += 1 } else { TestRun.failedTests += 1 }
}

private func report(_ message: String, _ file: String, _ line: UInt) {
    TestRun.failures += 1
    print("✗ \(TestRun.current)\n    \(message)\(file.isEmpty ? "" : "  (\(file):\(line))")")
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ note: String = "", file: StaticString = #fileID, line: UInt = #line) {
    if actual != expected {
        report("expected \(expected)\n    got      \(actual)\(note.isEmpty ? "" : "  [\(note)]")", "\(file)", line)
    }
}

func expectTrue(_ cond: Bool, _ note: String = "", file: StaticString = #fileID, line: UInt = #line) {
    if !cond { report("expected true\(note.isEmpty ? "" : ": \(note)")", "\(file)", line) }
}

func expectFalse(_ cond: Bool, _ note: String = "", file: StaticString = #fileID, line: UInt = #line) {
    if cond { report("expected false\(note.isEmpty ? "" : ": \(note)")", "\(file)", line) }
}

func expectNil<T>(_ v: T?, _ note: String = "", file: StaticString = #fileID, line: UInt = #line) {
    if let v { report("expected nil, got \(v)\(note.isEmpty ? "" : "  [\(note)]")", "\(file)", line) }
}

func expectContains(_ s: String, _ part: String, file: StaticString = #fileID, line: UInt = #line) {
    if !s.contains(part) { report("expected \"\(s)\" to contain \"\(part)\"", "\(file)", line) }
}

/// Unwrap or record a failure and throw (ends the test).
struct Missing: Error, CustomStringConvertible {
    let what: String
    var description: String { "missing \(what)" }
}

func unwrap<T>(_ v: T?, _ what: String = "value", file: StaticString = #fileID, line: UInt = #line) throws -> T {
    guard let v else {
        report("unexpected nil: \(what)", "\(file)", line)
        throw Missing(what: what)
    }
    return v
}

/// Object keys holding null removed, recursively (Swift omits nil optionals; JS writes null).
func stripNulls(_ v: JSONValue) -> JSONValue {
    switch v {
    case let .object(o): return .object(o.compactMapValues { $0 == .null ? Optional<JSONValue>.none : stripNulls($0) })
    case let .array(a): return .array(a.map(stripNulls))
    default: return v
    }
}

private func encodeSorted(_ v: JSONValue) -> String {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: (try? enc.encode(v)) ?? Data(), as: UTF8.self)
}

/// Canonical JSON text for comparing a Codable value with TS output (sorted keys, null keys dropped).
func canonicalJSON<T: Encodable>(_ v: T) -> String {
    guard let j = try? JSONValue.from(v) else { return "<unencodable>" }
    return encodeSorted(stripNulls(j))
}

/// Canonical JSON text of a JSON string (to compare with `canonicalJSON`).
func canonicalJSON(text: String) -> String {
    guard let v = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return "<bad json: \(text)>" }
    return encodeSorted(stripNulls(v))
}
