import Foundation
import AppKit
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import IOKit.pwr_mgt

/// Someone watching the screen from afar is someone using the Mac: a display asleep has no picture to capture
/// (ScreenCaptureKit lists no display then), so watching wakes it (declared user activity, as a key press would) and
/// keeps it from idling to sleep while a stream runs.
enum DisplayAwake {
    private static var hold: IOPMAssertionID = 0
    private static var lastWake = Date.distantPast
    private static let lock = NSLock()

    /// Wakes the display (at most once a second: it is asked on every picture).
    static func wake() {
        lock.lock(); defer { lock.unlock() }
        guard Date().timeIntervalSince(lastWake) > 1 else { return }
        lastWake = Date()
        var id: IOPMAssertionID = 0
        _ = IOPMAssertionDeclareUserActivity("AppuBot live view" as CFString, kIOPMUserActiveLocal, &id)
    }

    /// The Mac's screen is locked (macOS lets nothing capture it then, and only the person at the Mac can unlock it).
    static var locked: Bool {
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (d["CGSSessionScreenIsLocked"] as? Bool) ?? false
    }

    /// who keeps the display awake now (the picture stream, the video stream): it sleeps again once neither does
    private static var holders = Set<String>()

    static func keep(_ on: Bool, for who: String = "pictures") {
        lock.lock(); defer { lock.unlock() }
        if on { holders.insert(who) } else { holders.remove(who) }
        if !holders.isEmpty, hold == 0 {
            _ = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "AppuBot live view" as CFString, &hold)
        } else if holders.isEmpty, hold != 0 {
            IOPMAssertionRelease(hold)
            hold = 0
        }
    }
}

// The whole display, live, for someone watching it from a phone (live view): one ScreenCaptureKit stream of the
// display (the cursor drawn in, or left out for a viewer that draws its own where `cursor` says), kept running while frames are asked for (stopped `idleStop` seconds after the
// last ask, or by `display_stream_stop`). Pictures are numbered: a caller that already has the newest one waits a
// little for the next (nothing changes on a still screen, so nothing is sent) and hears "unchanged" if none comes.

@available(macOS 14.0, *)
final class DisplayStream: NSObject, SCStreamOutput, SCStreamDelegate {
    let displayID: CGDirectDisplayID
    let bounds: CGRect
    // made after super.init so the stream can report to us when it stops (`failed`: a new one is started)
    private var stream: SCStream!
    private let lock = NSLock()
    private var latest: CGImage?
    private var count = 0
    // pictures are numbered across streams, so a viewer's number never runs ahead of a stream started again
    private static var numbered = 0
    private static let numberLock = NSLock()
    private static func nextNumber() -> Int {
        numberLock.lock(); defer { numberLock.unlock() }
        numbered += 1
        return numbered
    }
    private(set) var failed: Error?
    private(set) var size: (Int, Int)
    private(set) var cursor: Bool
    var lastUsed = Date()
    private let queue = DispatchQueue(label: "appubot.display-stream", qos: .userInitiated)

    init(display: SCDisplay, bounds: CGRect, size: (Int, Int), cursor: Bool) throws {
        displayID = display.displayID
        self.bounds = bounds
        self.size = size
        self.cursor = cursor
        let filter = SCContentFilter(display: display, excludingWindows: [])
        super.init()
        stream = SCStream(filter: filter, configuration: DisplayStream.config(size, cursor: cursor), delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    }

    static func config(_ size: (Int, Int), cursor: Bool) -> SCStreamConfiguration {
        let cfg = SCStreamConfiguration()
        cfg.width = size.0
        cfg.height = size.1
        // a change shows within a frame of the display's (30 a second); a still screen sends nothing
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        cfg.queueDepth = 3
        cfg.showsCursor = cursor
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        return cfg
    }

    func start() throws {
        let sem = DispatchSemaphore(value: 0)
        let box = Box<Error?>(nil)
        stream.startCapture { err in box.value = err; sem.signal() }
        if sem.wait(timeout: .now() + 3) == .timedOut { throw HelperError("timeout", "display stream did not start") }
        if let e = box.value { throw HelperError("capture_failed", "display stream: \(e.localizedDescription)") }
    }

    func stop() { stream.stopCapture { _ in } }

    func reconfigure(size s: (Int, Int), cursor c: Bool) {
        guard s != size || c != cursor else { return }
        size = s
        cursor = c
        stream.updateConfiguration(DisplayStream.config(s, cursor: c)) { _ in }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { failed = error }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        let status = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?
            .first?[.status] as? Int
        guard status == SCFrameStatus.complete.rawValue, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let ci = CIImage(cvPixelBuffer: pb)
        guard let img = WindowStreams.ci.createCGImage(ci, from: ci.extent) else { return }
        let n = DisplayStream.nextNumber()
        lock.lock()
        latest = img
        count = n
        lock.unlock()
    }

    /// The newest picture and its number, once there is one newer than `after` (waits up to `timeout`).
    func frame(after: Int, timeout: TimeInterval) -> (CGImage, Int)? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            lock.lock()
            let img = latest, n = count
            lock.unlock()
            if let img, n > after { return (img, n) }
            if Date() > deadline || failed != nil { return nil }
            usleep(8_000)
        }
    }
}

