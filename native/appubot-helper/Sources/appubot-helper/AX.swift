import Foundation
import AppKit
import ApplicationServices

// AX positions are already global top-left-origin points, matching CGEvent coordinates.

func requireAX() throws {
    if !AXIsProcessTrusted() {
        throw HelperError.denied("Accessibility permission is not granted. Enable it in System Settings > Privacy & Security > Accessibility for the app that launched this helper.")
    }
}

let systemWideElement: AXUIElement = {
    let el = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(el, 3.0)  // global default for unresponsive apps
    return el
}()

// MARK: - Primitive accessors

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success, let v else { return nil }
    return v as AnyObject
}

func asAXElement(_ v: AnyObject?) -> AXUIElement? {
    guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func axString(_ v: AnyObject?, limit: Int = 200) -> String? {
    guard let v else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : truncate(s, limit) }
    if let a = v as? NSAttributedString { return a.string.isEmpty ? nil : truncate(a.string, limit) }
    if let u = v as? URL { return truncate(u.absoluteString, limit) }
    return nil
}

func axValueStruct(_ v: AnyObject?) -> AXValue? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    return (v as! AXValue)
}

func axPoint(_ v: AnyObject?) -> CGPoint? {
    guard let av = axValueStruct(v), AXValueGetType(av) == .cgPoint else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(av, .cgPoint, &p) ? p : nil
}

func axSize(_ v: AnyObject?) -> CGSize? {
    guard let av = axValueStruct(v), AXValueGetType(av) == .cgSize else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(av, .cgSize, &s) ? s : nil
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let p = axPoint(axAttr(el, kAXPositionAttribute)), let s = axSize(axAttr(el, kAXSizeAttribute)) else { return nil }
    return CGRect(origin: p, size: s)
}

func axBool(_ v: AnyObject?) -> Bool? {
    guard let n = v as? NSNumber else { return nil }
    return n.boolValue
}

/// JSON-friendly representation of an AXValue attribute.
func axValueJSON(_ v: AnyObject?) -> Any? {
    guard let v else { return nil }
    if let s = axString(v) { return s }
    if let n = v as? NSNumber {
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue }
        return n.doubleValue.isFinite ? n : nil
    }
    if let av = axValueStruct(v) {
        switch AXValueGetType(av) {
        case .cgPoint: if let p = axPoint(v) { return "(\(r2(p.x)), \(r2(p.y)))" }
        case .cgSize: if let s = axSize(v) { return "\(r2(s.width))x\(r2(s.height))" }
        case .cfRange:
            var r = CFRange()
            if AXValueGetValue(av, .cfRange, &r) { return "range(\(r.location), \(r.length))" }
        case .cgRect:
            var r = CGRect.zero
            if AXValueGetValue(av, .cgRect, &r) { return "rect(\(r2(r.origin.x)), \(r2(r.origin.y)), \(r2(r.width)), \(r2(r.height)))" }
        default: break
        }
    }
    return nil
}

func axActions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success, let a = names as? [String] else { return [] }
    return a
}

func axPid(_ el: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(el, &pid) == .success ? pid : nil
}

func axWindows(_ app: AXUIElement) -> [AXUIElement] {
    guard let arr = axAttr(app, kAXWindowsAttribute) as? [AnyObject] else { return [] }
    return arr.compactMap(asAXElement)
}

func axChildren(_ el: AXUIElement, max: Int) -> (count: Int, children: [AXUIElement]) {
    var count: CFIndex = 0
    guard AXUIElementGetAttributeValueCount(el, kAXChildrenAttribute as CFString, &count) == .success, count > 0 else { return (0, []) }
    let n = min(count, max)
    guard n > 0 else { return (count, []) }
    var arr: CFArray?
    guard AXUIElementCopyAttributeValues(el, kAXChildrenAttribute as CFString, 0, n, &arr) == .success,
          let a = arr as? [AnyObject] else { return (count, []) }
    return (count, a.compactMap(asAXElement))
}

