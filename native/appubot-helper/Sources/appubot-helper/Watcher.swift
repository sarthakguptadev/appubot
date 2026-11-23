import Foundation
import AppKit
import CoreGraphics

/// Global input watcher for "teach mode". A listen-only CGEventTap on the main run loop captures
/// raw events; they are enriched (app, window, AX element, optional screenshot) and coalesced on
/// a serial queue, then emitted as {"event":"input",...} lines.
final class Watcher: @unchecked Sendable {
    static let shared = Watcher()

    // Main-thread state
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?

    // Options (written on command queue before start; read on watcher queue)
    private var watchMouse = true
    private var watchKeyboard = true
    private var screenshotsOnClick = false
    private var screenshotScale = 0.5

    // Watcher-queue state
    private let queue = DispatchQueue(label: "appubot.watcher", qos: .userInitiated)
    private var typed = ""
    private var typedStartTs: Int64 = 0
    private var typedApp: String?
    private var typedFlush: DispatchWorkItem?
    private var downPoint: CGPoint?
    private var downTs: Int64 = 0
    private var downScreenshot: String?
    private var scrollAccX = 0.0
    private var scrollAccY = 0.0
    private var scrollPoint = CGPoint.zero
    private var scrollFlush: DispatchWorkItem?

    var isRunning: Bool { tap != nil }

    struct Raw {
        let type: CGEventType
        let location: CGPoint
        let flags: CGEventFlags
        let keyCode: Int64
        let chars: String
        let clickState: Int64
        let scrollX: Double
        let scrollY: Double
        let isRepeat: Bool
        let ts: Int64
    }

