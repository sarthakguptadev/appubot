import Foundation
import CoreGraphics
import ApplicationServices

// All coordinates are global logical points, top-left origin of the main display.

let eventSource = CGEventSource(stateID: .hidSystemState)

/// Buttons currently held down via mouse_down (so mouse_move emits drag events).
var heldButtons = Set<UInt32>()
var lastPostedMouse: CGPoint?

let accessibilityWarning = "Accessibility permission not granted: macOS will silently drop synthetic input events. Grant it in System Settings > Privacy & Security > Accessibility."

func addInputWarning(_ r: inout [String: Any]) {
    if !AXIsProcessTrusted() { r["warning"] = accessibilityWarning }
}

func currentCursor() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

func parseButton(_ s: String?) throws -> CGMouseButton {
    switch (s ?? "left").lowercased() {
    case "left", "l", "1": return .left
    case "right", "r", "2": return .right
    case "middle", "center", "m", "3": return .center
    default: throw HelperError.invalid("button must be 'left', 'right' or 'middle'")
    }
}

func buttonName(_ b: CGMouseButton) -> String {
    switch b {
    case .left: return "left"
    case .right: return "right"
    default: return "middle"
    }
}

func mouseTypes(_ b: CGMouseButton) -> (down: CGEventType, up: CGEventType, drag: CGEventType) {
    switch b {
    case .left: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    default: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    }
}

func postMouse(_ type: CGEventType, _ pt: CGPoint, _ button: CGMouseButton, clickState: Int64 = 1, flags: CGEventFlags = []) throws {
    guard let e = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: pt, mouseButton: button) else {
        throw HelperError.failed("could not create mouse event")
    }
    e.setIntegerValueField(.mouseEventClickState, value: clickState)
    if type == .mouseMoved || type == .leftMouseDragged || type == .rightMouseDragged || type == .otherMouseDragged {
        let prev = lastPostedMouse ?? currentCursor()
        e.setIntegerValueField(.mouseEventDeltaX, value: Int64((pt.x - prev.x).rounded()))
        e.setIntegerValueField(.mouseEventDeltaY, value: Int64((pt.y - prev.y).rounded()))
    }
    e.flags = flags
    e.post(tap: .cghidEventTap)
    lastPostedMouse = pt
}

/// Moves the pointer; emits drag events if a button is held via mouse_down.
func moveMouse(to target: CGPoint, durationMs: Double, flags: CGEventFlags = []) throws {
    var type: CGEventType = .mouseMoved
    var button: CGMouseButton = .left
    if heldButtons.contains(CGMouseButton.left.rawValue) { type = .leftMouseDragged; button = .left }
    else if heldButtons.contains(CGMouseButton.right.rawValue) { type = .rightMouseDragged; button = .right }
    else if heldButtons.contains(CGMouseButton.center.rawValue) { type = .otherMouseDragged; button = .center }

    let start = currentCursor()
    lastPostedMouse = start
    if durationMs > 0 {
        let steps = max(2, min(240, Int(durationMs / 8)))
        let stepDelay = durationMs / Double(steps)
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let e = t * t * (3 - 2 * t)  // smoothstep easing
            let pt = CGPoint(x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e)
            try postMouse(type, pt, button, flags: flags)
            sleepMs(stepDelay)
        }
    } else {
        try postMouse(type, target, button, flags: flags)
    }
}

func cmdCursorPosition(_ p: Params) throws -> Any {
    pointDict(currentCursor())
}

/// What the user does with the keyboard, mouse or trackpad (not "any event", which also counts system-defined ones).
let userInputTypes: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseDragged, .rightMouseDown, .rightMouseDragged,
                                     .otherMouseDown, .otherMouseDragged, .scrollWheel, .keyDown, .flagsChanged]

/// How long since the user last touched the keyboard, mouse or trackpad (the HID system's count, which needs no
/// permission). Background mode reads it to wait until the user pauses before a bot's step briefly takes the screen.
func cmdInputIdle(_ p: Params) throws -> Any {
    let seconds = userInputTypes.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0
    return ["seconds": seconds]
}