// Private but long-stable API used by every window manager to map AX windows to CGWindowIDs.
typealias AXGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
let axGetWindowFn: AXGetWindowFn? = {
    guard let h = dlopen(nil, RTLD_NOW), let sym = dlsym(h, "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(sym, to: AXGetWindowFn.self)
}()

func axWindowID(_ el: AXUIElement) -> CGWindowID? {
    guard let f = axGetWindowFn else { return nil }
    var id: CGWindowID = 0
    return f(el, &id) == .success && id != 0 ? id : nil
}

// MARK: - Node info

let nodeAttrNames: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute,
    kAXHelpAttribute, kAXPlaceholderValueAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
    kAXSelectedAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXIdentifierAttribute, "AXLabel",
    kAXRoleDescriptionAttribute,
]

struct AXInfo {
    var role = ""
    var subrole: String?
    var title: String?
    var value: Any?
    var description: String?
    var help: String?
    var placeholder: String?
    var label: String?
    var enabled = true
    var focused = false
    var selected: Bool?
    var frame: CGRect?
    var identifier: String?
    var roleDescription: String?
}

func axInfo(_ el: AXUIElement) -> AXInfo {
    var info = AXInfo()
    var arr: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(el, nodeAttrNames as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &arr) == .success,
          let vals = arr as? [AnyObject], vals.count == nodeAttrNames.count else {
        info.role = axString(axAttr(el, kAXRoleAttribute)) ?? "AXUnknown"
        return info
    }
    func v(_ i: Int) -> AnyObject? {
        let x = vals[i]
        if x is NSNull { return nil }
        if let av = axValueStruct(x), AXValueGetType(av) == .axError { return nil }
        return x
    }
    info.role = axString(v(0)) ?? "AXUnknown"
    info.subrole = axString(v(1))
    info.title = axString(v(2))
    info.value = axValueJSON(v(3))
    info.description = axString(v(4))
    info.help = axString(v(5))
    info.placeholder = axString(v(6))
    info.enabled = axBool(v(7)) ?? true
    info.focused = axBool(v(8)) ?? false
    info.selected = axBool(v(9))
    if let p = axPoint(v(10)), let s = axSize(v(11)) { info.frame = CGRect(origin: p, size: s) }
    info.identifier = axString(v(12))
    info.label = axString(v(13)) ?? info.description ?? info.help
    info.roleDescription = axString(v(14))
    return info
}

func nodeDict(_ info: AXInfo, actions: [String], childrenCount: Int, includeFrame: Bool = true) -> [String: Any] {
    var d: [String: Any] = ["role": info.role, "enabled": info.enabled, "focused": info.focused,
                            "children_count": childrenCount, "actions": actions]
    if let s = info.subrole { d["subrole"] = s }
    if let s = info.title { d["title"] = s }
    if let v = info.value { d["value"] = v }
    if let s = info.description { d["description"] = s }
    if let s = info.help { d["help"] = s }
    if let s = info.label { d["label"] = s }
    if let s = info.placeholder { d["placeholder"] = s }
    if let s = info.identifier { d["identifier"] = s }
    if let s = info.roleDescription { d["role_description"] = s }
    if let b = info.selected { d["selected"] = b }
    if includeFrame, let f = info.frame { d["frame"] = rectDict(f) }
    return d
}

func describeElement(_ el: AXUIElement, includeFrame: Bool = true) -> [String: Any] {
    let info = axInfo(el)
    var count: CFIndex = 0
    _ = AXUIElementGetAttributeValueCount(el, kAXChildrenAttribute as CFString, &count)
    var d = nodeDict(info, actions: axActions(el), childrenCount: count, includeFrame: includeFrame)
    if let pid = axPid(el) {
        d["pid"] = Int(pid)
        if let app = NSRunningApplication(processIdentifier: pid) { d["app"] = app.localizedName ?? "" }
    }
    if info.role == kAXWindowRole, let id = axWindowID(el) { d["window_id"] = Int(id) }
    return d
}

let interactiveRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton",
    "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXLink", "AXSlider", "AXIncrementor", "AXDisclosureTriangle",
    "AXColorWell", "AXDateField", "AXSearchField", "AXTab", "AXSwitch", "AXStepper", "AXSegmentedControl",
    "AXCell", "AXRow", "AXOutlineRow",
]

func isInteractive(_ info: AXInfo, _ actions: [String]) -> Bool {
    if interactiveRoles.contains(info.role) { return true }
    if info.subrole == "AXSecureTextField" || info.subrole == "AXSearchField" { return true }
    return actions.contains(where: { $0 == "AXPress" || $0 == "AXConfirm" || $0 == "AXPick" || $0 == "AXOpen" })
}

// MARK: - Element cache (ids from the most recent ax_tree call)

var lastTreeElements: [Int: AXUIElement] = [:]
var lastTreePid: pid_t = 0

func frontmostPid() throws -> pid_t {
    guard let a = frontmostApp() else { throw HelperError.notFound("no frontmost application") }
    return a.processIdentifier
}

func enableWebAX(_ appEl: AXUIElement) {
    // Chromium/Electron apps only build their AX tree when an assistive client asks for it.
    AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
}

// MARK: - ax_tree

func cmdAXTree(_ p: Params) throws -> Any {
    try requireAX()
    let t0 = Date()
    let pid: pid_t = try p.int("pid").map { pid_t($0) } ?? frontmostPid()
    guard let app = NSRunningApplication(processIdentifier: pid) else { throw HelperError.notFound("no running app with pid \(pid)") }
    let windowMode = try p.string("window") ?? "focused"
    let maxDepth = try p.int("max_depth") ?? 12
    let maxNodes = try p.int("max_nodes") ?? 1500
    guard maxDepth >= 0, maxDepth <= 100 else { throw HelperError.invalid("max_depth must be 0..100") }
    guard maxNodes >= 1, maxNodes <= 50_000 else { throw HelperError.invalid("max_nodes must be 1..50000") }
    let onlyInteractive = try p.bool("only_interactive") ?? false
    let includeFrames = try p.bool("include_frames") ?? true
    let includeMenuBar = try p.bool("include_menu_bar") ?? false
    let includeCompact = try p.bool("compact") ?? true

    let appEl = AXUIElementCreateApplication(pid)
    if try p.bool("enable_web_ax") ?? true { enableWebAX(appEl) }

    // Roots
    var roots: [AXUIElement] = []
    var windowTitle: String?
    switch windowMode {
    case "focused":
        let w = asAXElement(axAttr(appEl, kAXFocusedWindowAttribute)) ?? asAXElement(axAttr(appEl, kAXMainWindowAttribute)) ?? axWindows(appEl).first
        if let w { roots = [w]; windowTitle = axString(axAttr(w, kAXTitleAttribute)) }
        else { roots = [appEl] }
        if includeMenuBar, let mb = asAXElement(axAttr(appEl, kAXMenuBarAttribute)) { roots.append(mb) }
    case "all", "app":
        roots = [appEl]
    default:
        throw HelperError.invalid("window must be 'focused', 'all' or 'app'")
    }

    struct Item { let el: AXUIElement; let parent: Int?; let depth: Int; let isAppRoot: Bool }
    var queue: [Item] = roots.map { Item(el: $0, parent: nil, depth: 0, isAppRoot: CFEqual($0, appEl)) }
    var head = 0
    var nodes: [[String: Any]] = []
    var childIds: [Int: [Int]] = [:]
    var rootIds: [Int] = []
    var depthOf: [Int: Int] = [:]
    var compactInfo: [Int: String] = [:]
    var elements: [Int: AXUIElement] = [:]
    let visitCap = onlyInteractive ? maxNodes * 8 : maxNodes
    var visited = 0

    while head < queue.count && nodes.count < maxNodes && visited < visitCap {
        let item = queue[head]
        head += 1
        visited += 1
        let info = axInfo(item.el)
        let actions = axActions(item.el)
        let pending = queue.count - head
        let budget = max(0, visitCap - visited - pending)
        var kids: [AXUIElement] = []
        var childCount = 0
        if item.isAppRoot {
            // App root: windows (+ menu bar only in "app" mode or when requested)
            kids = axWindows(appEl)
            if windowMode == "app" || includeMenuBar, let mb = asAXElement(axAttr(appEl, kAXMenuBarAttribute)) { kids.append(mb) }
            childCount = kids.count
            kids = Array(kids.prefix(budget))
        } else if item.depth < maxDepth {
            (childCount, kids) = axChildren(item.el, max: budget)
        } else {
            var c: CFIndex = 0
            _ = AXUIElementGetAttributeValueCount(item.el, kAXChildrenAttribute as CFString, &c)
            childCount = c
        }
        let include = !onlyInteractive || item.parent == nil || isInteractive(info, actions)
        var linkId = item.parent
        if include {
            let id = nodes.count
            var d = nodeDict(info, actions: actions, childrenCount: childCount, includeFrame: includeFrames)
            d["id"] = id
            d["parent"] = item.parent.map { $0 as Any } ?? NSNull()
            d["depth"] = item.depth
            if info.role == kAXWindowRole, let wid = axWindowID(item.el) { d["window_id"] = Int(wid) }
            nodes.append(d)
            elements[id] = item.el
            if let parent = item.parent { childIds[parent, default: []].append(id) } else { rootIds.append(id) }
            depthOf[id] = item.parent.map { (depthOf[$0] ?? 0) + 1 } ?? 0
            if includeCompact { compactInfo[id] = compactLine(id: id, info: info) }
            linkId = id
        }
        for k in kids { queue.append(Item(el: k, parent: linkId, depth: item.depth + 1, isAppRoot: false)) }
    }
    let truncated = head < queue.count

    lastTreeElements = elements
    lastTreePid = pid

    var result: [String: Any] = [
        "app": ["pid": Int(pid), "name": app.localizedName ?? "", "bundle_id": orNull(app.bundleIdentifier)],
        "nodes": nodes,
        "node_count": nodes.count,
        "truncated": truncated,
        "elapsed_ms": Int(Date().timeIntervalSince(t0) * 1000),
    ]
    if let windowTitle { result["window_title"] = windowTitle }
    if includeCompact {
        var lines: [String] = []
        lines.reserveCapacity(nodes.count)
        func walk(_ id: Int) {
            let indent = String(repeating: "  ", count: depthOf[id] ?? 0)
            lines.append(indent + (compactInfo[id] ?? "[\(id)]"))
            for c in childIds[id] ?? [] { walk(c) }
        }
        for r in rootIds { walk(r) }
        if truncated { lines.append("… (truncated at \(nodes.count) nodes; raise max_nodes or use only_interactive)") }
        result["compact"] = lines.joined(separator: "\n")
    }
    return result
}

