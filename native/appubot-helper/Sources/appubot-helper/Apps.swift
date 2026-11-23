import Foundation
import AppKit
import ApplicationServices

// MARK: - Permissions

func permissionStatus() -> [String: Any] {
    [
        "accessibility": AXIsProcessTrusted(),
        "screen_recording": CGPreflightScreenCaptureAccess(),
        "input_monitoring": CGPreflightListenEventAccess(),
    ]
}

func permissionSummary() -> String {
    "accessibility=\(AXIsProcessTrusted()), screen_recording=\(CGPreflightScreenCaptureAccess()), input_monitoring=\(CGPreflightListenEventAccess())"
}

func cmdPermissions(_ p: Params) throws -> Any {
    permissionStatus()
}

func cmdRequestPermissions(_ p: Params) throws -> Any {
    let all = ["accessibility", "screen_recording", "input_monitoring"]
    let which = try p.stringList("which") ?? all
    for w in which where !all.contains(w) {
        throw HelperError.invalid("unknown permission '\(w)'; expected one of \(all)")
    }
    DispatchQueue.main.sync {
        if which.contains("accessibility") {
            let opts = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
        }
        if which.contains("screen_recording") { _ = CGRequestScreenCaptureAccess() }
        if which.contains("input_monitoring") { _ = CGRequestListenEventAccess() }
    }
    var r = permissionStatus()
    r["requested"] = which
    r["note"] = "Grants usually take effect only after the parent app (the one launching this helper) is restarted."
    return r
}

func cmdOpenSettings(_ p: Params) throws -> Any {
    let pane = try p.string("pane") ?? "accessibility"
    let anchors = [
        "accessibility": "Privacy_Accessibility",
        "screen_recording": "Privacy_ScreenCapture",
        "input_monitoring": "Privacy_ListenEvent",
        "automation": "Privacy_Automation",
    ]
    guard let anchor = anchors[pane] else { throw HelperError.invalid("pane must be one of \(anchors.keys.sorted())") }
    guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else {
        throw HelperError.failed("bad settings url")
    }
    let ok = NSWorkspace.shared.open(url)
    return ["opened": ok, "pane": pane]
}

// MARK: - Apps

func appDict(_ a: NSRunningApplication) -> [String: Any] {
    var d: [String: Any] = [
        "pid": Int(a.processIdentifier),
        "name": a.localizedName ?? a.bundleURL?.deletingPathExtension().lastPathComponent ?? "",
        "bundle_id": orNull(a.bundleIdentifier),
        "is_active": a.isActive,
        "is_hidden": a.isHidden,
    ]
    if let path = a.bundleURL?.path { d["path"] = path }
    switch a.activationPolicy {
    case .regular: d["activation_policy"] = "regular"
    case .accessory: d["activation_policy"] = "accessory"
    default: d["activation_policy"] = "prohibited"
    }
    return d
}

func frontmostApp() -> NSRunningApplication? {
    NSWorkspace.shared.frontmostApplication
}

func cmdRunningApps(_ p: Params) throws -> Any {
    let all = try p.bool("all") ?? false
    return NSWorkspace.shared.runningApplications
        .filter { all || $0.activationPolicy == .regular }
        .filter { $0.processIdentifier != getpid() }
        .map(appDict)
}

/// Finds a running app by pid / bundle_id / name (exact case-insensitive, then prefix/contains).
func findRunningApp(_ p: Params) throws -> NSRunningApplication {
    if let pid = try p.int("pid") {
        guard let a = NSRunningApplication(processIdentifier: pid_t(pid)) else { throw HelperError.notFound("no running app with pid \(pid)") }
        return a
    }
    let apps = NSWorkspace.shared.runningApplications
    if let bid = try p.string("bundle_id") {
        guard let a = apps.first(where: { $0.bundleIdentifier?.lowercased() == bid.lowercased() && !$0.isTerminated }) else {
            throw HelperError.notFound("no running app with bundle_id \(bid)")
        }
        return a
    }
    if let raw = try p.string("name") {
        let name = raw.lowercased().replacingOccurrences(of: ".app", with: "")
        let candidates = apps.filter { !$0.isTerminated }
        func n(_ a: NSRunningApplication) -> String { (a.localizedName ?? "").lowercased() }
        if let a = candidates.first(where: { n($0) == name }) ?? candidates.first(where: { $0.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == name })
            ?? candidates.first(where: { $0.activationPolicy == .regular && n($0).hasPrefix(name) })
            ?? candidates.first(where: { $0.activationPolicy == .regular && n($0).contains(name) }) {
            return a
        }
        throw HelperError.notFound("no running app named '\(raw)'")
    }
    throw HelperError.invalid("provide one of 'pid', 'bundle_id' or 'name'")
}

