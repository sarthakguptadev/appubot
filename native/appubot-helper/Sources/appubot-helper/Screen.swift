import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit

// MARK: - Displays

struct DisplayInfo {
    let id: CGDirectDisplayID
    let index: Int
    let bounds: CGRect  // global points, top-left origin (Quartz)
    let scale: Double   // backing pixels per point
    let isMain: Bool

    var dict: [String: Any] {
        [
            "id": Int(id),
            "index": index,
            "bounds": rectDict(bounds),
            "scale": scale,
            "is_main": isMain,
            "pixel_width": Int((Double(bounds.width) * scale).rounded()),
            "pixel_height": Int((Double(bounds.height) * scale).rounded()),
        ]
    }
}

func displayScale(_ id: CGDirectDisplayID) -> Double {
    if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 {
        let s = Double(mode.pixelWidth) / Double(mode.width)
        if s.isFinite && s > 0 { return s }
    }
    return 1
}

/// Active displays; index 0 is always the main display.
func activeDisplays() -> [DisplayInfo] {
    var count: UInt32 = 0
    var ids: [CGDirectDisplayID] = []
    if CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 {
        ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        if CGGetActiveDisplayList(count, &ids, &count) != .success { count = 0 }
    }
    if count == 0 {
        // Displays that are asleep (e.g. lid closed / display sleep) are online but not active.
        if CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 {
            ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
            if CGGetOnlineDisplayList(count, &ids, &count) != .success { count = 0 }
        }
        // Skip hardware mirrors of another display.
        ids = Array(ids.prefix(Int(count))).filter { CGDisplayMirrorsDisplay($0) == kCGNullDirectDisplay }
        count = UInt32(ids.count)
    }
    guard count > 0 else { return [] }
    let main = CGMainDisplayID()
    let list = Array(ids.prefix(Int(count)))
    let ordered = list.filter { $0 == main } + list.filter { $0 != main }
    return ordered.enumerated().map { i, id in
        DisplayInfo(id: id, index: i, bounds: CGDisplayBounds(id), scale: displayScale(id), isMain: id == main)
    }
}

func resolveDisplay(_ value: Int, _ displays: [DisplayInfo]) throws -> DisplayInfo {
    if value >= 0 && value < displays.count { return displays[value] }
    if let d = displays.first(where: { Int($0.id) == value }) { return d }
    throw HelperError.notFound("no display with index or id \(value); have \(displays.map { "index \($0.index)=id \($0.id)" }.joined(separator: ", "))")
}

func displayFor(rect r: CGRect, _ displays: [DisplayInfo]) -> DisplayInfo? {
    let c = CGPoint(x: r.midX, y: r.midY)
    return displays.first(where: { $0.bounds.contains(c) }) ?? displays.first(where: { $0.bounds.intersects(r) })
}

func cmdDisplays(_ p: Params) throws -> Any {
    activeDisplays().map { $0.dict }
}

func cmdScreenSize(_ p: Params) throws -> Any {
    let id = CGMainDisplayID()
    let b = CGDisplayBounds(id)
    return ["width": r2(b.width), "height": r2(b.height), "scale": displayScale(id)]
}

// MARK: - Image helpers

func resizeImage(_ img: CGImage, width: Int, height: Int, opaque: Bool) throws -> CGImage {
    guard width > 0, height > 0 else { throw HelperError.invalid("output image size would be empty") }
    var cs = img.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!
    if !cs.supportsOutput || cs.model != .rgb { cs = CGColorSpace(name: CGColorSpace.sRGB)! }
    let alpha: CGImageAlphaInfo = opaque ? .noneSkipFirst : .premultipliedFirst
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: cs, bitmapInfo: alpha.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
        throw HelperError("image_error", "could not create bitmap context \(width)x\(height)")
    }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let out = ctx.makeImage() else { throw HelperError("image_error", "could not scale image") }
    return out
}

func encodeImage(_ img: CGImage, format: String, quality: Double) throws -> Data {
    let rep = NSBitmapImageRep(cgImage: img)
    let data: Data?
    if format == "jpeg" {
        data = rep.representation(using: .jpeg, properties: [.compressionFactor: NSNumber(value: quality)])
    } else {
        data = rep.representation(using: .png, properties: [:])
    }
    guard let d = data else { throw HelperError("image_error", "failed to encode \(format)") }
    return d
}

struct ImageOptions {
    let format: String
    let quality: Double
    let scale: Double
    let maxWidth: Int?