func compactLine(id: Int, info: AXInfo) -> String {
    var s = "[\(id)] \(info.role)"
    if let sr = info.subrole, sr != "AXUnknown" { s += "(\(sr))" }
    let name = info.title ?? info.label
    if let n = name { s += " \"\(oneLine(n, 80))\"" }
    if let l = info.label, l != name { s += " desc=\"\(oneLine(l, 60))\"" }
    if let v = info.value {
        let vs = (v as? String) ?? "\(v)"
        if !vs.isEmpty, vs != name { s += " value=\"\(oneLine(vs, 80))\"" }
    }
    if let ph = info.placeholder { s += " placeholder=\"\(oneLine(ph, 40))\"" }
    if let f = info.frame { s += " (\(Int(f.origin.x)),\(Int(f.origin.y)) \(Int(f.width))×\(Int(f.height)))" }
    if !info.enabled { s += " disabled" }
    if info.focused { s += " focused" }
    if info.selected == true { s += " selected" }
    return s
}

func oneLine(_ s: String, _ limit: Int) -> String {
    truncate(s.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\"", with: "'"), limit)
}

// MARK: - Element lookup

func hitTest(_ pt: CGPoint, pid: pid_t?) throws -> AXUIElement {
    let base = pid.map { AXUIElementCreateApplication($0) } ?? systemWideElement
    var el: AXUIElement?
    let err = AXUIElementCopyElementAtPosition(base, Float(pt.x), Float(pt.y), &el)
    guard err == .success, let el else {
        throw HelperError.notFound("no accessibility element at (\(r2(pt.x)), \(r2(pt.y))) (AXError \(err.rawValue))")
    }
    return el
}