@available(macOS 14.0, *)
final class DisplayStreams {
    static let shared = DisplayStreams()
    private var current: DisplayStream?
    private let lock = NSLock()
    private let idleStop: TimeInterval = 15
    private var timer: DispatchSourceTimer?

    func stream(for display: DisplayInfo, size: (Int, Int), cursor: Bool) throws -> (DisplayStream, Bool) {
        lock.lock(); defer { lock.unlock() }
        if let s = current, s.displayID == display.id, s.failed == nil {
            s.lastUsed = Date()
            // the largest picture anyone watching asked for; smaller ones are scaled down from it
            s.reconfigure(size: (max(size.0, s.size.0), max(size.1, s.size.1)), cursor: cursor)
            return (s, false)
        }
        current?.stop()
        current = nil
        DisplayAwake.wake()
        // a display that was asleep comes back within a second or two: look again meanwhile
        var found: SCDisplay?
        for attempt in 0..<8 {
            if attempt > 0 { usleep(300_000) }
            found = sckShareableContent()?.displays.first(where: { $0.displayID == display.id })
            if found != nil { break }
        }
        guard let d = found else {
            throw HelperError.notFound("no capturable display with id \(display.id) (asleep or locked?)")
        }
        let s = try DisplayStream(display: d, bounds: display.bounds, size: size, cursor: cursor)
        try s.start()
        current = s
        DisplayAwake.keep(true)
        armTimer()
        return (s, true)
    }

    func stop() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let s = current else { return false }
        s.stop()
        current = nil
        DisplayAwake.keep(false)
        return true
    }

    private func armTimer() {
        guard timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        t.schedule(deadline: .now() + 5, repeating: 5)
        t.setEventHandler { [weak self] in self?.reap() }
        t.resume()
        timer = t
    }

    private func reap() {
        lock.lock(); defer { lock.unlock() }
        if let s = current, Date().timeIntervalSince(s.lastUsed) > idleStop || s.failed != nil {
            s.stop()
            current = nil
        }
        if current == nil { DisplayAwake.keep(false); timer?.cancel(); timer = nil }
    }
}

/// display_stream_frame {display?, max_dimension?, quality?, after?, wait_ms?, cursor?}: the display's newest picture
/// from its live stream, started on first use; `cursor: false` leaves the cursor out of it (a viewer drawing its own
/// at `cursor`, the pointer's place in global points, which every answer carries). `display`: an index (0 = main) or id. `after`: the
/// number of the picture the caller already has; until a newer one comes (up to `wait_ms`, default 250) the answer is
/// {unchanged: true}. `bounds` is the display in global points, where input lands (`click`, `scroll`…).
func cmdDisplayStreamFrame(_ p: Params) throws -> Any {
    let t0 = Date()
    guard #available(macOS 14.0, *) else { throw HelperError("unsupported", "live view needs macOS 14") }
    guard CGPreflightScreenCaptureAccess() else { throw HelperError("permission_denied", "Screen Recording permission is not granted") }
    if DisplayAwake.locked {
        // nothing to capture; a stream started before the lock has nothing new either
        _ = DisplayStreams.shared.stop()
        throw HelperError("screen_locked", "the screen is locked")
    }
    let displays = activeDisplays()
    guard !displays.isEmpty else { throw HelperError.notFound("no display") }
    let display = try resolveDisplay(try p.int("display") ?? 0, displays)
    let maxDim = try p.int("max_dimension") ?? 1600
    let quality = try p.double("quality") ?? 0.6
    let after = try p.int("after") ?? 0
    let waitMs = try p.double("wait_ms") ?? 250
    let drawCursor = try p.bool("cursor") ?? true
    guard waitMs >= 0, waitMs <= 5_000 else { throw HelperError.invalid("wait_ms must be between 0 and 5000") }
    var w = Double(display.bounds.width) * display.scale, h = Double(display.bounds.height) * display.scale
    if maxDim > 0, max(w, h) > Double(maxDim) { let k = Double(maxDim) / max(w, h); w *= k; h *= k }
    let size = (max(1, Int(w.rounded())), max(1, Int(h.rounded())))
    let (s, started) = try DisplayStreams.shared.stream(for: display, size: size, cursor: drawCursor)
    // a stream just started has no picture yet: give it its first one
    let since = started ? 0 : after
    guard let (img, n) = s.frame(after: since, timeout: started ? 1.5 : waitMs / 1000) else {
        if let e = s.failed { throw HelperError("capture_failed", "display stream: \(e.localizedDescription)") }
        return ["unchanged": true, "seq": after, "bounds": rectDict(display.bounds), "cursor": pointDict(currentCursor()), "elapsed_ms": Int(Date().timeIntervalSince(t0) * 1000)]
    }
    let final = (img.width == size.0 && img.height == size.1) ? img : try resizeImage(img, width: size.0, height: size.1, opaque: true)
    let data = try encodeImage(final, format: "jpeg", quality: quality)
    return [
        "image_base64": data.base64EncodedString(),
        "width": size.0,
        "height": size.1,
        "seq": n,
        "display": Int(display.id),
        "bounds": rectDict(display.bounds),
        "cursor": pointDict(currentCursor()),
        "elapsed_ms": Int(Date().timeIntervalSince(t0) * 1000),
    ]
}

func cmdDisplayStreamStop(_ p: Params) throws -> Any {
    guard #available(macOS 14.0, *) else { return ["stopped": false] }
    return ["stopped": DisplayStreams.shared.stop()]
}
