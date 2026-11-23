import Foundation
import CoreGraphics

let helperVersion = "0.1.0"

// MARK: - Errors

struct HelperError: Error, CustomStringConvertible {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    static func invalid(_ m: String) -> HelperError { HelperError("invalid_params", m) }
    static func notFound(_ m: String) -> HelperError { HelperError("not_found", m) }
    static func denied(_ m: String) -> HelperError { HelperError("permission_denied", m) }
    static func failed(_ m: String) -> HelperError { HelperError("failed", m) }

    var description: String { "\(code): \(message)" }
}

// MARK: - Logging (stderr only; stdout is reserved for protocol lines)

func logErr(_ s: String) {
    fputs("[appubot-helper] \(s)\n", stderr)
}

/// Thread-safe mutable box used to get values out of completion handlers.
final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ v: T) { value = v }
}

// MARK: - Output

final class Output: @unchecked Sendable {
    static let shared = Output()
    private let lock = NSLock()

    func send(_ obj: [String: Any]) {
        let clean = sanitizeJSON(obj)
        var data: Data
        if JSONSerialization.isValidJSONObject(clean),
           let d = try? JSONSerialization.data(withJSONObject: clean, options: [.withoutEscapingSlashes]) {
            data = d
        } else {
            logErr("failed to serialize response; sending internal_error")
            var fallback: [String: Any] = [
                "ok": false,
                "error": ["code": "internal_error", "message": "response could not be serialized to JSON"],
            ]
            if let id = obj["id"], JSONSerialization.isValidJSONObject(["id": id]) { fallback["id"] = id } else { fallback["id"] = NSNull() }
            data = (try? JSONSerialization.data(withJSONObject: fallback, options: [])) ?? Data("{\"id\":null,\"ok\":false}".utf8)
        }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            guard let base = buf.baseAddress else { return }
            var off = 0
            while off < buf.count {
                let n = write(STDOUT_FILENO, base + off, buf.count - off)
                if n < 0 {
                    if errno == EINTR || errno == EAGAIN { continue }
                    // stdout is gone (parent died) -> nothing useful left to do.
                    exit(0)
                }
                off += n
            }
        }
    }

    func event(_ name: String, _ fields: [String: Any]) {
        var o = fields
        o["event"] = name
        send(o)
    }
}

/// Recursively converts a value into something JSONSerialization accepts
/// (replaces NaN/Inf with null, unwraps optionals, stringifies unknown types).
func sanitizeJSON(_ v: Any) -> Any {
    switch v {
    case let s as String:
        return s
    case let d as [String: Any]:
        var o = [String: Any](minimumCapacity: d.count)
        for (k, x) in d { o[k] = sanitizeJSON(x) }
        return o
    case let a as [Any]:
        return a.map(sanitizeJSON)
    case is NSNull:
        return v
    case let n as NSNumber:
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n }
        return n.doubleValue.isFinite ? n : NSNull()
    default:
        let m = Mirror(reflecting: v)
        if m.displayStyle == .optional {
            if let c = m.children.first { return sanitizeJSON(c.value) }
            return NSNull()
        }
        return String(describing: v)
    }
}

// MARK: - Params

struct Params {
    let raw: [String: Any]

    init(_ raw: [String: Any]) { self.raw = raw }

    private func value(_ k: String) -> Any? {
        guard let v = raw[k], !(v is NSNull) else { return nil }
        return v
    }

    func has(_ k: String) -> Bool { value(k) != nil }