    func start(mouse: Bool, keyboard: Bool, screenshots: Bool, scale: Double) throws -> [String: Any] {
        queue.sync {
            watchMouse = mouse
            watchKeyboard = keyboard
            screenshotsOnClick = screenshots
            screenshotScale = scale
        }
        var created = false
        var already = false
        DispatchQueue.main.sync {
            if tap != nil { already = true; return }
            var mask: CGEventMask = 0
            func add(_ t: CGEventType) { mask |= CGEventMask(1) << CGEventMask(t.rawValue) }
            if mouse {
                [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel].forEach(add)
            }
            if keyboard { [.keyDown].forEach(add) }
            guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                            eventsOfInterest: mask, callback: watcherTapCallback, userInfo: nil) else { return }
            let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
            CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
            CGEvent.tapEnable(tap: t, enable: true)
            tap = t
            source = src
            created = true
        }
        if already {
            return ["started": true, "already_running": true]
        }
        guard created else {
            throw HelperError.denied("could not create the event tap: grant Input Monitoring (and Accessibility) in System Settings > Privacy & Security to the app that launched this helper. Current: \(permissionSummary())")
        }
        return ["started": true, "mouse": mouse, "keyboard": keyboard, "screenshots_on_click": screenshots]
    }

    func stop() -> [String: Any] {
        var wasRunning = false
        DispatchQueue.main.sync {
            guard let t = tap else { return }
            wasRunning = true
            CGEvent.tapEnable(tap: t, enable: false)
            if let s = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
            CFMachPortInvalidate(t)
            tap = nil
            source = nil
        }
        queue.sync {
            flushTyped()
            flushScroll()
        }
        return ["stopped": wasRunning]
    }

    /// Called on the main thread from the tap callback. Must be fast.
    func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
            return
        }
        var chars = ""
        if type == .keyDown {
            var len = 0
            var buf = [UniChar](repeating: 0, count: 16)
            event.keyboardGetUnicodeString(maxStringLength: 16, actualStringLength: &len, unicodeString: &buf)
            chars = String(utf16CodeUnits: buf, count: max(0, min(len, 16)))
        }
        let raw = Raw(
            type: type,
            location: event.location,
            flags: event.flags,
            keyCode: event.getIntegerValueField(.keyboardEventKeycode),
            chars: chars,
            clickState: event.getIntegerValueField(.mouseEventClickState),
            scrollX: Double(event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2)),
            scrollY: Double(event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1)),
            isRepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0,
            ts: nowMs()
        )
        queue.async { self.process(raw) }
    }

    // MARK: - Processing (watcher queue)

    private func context() -> (String, pid_t?) {
        let app = frontmostApp()
        return (app?.localizedName ?? "", app?.processIdentifier)
    }

    private func emit(_ fields: [String: Any]) {
        var f = fields
        f["kind"] = f["kind"] ?? "unknown"
        Output.shared.event("input", f)
    }

    private func baseFields(kind: String, raw: Raw) -> [String: Any] {
        let (appName, pid) = context()
        var f: [String: Any] = ["kind": kind, "x": r2(raw.location.x), "y": r2(raw.location.y),
                                "modifiers": modifierNames(raw.flags), "ts": raw.ts, "app": appName]
        if let pid { f["pid"] = Int(pid); if let t = focusedWindowTitle(pid: pid) { f["window_title"] = t } }
        return f
    }

    private func process(_ raw: Raw) {
        switch raw.type {
        case .leftMouseDown:
            flushTyped(); flushScroll()
            downPoint = raw.location
            downTs = raw.ts
            downScreenshot = screenshotsOnClick ? quickScreenshotBase64(at: raw.location, scale: screenshotScale) : nil
        case .leftMouseUp:
            let start = downPoint ?? raw.location
            let dist = hypot(raw.location.x - start.x, raw.location.y - start.y)
            var f: [String: Any]
            if dist > 5 {
                f = baseFields(kind: "drag_end", raw: raw)
                f["from"] = pointDict(start)
                f["duration_ms"] = raw.ts - downTs
            } else {
                f = baseFields(kind: "click", raw: raw)
                f["count"] = Int(max(1, raw.clickState))
                if let ax = axSummaryAt(start) { f["ax"] = ax }
            }
            f["button"] = "left"
            if let s = downScreenshot { f["screenshot_base64"] = s }
            downPoint = nil
            downScreenshot = nil
            emit(f)
        case .rightMouseDown:
            flushTyped(); flushScroll()
            var f = baseFields(kind: "right_click", raw: raw)
            f["button"] = "right"
            if let ax = axSummaryAt(raw.location) { f["ax"] = ax }
            if screenshotsOnClick, let s = quickScreenshotBase64(at: raw.location, scale: screenshotScale) { f["screenshot_base64"] = s }
            emit(f)
        case .otherMouseDown:
            flushTyped(); flushScroll()
            var f = baseFields(kind: "click", raw: raw)
            f["button"] = "middle"
            f["count"] = Int(max(1, raw.clickState))
            if let ax = axSummaryAt(raw.location) { f["ax"] = ax }
            emit(f)
        case .scrollWheel:
            flushTyped()
            // Same convention as the scroll command: dy > 0 means scrolling down.
            scrollAccX += -raw.scrollX
            scrollAccY += -raw.scrollY
            scrollPoint = raw.location
            scrollFlush?.cancel()
            let w = DispatchWorkItem { [weak self] in self?.flushScroll() }
            scrollFlush = w
            queue.asyncAfter(deadline: .now() + 0.3, execute: w)
        case .keyDown:
            processKey(raw)
        default:
            break
        }
    }

    private func isPrintable(_ s: String) -> Bool {
        guard !s.isEmpty else { return false }
        for u in s.unicodeScalars {
            if u.value < 0x20 || u.value == 0x7F { return false }
            if (0xF700...0xF8FF).contains(u.value) { return false }  // function-key private-use range
        }
        return true
    }

    private func processKey(_ raw: Raw) {
        let code = CGKeyCode(truncatingIfNeeded: raw.keyCode)
        let hasCmdCtrl = raw.flags.contains(.maskCommand) || raw.flags.contains(.maskControl)
        if !hasCmdCtrl && isPrintable(raw.chars) {
            if typed.isEmpty { typedStartTs = raw.ts; typedApp = context().0 }
            typed += raw.chars
            scheduleTypedFlush()
            return
        }
        if code == 0x33 && !hasCmdCtrl && !raw.flags.contains(.maskAlternate) && !typed.isEmpty {
            typed.removeLast()  // backspace while typing edits the pending text
            scheduleTypedFlush()
            return
        }
        flushTyped()
        flushScroll()
        var f = baseFields(kind: "key", raw: raw)
        f["key"] = keyNamesByCode[code] ?? "keycode_\(code)"
        f["keycode"] = Int(code)
        if isPrintable(raw.chars) { f["chars"] = raw.chars }
        if raw.isRepeat { f["repeat"] = true }
        emit(f)
    }

    private func scheduleTypedFlush() {
        typedFlush?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.flushTyped() }
        typedFlush = w
        queue.asyncAfter(deadline: .now() + 0.6, execute: w)
    }

    private func flushTyped() {
        typedFlush?.cancel()
        typedFlush = nil
        guard !typed.isEmpty else { return }
        let loc = currentCursor()
        var f: [String: Any] = ["kind": "typed", "text": typed, "ts": typedStartTs, "end_ts": nowMs(),
                                "app": typedApp ?? context().0, "x": r2(loc.x), "y": r2(loc.y), "modifiers": [String]()]
        if let pid = context().1, let t = focusedWindowTitle(pid: pid) { f["window_title"] = t }
        typed = ""
        emit(f)
    }

    private func flushScroll() {
        scrollFlush?.cancel()
        scrollFlush = nil
        guard scrollAccX != 0 || scrollAccY != 0 else { return }
        let (appName, _) = context()
        let f: [String: Any] = ["kind": "scroll", "x": r2(scrollPoint.x), "y": r2(scrollPoint.y),
                                "dx": r2(scrollAccX), "dy": r2(scrollAccY), "modifiers": [String](), "ts": nowMs(), "app": appName]
        scrollAccX = 0
        scrollAccY = 0
        emit(f)
    }
}

let watcherTapCallback: CGEventTapCallBack = { _, type, event, _ in
    Watcher.shared.handle(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

func cmdWatchStart(_ p: Params) throws -> Any {
    let scale = try p.double("scale") ?? 0.5
    guard scale > 0, scale <= 2 else { throw HelperError.invalid("scale must be in (0, 2]") }
    let keyboard = try p.bool("keyboard") ?? true
    let listenOK = CGPreflightListenEventAccess() || AXIsProcessTrusted()
    // macOS happily creates a listen-only tap without permission but then never delivers key
    // events, so fail loudly instead of silently recording nothing.
    let force = try p.bool("force") ?? false
    if keyboard && !listenOK && !force {
        throw HelperError.denied("Input Monitoring permission is not granted, so keyboard events cannot be observed. Grant Input Monitoring (System Settings > Privacy & Security > Input Monitoring) to the app that launched this helper, or pass {\"keyboard\": false} / {\"force\": true}. Current: \(permissionSummary())")
    }
    var r = try Watcher.shared.start(
        mouse: try p.bool("mouse") ?? true,
        keyboard: keyboard,
        screenshots: try p.bool("screenshots_on_click") ?? false,
        scale: scale
    )
    r["permissions"] = permissionStatus()
    if !listenOK { r["warning"] = "Input Monitoring not granted: some or all events may not be delivered." }
    return r
}

func cmdWatchStop(_ p: Params) throws -> Any {
    Watcher.shared.stop()
}