    init(_ p: Params) throws {
        var f = (try p.string("format") ?? "png").lowercased()
        if f == "jpg" { f = "jpeg" }
        guard f == "png" || f == "jpeg" else { throw HelperError.invalid("format must be 'png' or 'jpeg'") }
        format = f
        let q = try p.double("quality") ?? 0.8
        guard q >= 0 && q <= 1 else { throw HelperError.invalid("quality must be between 0 and 1") }
        quality = q
        let s = try p.double("scale") ?? 1.0
        guard s > 0 && s <= 4 else { throw HelperError.invalid("scale must be > 0 and <= 4 (multiplier on logical points)") }
        scale = s
        let mw = try p.int("max_width")
        if let mw, mw <= 0 { throw HelperError.invalid("max_width must be positive") }
        maxWidth = mw
    }

    /// Output pixel size for a capture whose logical size is `pointSize`.
    func outputSize(pointSize: CGSize) -> (Int, Int) {
        var w = Double(pointSize.width) * scale
        var h = Double(pointSize.height) * scale
        if let mw = maxWidth, w > Double(mw) {
            h = h * Double(mw) / w
            w = Double(mw)
        }
        return (max(1, Int(w.rounded())), max(1, Int(h.rounded())))
    }
}

func finishImage(_ img: CGImage, pointSize: CGSize, opts: ImageOptions, opaque: Bool) throws -> [String: Any] {
    let (w, h) = opts.outputSize(pointSize: pointSize)
    let final = (img.width == w && img.height == h) ? img : try resizeImage(img, width: w, height: h, opaque: opaque)
    let data = try encodeImage(final, format: opts.format, quality: opts.quality)
    return [
        "image_base64": data.base64EncodedString(),
        "format": opts.format,
        "width": w,
        "height": h,
        "scale": r6(Double(w) / Double(max(pointSize.width, 1))),
        "source_scale": r6(Double(img.width) / Double(max(pointSize.width, 1))),
        "bytes": data.count,
    ]
}

// MARK: - Capture

private func waitFor(_ sem: DispatchSemaphore, seconds: Double) -> Bool {
    sem.wait(timeout: .now() + seconds) == .success
}

@available(macOS 12.3, *)
func sckShareableContent() -> SCShareableContent? {
    let box = Box<SCShareableContent?>(nil)
    let sem = DispatchSemaphore(value: 0)
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
        if let error { logErr("SCShareableContent error: \(error.localizedDescription)") }
        box.value = content
        sem.signal()
    }
    _ = waitFor(sem, seconds: 5)
    return box.value
}

@available(macOS 14.0, *)
func sckCaptureRect(_ rect: CGRect, display: DisplayInfo) -> CGImage? {
    let box = Box<CGImage?>(nil)
    let sem = DispatchSemaphore(value: 0)
    if #available(macOS 15.2, *) {
        SCScreenshotManager.captureImage(in: rect) { img, error in
            if let error { logErr("SCScreenshotManager.captureImage(in:) error: \(error.localizedDescription)") }
            box.value = img
            sem.signal()
        }
        _ = waitFor(sem, seconds: 5)
        return box.value
    }
    guard let content = sckShareableContent(),
          let scd = content.displays.first(where: { $0.displayID == display.id }) else { return nil }
    let filter = SCContentFilter(display: scd, excludingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.sourceRect = rect.offsetBy(dx: -display.bounds.minX, dy: -display.bounds.minY)
    cfg.width = max(1, Int(Double(rect.width) * display.scale))
    cfg.height = max(1, Int(Double(rect.height) * display.scale))
    cfg.showsCursor = false
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, error in
        if let error { logErr("SCScreenshotManager error: \(error.localizedDescription)") }
        box.value = img
        sem.signal()
    }
    _ = waitFor(sem, seconds: 5)
    return box.value
}

@available(macOS 14.0, *)
func sckCaptureWindow(_ windowID: CGWindowID) -> CGImage? {
    guard let content = sckShareableContent(),
          let win = content.windows.first(where: { $0.windowID == windowID }) else { return nil }
    let filter = SCContentFilter(desktopIndependentWindow: win)
    let cfg = SCStreamConfiguration()
    let pxScale = Double(filter.pointPixelScale)
    cfg.width = max(1, Int(Double(win.frame.width) * pxScale))
    cfg.height = max(1, Int(Double(win.frame.height) * pxScale))
    cfg.showsCursor = false
    cfg.ignoreShadowsSingleWindow = true
    let box = Box<CGImage?>(nil)
    let sem = DispatchSemaphore(value: 0)
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, error in
        if let error { logErr("SCScreenshotManager window error: \(error.localizedDescription)") }
        box.value = img
        sem.signal()
    }
    _ = waitFor(sem, seconds: 5)
    return box.value
}