func appSearchDirs() -> [URL] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return [
        "/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
        home.appendingPathComponent("Applications").path, "/System/Library/CoreServices", "/System/Volumes/Preboot/Cryptexes/App/System/Applications",
    ].map { URL(fileURLWithPath: $0) }
}

func findAppBundle(named raw: String) -> URL? {
    let target = raw.lowercased().hasSuffix(".app") ? raw.lowercased() : raw.lowercased() + ".app"
    let fm = FileManager.default
    var subdirs: [URL] = []
    for dir in appSearchDirs() {
        guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { continue }
        for item in items {
            let last = item.lastPathComponent.lowercased()
            if last == target { return item }
            if !last.hasSuffix(".app"), dir.path == "/Applications" { subdirs.append(item) }
        }
    }
    // One level of nesting (e.g. /Applications/Setapp/Foo.app)
    for dir in subdirs {
        guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { continue }
        if let hit = items.first(where: { $0.lastPathComponent.lowercased() == target }) { return hit }
    }
    // Spotlight as a last resort.
    let esc = raw.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
    let (status, out) = runProcess("/usr/bin/mdfind", ["kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName ==[c] '\(esc)'"], timeout: 3)
    if status == 0, let first = out.split(separator: "\n").first, !first.isEmpty {
        return URL(fileURLWithPath: String(first))
    }
    return nil
}

func cmdOpenApp(_ p: Params) throws -> Any {
    var url: URL?
    if let path = try p.string("path") {
        let u = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        guard FileManager.default.fileExists(atPath: u.path) else { throw HelperError.notFound("no app at path \(path)") }
        url = u
    } else if let bid = try p.string("bundle_id") {
        url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid)
        if url == nil { throw HelperError.notFound("no application with bundle id \(bid)") }
    } else if let name = try p.string("name") {
        if let running = try? findRunningApp(Params(["name": name])), let bu = running.bundleURL {
            url = bu
        } else if let u = findAppBundle(named: name) {
            url = u
        } else if name.contains("."), let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) {
            url = u
        }
        if url == nil { throw HelperError.notFound("could not find an application named '\(name)'") }
    } else {
        throw HelperError.invalid("open_app requires 'name', 'bundle_id' or 'path'")
    }
    let appURL = url!
    let activate = try p.bool("activate") ?? true
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = activate
    if let args = try p.stringList("args") { cfg.arguments = args }
    let box = Box<(NSRunningApplication?, Error?)>((nil, nil))
    let sem = DispatchSemaphore(value: 0)
    // urls: open them in that app (a page in a browser, a file in an editor) in the same step
    let urls = try (p.stringList("urls") ?? []).map { (s: String) -> URL in
        if s.hasPrefix("/") || s.hasPrefix("~") { return URL(fileURLWithPath: (s as NSString).expandingTildeInPath) }
        guard let u = URL(string: s), u.scheme != nil else { throw HelperError.invalid("invalid url '\(s)' (must include a scheme, e.g. https://)") }
        return u
    }
    let done: (NSRunningApplication?, Error?) -> Void = { app, err in
        box.value = (app, err)
        sem.signal()
    }
    if urls.isEmpty { NSWorkspace.shared.openApplication(at: appURL, configuration: cfg, completionHandler: done) }
    else { NSWorkspace.shared.open(urls, withApplicationAt: appURL, configuration: cfg, completionHandler: done) }
    if sem.wait(timeout: .now() + 10) == .timedOut {
        throw HelperError("timeout", "application did not launch within 10s")
    }
    if let err = box.value.1 { throw HelperError("launch_failed", err.localizedDescription) }
    guard let app = box.value.0 else { throw HelperError("launch_failed", "launch returned no application") }
    let deadline = Date().addingTimeInterval(10)
    while !app.isFinishedLaunching && Date() < deadline { usleep(50_000) }
    var r: [String: Any] = [
        "pid": Int(app.processIdentifier),
        "bundle_id": orNull(app.bundleIdentifier),
        "name": app.localizedName ?? appURL.deletingPathExtension().lastPathComponent,
        "path": appURL.path,
        "finished_launching": app.isFinishedLaunching,
    ]
    if activate {
        _ = activateApp(app)
        r["is_active"] = frontmostApp()?.processIdentifier == app.processIdentifier
    }
    return r
}