/// Finds an element by id (from last ax_tree), by x/y hit test, or by role/title search.
func resolveElement(_ p: Params) throws -> AXUIElement {
    if let id = try p.int("id") {
        guard let el = lastTreeElements[id] else {
            throw HelperError.notFound("no element with id \(id) in the last ax_tree result (call ax_tree first; ids are per call)")
        }
        if let pp = try p.int("pid"), pid_t(pp) != lastTreePid {
            throw HelperError.invalid("id \(id) refers to the last ax_tree of pid \(lastTreePid), not \(pp)")
        }
        return el
    }
    let pidParam = try p.int("pid").map { pid_t($0) }
    if let pt = try p.xy() { return try hitTest(pt, pid: pidParam) }
    let role = try p.string("role")
    let title = try p.string("title")
    guard role != nil || title != nil else {
        throw HelperError.invalid("provide 'id' (from ax_tree), 'x'+'y', or 'role'/'title' to locate the element")
    }
    let pid = try pidParam ?? frontmostPid()
    let appEl = AXUIElementCreateApplication(pid)
    enableWebAX(appEl)
    let index = try p.int("index") ?? 0
    let q = title?.lowercased()
    var exact: [AXUIElement] = []
    var partial: [AXUIElement] = []
    var queue: [AXUIElement] = axWindows(appEl)
    if try p.bool("include_menu_bar") ?? true, let mb = asAXElement(axAttr(appEl, kAXMenuBarAttribute)) { queue.append(mb) }
    var head = 0
    let cap = try p.int("max_nodes") ?? 6000
    while head < queue.count && head < cap {
        let el = queue[head]
        head += 1
        let info = axInfo(el)
        let roleOK = role == nil || info.role == role || info.subrole == role
        if roleOK {
            if let q {
                let texts = [info.title, info.description, info.value as? String, info.placeholder, info.identifier, info.help].compactMap { $0?.lowercased() }
                if texts.contains(q) { exact.append(el) } else if texts.contains(where: { $0.contains(q) }) { partial.append(el) }
            } else {
                exact.append(el)
            }
            if exact.count > index { break }
        }
        let (_, kids) = axChildren(el, max: cap)
        queue.append(contentsOf: kids)
    }
    let matches = exact + partial
    guard index < matches.count else {
        throw HelperError.notFound("no element matching role=\(role ?? "*") title=\(title.map { "\"\($0)\"" } ?? "*") in pid \(pid) (searched \(head) nodes)")
    }
    return matches[index]
}

func cmdAXPress(_ p: Params) throws -> Any {
    try requireAX()
    var el = try resolveElement(p)
    let action = try p.string("action") ?? kAXPressAction
    // Hit-testing often lands on a static text inside a button: walk up to an ancestor supporting the action.
    var hops = 0
    while !axActions(el).contains(action) && hops < 6 {
        guard let parent = asAXElement(axAttr(el, kAXParentAttribute)) else { break }
        el = parent
        hops += 1
    }
    guard axActions(el).contains(action) else {
        throw HelperError("action_unsupported", "element (\(axInfo(el).role)) and its ancestors do not support \(action); try click at its frame center instead")
    }
    let err = AXUIElementPerformAction(el, action as CFString)
    guard err == .success else { throw HelperError("ax_error", "\(action) failed with AXError \(err.rawValue)") }
    var r = describeElement(el)
    r["performed"] = action
    return r
}