func cmdMouseMove(_ p: Params) throws -> Any {
    guard let pt = try p.xy() else { throw HelperError.invalid("mouse_move requires 'x' and 'y'") }
    let dur = try p.double("duration_ms") ?? 0
    guard dur >= 0, dur <= 10_000 else { throw HelperError.invalid("duration_ms must be between 0 and 10000") }
    try moveMouse(to: pt, durationMs: dur)
    var r: [String: Any] = ["x": r2(pt.x), "y": r2(pt.y)]
    addInputWarning(&r)
    return r
}

func cmdClick(_ p: Params) throws -> Any {
    let button = try parseButton(try p.string("button"))
    let count = try p.int("count") ?? 1
    guard (1...5).contains(count) else { throw HelperError.invalid("count must be 1..5") }
    let flags = try parseModifiers(try p.stringList("modifiers") ?? [])
    var pt = currentCursor()
    if let target = try p.xy() {
        pt = target
        try moveMouse(to: pt, durationMs: try p.double("move_duration_ms") ?? 0)
        sleepMs(15)
    }
    let types = mouseTypes(button)
    // `click_state`: only the last press of a multi-click (its first already went out, e.g. a phone's double tap whose
    // first tap clicked): one down/up carrying that click count
    let only = try p.int("click_state")
    if let only, !(1...5).contains(only) { throw HelperError.invalid("click_state must be 1..5") }
    for i in (only ?? 1)...(only ?? count) {
        try postMouse(types.down, pt, button, clickState: Int64(i), flags: flags)
        sleepMs(15)
        try postMouse(types.up, pt, button, clickState: Int64(i), flags: flags)
        if i < (only ?? count) { sleepMs(30) }
    }
    var r: [String: Any] = ["x": r2(pt.x), "y": r2(pt.y), "button": buttonName(button), "count": count,
                            "modifiers": modifierNames(flags)]
    addInputWarning(&r)
    return r
}

func cmdMouseDown(_ p: Params) throws -> Any {
    let button = try parseButton(try p.string("button"))
    let flags = try parseModifiers(try p.stringList("modifiers") ?? [])
    var pt = currentCursor()
    if let target = try p.xy() {
        pt = target
        try moveMouse(to: pt, durationMs: 0)
        sleepMs(10)
    }
    try postMouse(mouseTypes(button).down, pt, button, flags: flags)
    heldButtons.insert(button.rawValue)
    var r: [String: Any] = ["x": r2(pt.x), "y": r2(pt.y), "button": buttonName(button)]
    addInputWarning(&r)
    return r
}

func cmdMouseUp(_ p: Params) throws -> Any {
    let button = try parseButton(try p.string("button"))
    let flags = try parseModifiers(try p.stringList("modifiers") ?? [])
    var pt = currentCursor()
    if let target = try p.xy() {
        pt = target
        try moveMouse(to: pt, durationMs: 0)
        sleepMs(10)
    }
    try postMouse(mouseTypes(button).up, pt, button, flags: flags)
    heldButtons.remove(button.rawValue)
    var r: [String: Any] = ["x": r2(pt.x), "y": r2(pt.y), "button": buttonName(button)]
    addInputWarning(&r)
    return r
}

func cmdDrag(_ p: Params) throws -> Any {
    guard let from = try p.point("from"), let to = try p.point("to") else {
        throw HelperError.invalid("drag requires 'from' {x,y} and 'to' {x,y}")
    }
    let button = try parseButton(try p.string("button"))
    let steps = try p.int("steps") ?? 20
    guard (1...500).contains(steps) else { throw HelperError.invalid("steps must be 1..500") }
    let dur = try p.double("duration_ms") ?? 300
    guard dur >= 0, dur <= 20_000 else { throw HelperError.invalid("duration_ms must be 0..20000") }
    let flags = try parseModifiers(try p.stringList("modifiers") ?? [])
    let types = mouseTypes(button)

    heldButtons.removeAll()
    try moveMouse(to: from, durationMs: 0)
    sleepMs(30)
    try postMouse(types.down, from, button, flags: flags)
    heldButtons.insert(button.rawValue)
    defer { heldButtons.remove(button.rawValue) }
    sleepMs(60)
    let stepDelay = dur / Double(steps)
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let pt = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        try postMouse(types.drag, pt, button, flags: flags)
        sleepMs(max(stepDelay, 4))
    }
    sleepMs(60)
    try postMouse(types.up, to, button, flags: flags)
    var r: [String: Any] = ["from": pointDict(from), "to": pointDict(to), "button": buttonName(button), "steps": steps]
    addInputWarning(&r)
    return r
}