/// Captures `rect` (global points) from `display`. Uses the fast legacy CoreGraphics path,
/// falling back to ScreenCaptureKit if it is unavailable.
func captureDisplayRegion(_ display: DisplayInfo, _ rect: CGRect) throws -> (CGImage, String) {
    let local = rect.offsetBy(dx: -display.bounds.minX, dy: -display.bounds.minY)
    if let img = CGDisplayCreateImage(display.id, rect: local) { return (img, "cg") }
    // Only try ScreenCaptureKit when permission is granted (avoids surprise TCC prompts).
    if #available(macOS 14.0, *), CGPreflightScreenCaptureAccess() {
        if let img = sckCaptureRect(rect, display: display) { return (img, "sck") }
    }
    let perm = CGPreflightScreenCaptureAccess()
    throw HelperError(perm ? "capture_failed" : "permission_denied",
                      perm ? "screen capture failed" : "screen capture failed: Screen Recording permission is not granted")
}

let screenRecordingWarning = "Screen Recording permission not granted: the image is most likely blank (solid desktop color, no windows). Grant it in System Settings > Privacy & Security > Screen Recording to the app that launched this helper."

func cmdScreenshot(_ p: Params) throws -> Any {
    let t0 = Date()
    let displays = activeDisplays()
    guard !displays.isEmpty else { throw HelperError.failed("no active displays") }
    let opts = try ImageOptions(p)
    let region = try p.rect("region")
    let display: DisplayInfo
    if let dv = try p.int("display") {
        display = try resolveDisplay(dv, displays)
    } else if let r = region {
        display = displayFor(rect: r, displays) ?? displays[0]
    } else {
        display = displays[0]
    }
    var rect = display.bounds
    if let r = region {
        guard r.width > 0, r.height > 0 else { throw HelperError.invalid("region width/height must be > 0") }
        rect = r.intersection(display.bounds)
        guard !rect.isNull, !rect.isEmpty else {
            throw HelperError.invalid("region \(rectString(r)) does not intersect display \(display.index) bounds \(rectString(display.bounds))")
        }
        rect = rect.integral.intersection(display.bounds)
    }
    let (img, method) = try captureDisplayRegion(display, rect)
    var out = try finishImage(img, pointSize: rect.size, opts: opts, opaque: true)
    out["display_bounds"] = rectDict(display.bounds)
    out["display_id"] = Int(display.id)
    out["display_index"] = display.index
    out["region"] = rectDict(rect)
    out["origin"] = pointDict(rect.origin)
    out["capture_method"] = method
    out["elapsed_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
    if !CGPreflightScreenCaptureAccess() {
        out["screen_recording_permission"] = false
        out["warning"] = screenRecordingWarning
    }
    return out
}

func cmdWindowScreenshot(_ p: Params) throws -> Any {
    let t0 = Date()
    let wid = try p.reqInt("window_id")
    guard wid > 0, wid <= Int(UInt32.max) else { throw HelperError.invalid("window_id out of range") }
    let opts = try ImageOptions(p)
    guard let info = windowInfo(CGWindowID(wid)) else { throw HelperError.notFound("no window with id \(wid)") }
    var img: CGImage? = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(wid), [.boundsIgnoreFraming, .bestResolution])
    var method = "cg"
    if img == nil || img!.width <= 1 {
        if #available(macOS 14.0, *), CGPreflightScreenCaptureAccess() {
            img = sckCaptureWindow(CGWindowID(wid))
            method = "sck"
        }
    }
    guard let image = img else {
        let perm = CGPreflightScreenCaptureAccess()
        throw HelperError(perm ? "capture_failed" : "permission_denied",
                          perm ? "window capture failed (window minimized or off-screen?)" : "window capture failed: Screen Recording permission is not granted")
    }
    var size = info.bounds.size
    if size.width <= 0 || size.height <= 0 { size = CGSize(width: image.width, height: image.height) }
    var out = try finishImage(image, pointSize: size, opts: opts, opaque: false)
    out["window_id"] = wid
    out["bounds"] = rectDict(info.bounds)
    out["origin"] = pointDict(info.bounds.origin)
    out["app"] = info.app
    out["title"] = info.title
    out["capture_method"] = method
    out["elapsed_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
    if !CGPreflightScreenCaptureAccess() {
        out["screen_recording_permission"] = false
        out["warning"] = screenRecordingWarning
    }
    return out
}

/// Small helper used by the watcher: a quick downscaled JPEG of the display under `point`.
func quickScreenshotBase64(at point: CGPoint, scale: Double) -> String? {
    let displays = activeDisplays()
    guard let d = displays.first(where: { $0.bounds.contains(point) }) ?? displays.first else { return nil }
    guard let (img, _) = try? captureDisplayRegion(d, d.bounds) else { return nil }
    let w = max(1, Int(Double(d.bounds.width) * scale)), h = max(1, Int(Double(d.bounds.height) * scale))
    guard let small = try? resizeImage(img, width: w, height: h, opaque: true),
          let data = try? encodeImage(small, format: "jpeg", quality: 0.6) else { return nil }
    return data.base64EncodedString()
}