/// Brings an app to the front, trying several strategies (macOS 14+ cooperative activation can
/// refuse requests from background processes).
@discardableResult
func activateApp(_ app: NSRunningApplication) -> Bool {
    let pid = app.processIdentifier
    func isFront() -> Bool { frontmostApp()?.processIdentifier == pid }
    if isFront() { return true }
    if app.isHidden { app.unhide() }
    if #available(macOS 14.0, *) {
        app.activate(from: NSRunningApplication.current, options: [.activateAllWindows])
        if !isFront() { app.activate(options: [.activateAllWindows]) }
    } else {
        app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    }
    for _ in 0..<10 { if isFront() { return true }; usleep(30_000) }
    // Accessibility: set AXFrontmost on the application element.
    if AXIsProcessTrusted() {
        let el = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(el, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        for _ in 0..<10 { if isFront() { return true }; usleep(30_000) }
    }
    // Re-opening the bundle through LaunchServices reliably activates it.
    if let url = app.bundleURL {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        let sem = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, _ in sem.signal() }
        _ = sem.wait(timeout: .now() + 3)
        for _ in 0..<15 { if isFront() { return true }; usleep(30_000) }
    }
    return isFront()
}

func cmdActivateApp(_ p: Params) throws -> Any {
    let app = try findRunningApp(p)
    let ok = activateApp(app)
    var r = appDict(app)
    r["activated"] = ok
    return r
}

func cmdQuitApp(_ p: Params) throws -> Any {
    let app = try findRunningApp(p)
    let force = try p.bool("force") ?? false
    let sent = force ? app.forceTerminate() : app.terminate()
    let deadline = Date().addingTimeInterval(try p.double("timeout_s") ?? 3)
    while !app.isTerminated && Date() < deadline { usleep(50_000) }
    return ["pid": Int(app.processIdentifier), "name": app.localizedName ?? "", "request_sent": sent, "terminated": app.isTerminated,
            "note": app.isTerminated ? "" : "app may be showing a save/confirm dialog"]
}

func cmdFrontmostApp(_ p: Params) throws -> Any {
    guard let a = frontmostApp() else { throw HelperError.notFound("no frontmost application") }
    return ["pid": Int(a.processIdentifier), "name": a.localizedName ?? "", "bundle_id": orNull(a.bundleIdentifier)]
}

func cmdOpenURL(_ p: Params) throws -> Any {
    let s = try p.reqString("url")
    guard let url = URL(string: s), url.scheme != nil else { throw HelperError.invalid("invalid url '\(s)' (must include a scheme, e.g. https://)") }
    var opened = false
    if let bid = try p.string("bundle_id"), let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) {
        let sem = DispatchSemaphore(value: 0)
        let box = Box(false)
        NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration()) { app, _ in
            box.value = app != nil
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 10)
        opened = box.value
    } else {
        opened = NSWorkspace.shared.open(url)
    }
    if !opened { throw HelperError.failed("could not open \(s)") }
    return ["opened": true, "url": s]
}

func cmdOpenPath(_ p: Params) throws -> Any {
    let raw = try p.reqString("path")
    let path = (raw as NSString).expandingTildeInPath
    guard FileManager.default.fileExists(atPath: path) else { throw HelperError.notFound("no such file: \(path)") }
    let url = URL(fileURLWithPath: path)
    if try p.bool("reveal") ?? false {
        NSWorkspace.shared.activateFileViewerSelecting([url])
        return ["revealed": true, "path": path]
    }
    guard NSWorkspace.shared.open(url) else { throw HelperError.failed("could not open \(path)") }
    return ["opened": true, "path": path]
}

// MARK: - Windows

struct WinInfo {
    let id: CGWindowID
    let pid: pid_t
    let app: String
    let title: String
    let bounds: CGRect
    let layer: Int
    let onScreen: Bool
    let alpha: Double

    var dict: [String: Any] {
        ["window_id": Int(id), "pid": Int(pid), "app": app, "title": title, "bounds": rectDict(bounds),
         "layer": layer, "is_on_screen": onScreen, "alpha": alpha]
    }
}