/// Scroll convention: dy > 0 scrolls DOWN (content moves up, like reading further down a page);
/// dx > 0 scrolls RIGHT. Units are pixels unless "lines": true.
func cmdScroll(_ p: Params) throws -> Any {
    let dx = try p.double("dx") ?? 0
    let dy = try p.double("dy") ?? 0
    let lines = try p.bool("lines") ?? false
    guard abs(dx) <= 100_000, abs(dy) <= 100_000 else { throw HelperError.invalid("dx/dy too large") }
    var pt = currentCursor()
    if let target = try p.xy() {
        pt = target
        try moveMouse(to: pt, durationMs: 0)
        sleepMs(20)
    }
    let maxChunk: Double = lines ? 5 : 120
    let chunks = max(1, Int((max(abs(dx), abs(dy)) / maxChunk).rounded(.up)))
    var sentX = 0, sentY = 0
    let totalX = Int(dx.rounded()), totalY = Int(dy.rounded())
    for i in 1...chunks {
        let wantX = Int((Double(totalX) * Double(i) / Double(chunks)).rounded())
        let wantY = Int((Double(totalY) * Double(i) / Double(chunks)).rounded())
        let cx = wantX - sentX, cy = wantY - sentY
        sentX = wantX; sentY = wantY
        // Quartz: positive wheel1 = scroll up, positive wheel2 = scroll left; we invert both.
        guard let e = CGEvent(scrollWheelEvent2Source: eventSource, units: lines ? .line : .pixel,
                              wheelCount: 2, wheel1: Int32(-cy), wheel2: Int32(-cx), wheel3: 0) else {
            throw HelperError.failed("could not create scroll event")
        }
        e.location = pt
        e.post(tap: .cghidEventTap)
        if i < chunks { sleepMs(10) }
    }
    var r: [String: Any] = ["x": r2(pt.x), "y": r2(pt.y), "dx": totalX, "dy": totalY, "units": lines ? "lines" : "pixels",
                            "convention": "dy>0 scrolls down (content moves up); dx>0 scrolls right"]
    addInputWarning(&r)
    return r
}

// MARK: - Keyboard

func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) throws {
    guard let e = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down) else {
        throw HelperError.failed("could not create key event")
    }
    if modifierKeyCodes.contains(code) { e.type = .flagsChanged }
    e.flags = flags
    e.post(tap: .cghidEventTap)
}

/// Presses a key with modifiers held: modifier downs, key down, hold, key up, modifier ups.
func pressKey(_ code: CGKeyCode, flags: CGEventFlags, holdMs: Double = 15) throws {
    var keyFlags = flags
    if arrowKeyCodes.contains(code) { keyFlags.formUnion([.maskNumericPad, .maskSecondaryFn]) }
    else if fnFlagKeyCodes.contains(code) { keyFlags.insert(.maskSecondaryFn) }

    let order: [(CGEventFlags, CGKeyCode)] = [(.maskControl, 0x3B), (.maskAlternate, 0x3A), (.maskShift, 0x38),
                                              (.maskCommand, 0x37), (.maskSecondaryFn, 0x3F)]
    let pressed = order.filter { flags.contains($0.0) && $0.1 != code }
    var cur: CGEventFlags = []
    for (f, c) in pressed {
        cur.insert(f)
        try postKey(c, down: true, flags: cur)
        sleepMs(4)
    }
    if modifierKeyCodes.contains(code), let own = modifierTable.values.first(where: { $0.1 == code })?.0 {
        try postKey(code, down: true, flags: cur.union(own))
        sleepMs(holdMs)
        try postKey(code, down: false, flags: cur)
    } else {
        try postKey(code, down: true, flags: keyFlags)
        sleepMs(holdMs)
        try postKey(code, down: false, flags: keyFlags)
    }
    for (f, c) in pressed.reversed() {
        sleepMs(4)
        cur.remove(f)
        try postKey(c, down: false, flags: cur)
    }
}

func postUnicode(_ units: [UniChar]) throws {
    guard !units.isEmpty else { return }
    for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down) else {
            throw HelperError.failed("could not create key event")
        }
        e.flags = []
        units.withUnsafeBufferPointer { buf in
            e.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress!)
        }
        e.post(tap: .cghidEventTap)
    }
}