func cmdAXSetValue(_ p: Params) throws -> Any {
    try requireAX()
    guard let raw = p.raw["value"], !(raw is NSNull) else { throw HelperError.invalid("missing 'value'") }
    let el = try resolveElement(p)
    let attr = try p.string("attribute") ?? kAXValueAttribute
    var settable = DarwinBoolean(false)
    AXUIElementIsAttributeSettable(el, attr as CFString, &settable)
    guard settable.boolValue else {
        throw HelperError("not_settable", "\(attr) of \(axInfo(el).role) is not settable; focus it and use type_text instead")
    }
    if try p.bool("focus") ?? true {
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    }
    let value: CFTypeRef
    if let s = raw as? String { value = s as CFString }
    else if let n = raw as? NSNumber { value = n }
    else { throw HelperError.invalid("'value' must be a string, number or boolean") }
    let err = AXUIElementSetAttributeValue(el, attr as CFString, value)
    guard err == .success else { throw HelperError("ax_error", "setting \(attr) failed with AXError \(err.rawValue)") }
    var r = describeElement(el)
    r["set"] = attr
    return r
}

func cmdAXElementAt(_ p: Params) throws -> Any {
    try requireAX()
    guard let pt = try p.xy() else { throw HelperError.invalid("ax_element_at requires 'x' and 'y'") }
    let el = try hitTest(pt, pid: try p.int("pid").map { pid_t($0) })
    var r = describeElement(el)
    // Ancestor chain (closest first) for context.
    var ancestors: [[String: Any]] = []
    var cur = el
    for _ in 0..<8 {
        guard let parent = asAXElement(axAttr(cur, kAXParentAttribute)) else { break }
        let info = axInfo(parent)
        var a: [String: Any] = ["role": info.role]
        if let t = info.title ?? info.label { a["title"] = t }
        if let f = info.frame { a["frame"] = rectDict(f) }
        ancestors.append(a)
        if info.role == kAXApplicationRole { break }
        cur = parent
    }
    r["ancestors"] = ancestors
    r["point"] = pointDict(pt)
    return r
}

func cmdAXFocusedElement(_ p: Params) throws -> Any {
    try requireAX()
    var el = asAXElement(axAttr(systemWideElement, kAXFocusedUIElementAttribute))
    if el == nil, let pid = frontmostApp()?.processIdentifier {
        let appEl = AXUIElementCreateApplication(pid)
        enableWebAX(appEl)
        el = asAXElement(axAttr(appEl, kAXFocusedUIElementAttribute))
    }
    guard let el else { throw HelperError.notFound("no focused UI element") }
    return describeElement(el)
}

/// Lightweight summary of the element under a point (used by the watcher).
func axSummaryAt(_ pt: CGPoint) -> [String: Any]? {
    guard AXIsProcessTrusted(), let el = try? hitTest(pt, pid: nil) else { return nil }
    let info = axInfo(el)
    var d: [String: Any] = ["role": info.role]
    if let t = info.title { d["title"] = t }
    if let l = info.label { d["label"] = l }
    if let v = info.value as? String { d["value"] = truncate(v, 80) }
    if let f = info.frame { d["frame"] = rectDict(f) }
    return d
}

func focusedWindowTitle(pid: pid_t) -> String? {
    guard AXIsProcessTrusted() else { return nil }
    let appEl = AXUIElementCreateApplication(pid)
    guard let w = asAXElement(axAttr(appEl, kAXFocusedWindowAttribute)) else { return nil }
    return axString(axAttr(w, kAXTitleAttribute))
}