func parseWindow(_ d: [String: Any]) -> WinInfo? {
    guard let num = (d[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
          let pid = (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { return nil }
    var bounds = CGRect.zero
    if let bd = d[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: bd as CFDictionary) { bounds = r }
    return WinInfo(
        id: num, pid: pid,
        app: d[kCGWindowOwnerName as String] as? String ?? "",
        title: d[kCGWindowName as String] as? String ?? "",
        bounds: bounds,
        layer: (d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
        onScreen: (d[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
        alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
    )
}

func windowList(onScreenOnly: Bool) -> [WinInfo] {
    let opts: CGWindowListOption = onScreenOnly ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements]
    guard let arr = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
    return arr.compactMap(parseWindow)
}

func windowInfo(_ id: CGWindowID) -> WinInfo? {
    guard let arr = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] else { return nil }
    return arr.compactMap(parseWindow).first(where: { $0.id == id })
}

func cmdListWindows(_ p: Params) throws -> Any {
    let onScreen = try p.bool("on_screen_only") ?? true
    let allLayers = try p.bool("all_layers") ?? false
    let pidFilter = try p.int("pid")
    let appFilter = try p.string("app")?.lowercased()
    var wins = windowList(onScreenOnly: onScreen).filter { w in
        (allLayers || w.layer == 0) && w.alpha > 0 && w.pid != getpid()
            && (pidFilter == nil || Int(w.pid) == pidFilter!)
            && (appFilter == nil || w.app.lowercased().contains(appFilter!))
            && w.bounds.width > 1 && w.bounds.height > 1
    }
    // Without Screen Recording permission CG hides window titles; fill them in via AX when possible.
    if AXIsProcessTrusted() && wins.contains(where: { $0.title.isEmpty }) {
        var titles: [CGWindowID: String] = [:]
        for pid in Set(wins.filter { $0.title.isEmpty }.map { $0.pid }) {
            for w in axWindows(AXUIElementCreateApplication(pid)) {
                if let id = axWindowID(w), let t = axString(axAttr(w, kAXTitleAttribute)) { titles[id] = t }
            }
        }
        wins = wins.map { w in
            guard w.title.isEmpty, let t = titles[w.id] else { return w }
            return WinInfo(id: w.id, pid: w.pid, app: w.app, title: t, bounds: w.bounds, layer: w.layer, onScreen: w.onScreen, alpha: w.alpha)
        }
    }
    return wins.map { $0.dict }
}

func cmdFocusWindow(_ p: Params) throws -> Any {
    try requireAX()
    let wid = try p.int("window_id")
    let titleQ = try p.string("title")?.lowercased()
    var pid: pid_t
    if let pp = try p.int("pid") {
        pid = pid_t(pp)
    } else if let wid {
        guard let info = windowInfo(CGWindowID(wid)) else { throw HelperError.notFound("no window with id \(wid)") }
        pid = info.pid
    } else if let titleQ {
        guard let w = windowList(onScreenOnly: false).first(where: { $0.layer == 0 && $0.title.lowercased().contains(titleQ) }) else {
            throw HelperError.notFound("no window whose title contains '\(titleQ)' (titles need Screen Recording permission; pass pid too)")
        }
        pid = w.pid
    } else {
        throw HelperError.invalid("focus_window requires 'window_id', 'pid' or 'title'")
    }
    // NSRunningApplication(processIdentifier:) can lag behind an app launched a moment ago; the list may not
    guard let app = NSRunningApplication(processIdentifier: pid)
        ?? NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == pid && !$0.isTerminated }) else {
        throw HelperError.notFound("no running app with pid \(pid)")
    }
    let appEl = AXUIElementCreateApplication(pid)
    let wins = axWindows(appEl)
    var target: AXUIElement?
    if let wid {
        target = wins.first(where: { axWindowID($0) == CGWindowID(wid) })
        if target == nil, let info = windowInfo(CGWindowID(wid)) {
            // Fall back to matching by frame.
            target = wins.first(where: { axFrame($0)?.equalTo(info.bounds) ?? false })
                ?? wins.first(where: { !info.title.isEmpty && axString(axAttr($0, kAXTitleAttribute)) == info.title })
        }
    } else if let titleQ {
        target = wins.first(where: { (axString(axAttr($0, kAXTitleAttribute)) ?? "").lowercased() == titleQ })
            ?? wins.first(where: { (axString(axAttr($0, kAXTitleAttribute)) ?? "").lowercased().contains(titleQ) })
    } else {
        target = wins.first
    }
    guard let win = target else {
        throw HelperError.notFound("could not find a matching AX window for pid \(pid) (\(wins.count) windows)")
    }
    if (axAttr(win, kAXMinimizedAttribute) as? Bool) == true {
        AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }
    let activated = activateApp(app)
    AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(win, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let raised = AXUIElementPerformAction(win, kAXRaiseAction as CFString)
    var r: [String: Any] = ["pid": Int(pid), "app": app.localizedName ?? "", "title": axString(axAttr(win, kAXTitleAttribute)) ?? "",
                            "activated": activated, "raised": raised == .success]
    if let id = axWindowID(win) { r["window_id"] = Int(id) }
    if let f = axFrame(win) { r["bounds"] = rectDict(f) }
    return r
}

func cmdFocusedWindow(_ p: Params) throws -> Any {
    guard let app = frontmostApp() else { throw HelperError.notFound("no frontmost application") }
    let pid = app.processIdentifier
    var r: [String: Any] = ["pid": Int(pid), "app": app.localizedName ?? ""]
    if AXIsProcessTrusted() {
        let appEl = AXUIElementCreateApplication(pid)
        if let wv = axAttr(appEl, kAXFocusedWindowAttribute), CFGetTypeID(wv) == AXUIElementGetTypeID() {
            let win = wv as! AXUIElement
            r["title"] = axString(axAttr(win, kAXTitleAttribute)) ?? ""
            if let f = axFrame(win) { r["bounds"] = rectDict(f) }
            if let id = axWindowID(win) { r["window_id"] = Int(id) }
            r["source"] = "ax"
            return r
        }
    }
    // Fallback: topmost normal-layer CG window of the frontmost app.
    guard let w = windowList(onScreenOnly: true).first(where: { $0.pid == pid && $0.layer == 0 && $0.alpha > 0 }) else {
        throw HelperError.notFound("frontmost app '\(app.localizedName ?? "")' has no focused window")
    }
    r["title"] = w.title
    r["bounds"] = rectDict(w.bounds)
    r["window_id"] = Int(w.id)
    r["source"] = "cg"
    if !AXIsProcessTrusted() { r["warning"] = "Accessibility not granted; using CGWindowList fallback" }
    return r
}

// MARK: - Clipboard

func cmdClipboardGet(_ p: Params) throws -> Any {
    let pb = NSPasteboard.general
    let types = pb.types?.map { $0.rawValue } ?? []
    var r: [String: Any] = ["text": orNull(pb.string(forType: .string)), "types": types, "change_count": pb.changeCount]
    // include_data: full snapshot (every item, every type, base64) so it can be restored exactly
    // with clipboard_set {"items": ...}.
    if try p.bool("include_data") ?? false {
        r["items"] = (pb.pasteboardItems ?? []).map { item -> [String: Any] in
            var d: [String: Any] = [:]
            for t in item.types { if let data = item.data(forType: t) { d[t.rawValue] = data.base64EncodedString() } }
            return d
        }
    }
    return r
}

func cmdClipboardSet(_ p: Params) throws -> Any {
    let pb = NSPasteboard.general
    if let items = try p.array("items") {
        var newItems: [NSPasteboardItem] = []
        for (i, any) in items.enumerated() {
            guard let d = any as? [String: Any] else { throw HelperError.invalid("items[\(i)] must be an object {type: base64}") }
            let item = NSPasteboardItem()
            for (type, v) in d {
                guard let b64 = v as? String, let data = Data(base64Encoded: b64) else {
                    throw HelperError.invalid("items[\(i)][\"\(type)\"] must be base64 data")
                }
                item.setData(data, forType: NSPasteboard.PasteboardType(type))
            }
            newItems.append(item)
        }
        pb.clearContents()
        guard newItems.isEmpty || pb.writeObjects(newItems) else { throw HelperError.failed("could not write clipboard items") }
        return ["ok": true, "items": newItems.count, "change_count": pb.changeCount]
    }
    let text = try p.reqString("text")
    pb.clearContents()
    guard pb.setString(text, forType: .string) else { throw HelperError.failed("could not write to the clipboard") }
    return ["ok": true, "length": text.count, "change_count": pb.changeCount]
}

// MARK: - Misc

func cmdNotify(_ p: Params) throws -> Any {
    let title = try p.string("title") ?? "AppuBot"
    let body = try p.string("body") ?? ""
    let (status, _) = runProcess("/usr/bin/osascript", [
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        title, body,
    ], timeout: 5)
    guard status == 0 else { throw HelperError.failed("osascript exited with status \(status)") }
    return ["posted": true]
}

func cmdWait(_ p: Params) throws -> Any {
    let ms = try p.reqDouble("ms")
    guard ms >= 0, ms <= 600_000 else { throw HelperError.invalid("ms must be between 0 and 600000") }
    sleepMs(ms)
    return ["waited_ms": ms]
}

func sessionInfo() -> [String: Any] {
    var r: [String: Any] = [:]
    if let d = CGSessionCopyCurrentDictionary() as? [String: Any] {
        r["screen_locked"] = (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
        r["on_console"] = (d["kCGSSessionOnConsoleKey"] as? NSNumber)?.boolValue ?? true
    }
    return r
}

func cmdPing(_ p: Params) throws -> Any {
    var r: [String: Any] = ["version": helperVersion, "pid": Int(getpid())]
    for (k, v) in sessionInfo() { r[k] = v }
    return r
}