func cmdTypeText(_ p: Params) throws -> Any {
    let text = try p.reqString("text")
    let delay = try p.double("delay_ms") ?? 0
    guard delay >= 0, delay <= 5000 else { throw HelperError.invalid("delay_ms must be 0..5000") }
    var chunkSize = try p.int("chunk_size") ?? 20
    guard chunkSize >= 1 && chunkSize <= 20 else { throw HelperError.invalid("chunk_size must be 1..20") }
    if delay > 0 { chunkSize = 1 }

    var buffer: [UniChar] = []
    var bufferedChars = 0
    func flush() throws {
        guard !buffer.isEmpty else { return }
        try postUnicode(buffer)
        buffer.removeAll(keepingCapacity: true)
        bufferedChars = 0
        sleepMs(delay > 0 ? delay : 2)
    }
    var count = 0
    for ch in text {
        count += 1
        if ch == "\n" || ch == "\r\n" || ch == "\r" {
            try flush()
            try pressKey(0x24, flags: [], holdMs: 5)
            sleepMs(delay > 0 ? delay : 5)
            continue
        }
        if ch == "\t" {
            try flush()
            try pressKey(0x30, flags: [], holdMs: 5)
            sleepMs(delay > 0 ? delay : 5)
            continue
        }
        let units = Array(String(ch).utf16)
        if bufferedChars >= chunkSize || buffer.count + units.count > 20 { try flush() }
        buffer.append(contentsOf: units)
        bufferedChars += 1
    }
    try flush()
    var r: [String: Any] = ["typed_chars": count]
    addInputWarning(&r)
    return r
}

func performKeyCombo(mods: [String], key: String, holdMs: Double, dryRun: Bool = false) throws -> [String: Any] {
    var flags = try parseModifiers(mods)
    if let rk = resolveKey(key) {
        flags.formUnion(rk.extraFlags)
        if dryRun {
            return ["key": rk.name, "keycode": Int(rk.code), "modifiers": modifierNames(flags), "dry_run": true]
        }
        try pressKey(rk.code, flags: flags, holdMs: holdMs)
        var r: [String: Any] = ["key": rk.name, "keycode": Int(rk.code), "modifiers": modifierNames(flags)]
        addInputWarning(&r)
        return r
    }
    // Unknown single character (e.g. "é", "€"): type it as unicode if no modifiers are requested.
    if key.count == 1, flags.isEmpty {
        if dryRun { return ["key": key, "typed_unicode": true, "modifiers": [String](), "dry_run": true] }
        try postUnicode(Array(key.utf16))
        var r: [String: Any] = ["key": key, "typed_unicode": true, "modifiers": [String]()]
        addInputWarning(&r)
        return r
    }
    throw HelperError.invalid("unknown key '\(key)'. Use names like enter, tab, space, backspace, escape, up, down, left, right, home, end, pageup, pagedown, f1-f20, a-z, 0-9 or punctuation")
}

func cmdKey(_ p: Params) throws -> Any {
    let spec = try p.reqString("key")
    guard !spec.isEmpty else { throw HelperError.invalid("'key' must not be empty") }
    let hold = try p.double("hold_ms") ?? 15
    guard hold >= 0, hold <= 10_000 else { throw HelperError.invalid("hold_ms must be 0..10000") }
    let (comboMods, key) = spec.count > 1 ? splitCombo(spec) : ([], spec)
    let mods = (try p.stringList("modifiers") ?? []) + comboMods
    return try performKeyCombo(mods: mods, key: key, holdMs: hold, dryRun: try p.bool("dry_run") ?? false)
}

func cmdHotkey(_ p: Params) throws -> Any {
    guard var keys = try p.stringList("keys"), !keys.isEmpty else {
        throw HelperError.invalid("hotkey requires 'keys': e.g. [\"cmd\",\"shift\",\"4\"]")
    }
    // Allow ["cmd+shift+4"] too.
    if keys.count == 1 && keys[0].count > 1 && keys[0].contains("+") {
        let (m, k) = splitCombo(keys[0])
        keys = m + [k]
    }
    let key = keys.removeLast()
    let hold = try p.double("hold_ms") ?? 15
    guard hold >= 0, hold <= 10_000 else { throw HelperError.invalid("hold_ms must be 0..10000") }
    return try performKeyCombo(mods: keys, key: key, holdMs: hold, dryRun: try p.bool("dry_run") ?? false)
}