    func double(_ k: String) throws -> Double? {
        guard let v = value(k) else { return nil }
        if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
            let d = n.doubleValue
            guard d.isFinite else { throw HelperError.invalid("'\(k)' must be a finite number") }
            return d
        }
        if let s = v as? String, let d = Double(s.trimmingCharacters(in: .whitespaces)), d.isFinite { return d }
        throw HelperError.invalid("'\(k)' must be a number, got \(describeType(v))")
    }

    func reqDouble(_ k: String) throws -> Double {
        guard let d = try double(k) else { throw HelperError.invalid("missing required number '\(k)'") }
        return d
    }

    func int(_ k: String) throws -> Int? {
        guard let d = try double(k) else { return nil }
        guard d >= Double(Int.min), d <= Double(Int.max) else { throw HelperError.invalid("'\(k)' is out of range") }
        return Int(d)
    }

    func reqInt(_ k: String) throws -> Int {
        guard let i = try int(k) else { throw HelperError.invalid("missing required integer '\(k)'") }
        return i
    }

    func string(_ k: String) throws -> String? {
        guard let v = value(k) else { return nil }
        if let s = v as? String { return s }
        throw HelperError.invalid("'\(k)' must be a string, got \(describeType(v))")
    }

    func reqString(_ k: String) throws -> String {
        guard let s = try string(k) else { throw HelperError.invalid("missing required string '\(k)'") }
        return s
    }

    func bool(_ k: String) throws -> Bool? {
        guard let v = value(k) else { return nil }
        if let n = v as? NSNumber { return n.boolValue }
        if let s = v as? String {
            switch s.lowercased() {
            case "true", "yes", "1": return true
            case "false", "no", "0": return false
            default: break
            }
        }
        throw HelperError.invalid("'\(k)' must be a boolean, got \(describeType(v))")
    }

    func dict(_ k: String) throws -> [String: Any]? {
        guard let v = value(k) else { return nil }
        if let d = v as? [String: Any] { return d }
        throw HelperError.invalid("'\(k)' must be an object, got \(describeType(v))")
    }

    func array(_ k: String) throws -> [Any]? {
        guard let v = value(k) else { return nil }
        if let a = v as? [Any] { return a }
        throw HelperError.invalid("'\(k)' must be an array, got \(describeType(v))")
    }

    /// Accepts an array of strings, or a single string (split on '+' or ',').
    func stringList(_ k: String) throws -> [String]? {
        guard let v = value(k) else { return nil }
        if let s = v as? String {
            return s.split(whereSeparator: { $0 == "," || $0 == "+" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        if let a = v as? [Any] {
            return try a.map { item in
                if let s = item as? String { return s }
                if let n = item as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n.stringValue }
                throw HelperError.invalid("'\(k)' must be an array of strings")
            }
        }
        throw HelperError.invalid("'\(k)' must be an array of strings, got \(describeType(v))")
    }

    func point(_ k: String) throws -> CGPoint? {
        guard let d = try dict(k) else { return nil }
        let p = Params(d)
        do {
            return CGPoint(x: try p.reqDouble("x"), y: try p.reqDouble("y"))
        } catch let e as HelperError {
            throw HelperError.invalid("'\(k)': \(e.message)")
        }
    }

    func rect(_ k: String) throws -> CGRect? {
        guard let d = try dict(k) else { return nil }
        let p = Params(d)
        do {
            let w = try p.double("width") ?? p.double("w")
            let h = try p.double("height") ?? p.double("h")
            guard let w, let h else { throw HelperError.invalid("needs width and height") }
            return CGRect(x: try p.reqDouble("x"), y: try p.reqDouble("y"), width: w, height: h)
        } catch let e as HelperError {
            throw HelperError.invalid("'\(k)': \(e.message) (expected {x,y,width,height})")
        }
    }

    /// Optional x/y pair at the top level of params. Both or neither must be given.
    func xy() throws -> CGPoint? {
        let x = try double("x"), y = try double("y")
        switch (x, y) {
        case let (x?, y?): return CGPoint(x: x, y: y)
        case (nil, nil): return nil
        default: throw HelperError.invalid("both 'x' and 'y' must be provided together")
        }
    }
}

func describeType(_ v: Any) -> String {
    switch v {
    case is String: return "string"
    case let n as NSNumber: return CFGetTypeID(n) == CFBooleanGetTypeID() ? "boolean" : "number"
    case is [Any]: return "array"
    case is [String: Any]: return "object"
    default: return String(describing: type(of: v))
    }
}

// MARK: - Misc helpers

/// Rounds to 2 decimals and returns an exact decimal so JSON shows `3058.53`, not `3058.5300000000002`.
func r2(_ v: Double) -> NSDecimalNumber {
    guard v.isFinite else { return NSDecimalNumber.zero }
    let scaled = (v * 100).rounded()
    guard abs(scaled) < 9e15 else { return NSDecimalNumber(value: v) }
    return NSDecimalNumber(decimal: Decimal(Int64(scaled)) / 100)
}
func r2(_ v: CGFloat) -> NSDecimalNumber { r2(Double(v)) }

/// Rounds to 6 decimals (for scale factors, where 2 decimals would skew pixel->point mapping).
func r6(_ v: Double) -> NSDecimalNumber {
    guard v.isFinite, abs(v) < 1e9 else { return NSDecimalNumber.zero }
    return NSDecimalNumber(decimal: Decimal(Int64((v * 1_000_000).rounded())) / 1_000_000)
}

func rectDict(_ r: CGRect) -> [String: Any] {
    ["x": r2(r.origin.x), "y": r2(r.origin.y), "width": r2(r.size.width), "height": r2(r.size.height)]
}

func rectString(_ r: CGRect) -> String {
    "{x:\(r2(r.origin.x)), y:\(r2(r.origin.y)), width:\(r2(r.size.width)), height:\(r2(r.size.height))}"
}

func pointDict(_ p: CGPoint) -> [String: Any] {
    ["x": r2(p.x), "y": r2(p.y)]
}

func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

func sleepMs(_ ms: Double) {
    guard ms > 0, ms.isFinite else { return }
    usleep(useconds_t(min(ms, 600_000) * 1000))
}

func truncate(_ s: String, _ limit: Int = 200) -> String {
    if s.count <= limit { return s }
    return String(s.prefix(limit)) + "…"
}

/// Runs a process, waiting at most `timeout` seconds. Returns (status, stdout).
@discardableResult
func runProcess(_ path: String, _ args: [String], timeout: Double = 10) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return (-1, "") }
    let deadline = Date().addingTimeInterval(timeout)
    let dataBox = Box(Data())
    let readDone = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
        dataBox.value = out.fileHandleForReading.readDataToEndOfFile()
        readDone.signal()
    }
    while p.isRunning && Date() < deadline { usleep(10_000) }
    if p.isRunning { p.terminate() }
    _ = readDone.wait(timeout: .now() + 1)
    return (p.isRunning ? -1 : p.terminationStatus, String(decoding: dataBox.value, as: UTF8.self))
}

/// Wraps an optional for JSON output (nil -> null).
func orNull(_ v: Any?) -> Any { v ?? NSNull() }
