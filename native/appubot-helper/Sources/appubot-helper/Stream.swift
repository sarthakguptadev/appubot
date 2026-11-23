import Foundation
import AppKit
import CoreMedia
import CoreVideo
import ScreenCaptureKit

// Persistent window capture: one ScreenCaptureKit stream per window, kept running while it is asked for, so a
// picture is the newest frame (a few ms) rather than a fresh one-shot capture (100-150ms). A frame is only handed
// out once the stream has reported in after the request (a complete frame, or "idle": nothing changed), so it
// never predates the action that came before it. Streams nobody asked for in `idleStop` seconds are stopped, and all of them when a computer-use turn ends (`window_stream_stop`).

@available(macOS 14.0, *)
final class WindowStream: NSObject, SCStreamOutput, SCStreamDelegate {
    let windowID: CGWindowID
    // made after super.init so the stream can report to us when it stops (`failed`)
    private var stream: SCStream!
    private let lock = NSLock()
    private var latest: CGImage?
    private var lastReport = Date.distantPast
    private(set) var size: (Int, Int)
    private(set) var failed: Error?
    var lastUsed = Date()
    private let queue: DispatchQueue

    init(window: SCWindow, size: (Int, Int)) throws {
        windowID = window.windowID
        self.size = size
        queue = DispatchQueue(label: "appubot.stream.\(window.windowID)", qos: .userInitiated)
        let filter = SCContentFilter(desktopIndependentWindow: window)
        super.init()
        stream = SCStream(filter: filter, configuration: WindowStream.config(size), delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    }

    static func config(_ size: (Int, Int)) -> SCStreamConfiguration {
        let cfg = SCStreamConfiguration()
        cfg.width = size.0
        cfg.height = size.1
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        cfg.queueDepth = 3
        cfg.showsCursor = false
        cfg.ignoreShadowsSingleWindow = true
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        return cfg
    }

    func start() throws {
        let sem = DispatchSemaphore(value: 0)
        let box = Box<Error?>(nil)
        stream.startCapture { err in box.value = err; sem.signal() }
        if sem.wait(timeout: .now() + 3) == .timedOut { throw HelperError("timeout", "window stream did not start") }
        if let e = box.value { throw HelperError("capture_failed", "window stream: \(e.localizedDescription)") }
    }

    func stop() { stream.stopCapture { _ in } }

    func resize(_ s: (Int, Int)) {
        guard s != size else { return }
        size = s
        lock.lock(); latest = nil; lock.unlock()
        stream.updateConfiguration(WindowStream.config(s)) { _ in }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { failed = error }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        let status = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?
            .first?[.status] as? Int
        var img: CGImage?
        if status == SCFrameStatus.complete.rawValue, let pb = CMSampleBufferGetImageBuffer(sb) {
            let ci = CIImage(cvPixelBuffer: pb)
            img = WindowStreams.ci.createCGImage(ci, from: ci.extent)
        }
        lock.lock()
        if let img { latest = img }
        lastReport = Date()
        lock.unlock()
    }

    /// The newest frame, once the stream has reported in after `since` (waits up to `timeout`).
    func frame(since: Date, timeout: TimeInterval) -> CGImage? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            lock.lock()
            let img = latest, fresh = lastReport > since
            lock.unlock()
            if let img, fresh { return img }
            if Date() > deadline || failed != nil { return nil }
            usleep(4_000)
        }
    }
}

@available(macOS 14.0, *)
final class WindowStreams {
    static let shared = WindowStreams()
    static let ci = CIContext(options: [.useSoftwareRenderer: false])
    private var streams: [CGWindowID: WindowStream] = [:]
    private let lock = NSLock()
    private let maxStreams = 3
    private let idleStop: TimeInterval = 120
    private var timer: DispatchSourceTimer?

    func stream(for wid: CGWindowID, size: (Int, Int)) throws -> (WindowStream, Bool) {
        lock.lock(); defer { lock.unlock() }
        if let s = streams[wid], s.failed == nil {
            s.lastUsed = Date()
            s.resize(size)
            return (s, false)
        }
        streams[wid]?.stop()
        streams[wid] = nil
        guard let content = sckShareableContent(), let win = content.windows.first(where: { $0.windowID == wid }) else {
            throw HelperError.notFound("no capturable window with id \(wid)")
        }
        if streams.count >= maxStreams, let oldest = streams.values.min(by: { $0.lastUsed < $1.lastUsed }) {
            oldest.stop()
            streams[oldest.windowID] = nil
        }
        let s = try WindowStream(window: win, size: size)
        try s.start()
        streams[wid] = s
        armTimer()
        return (s, true)
    }

    func stopAll() -> Int {
        lock.lock(); defer { lock.unlock() }
        let n = streams.count
        for s in streams.values { s.stop() }
        streams.removeAll()
        return n
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
        let now = Date()
        for (id, s) in streams where now.timeIntervalSince(s.lastUsed) > idleStop || s.failed != nil {
            s.stop()
            streams[id] = nil
        }
        if streams.isEmpty { timer?.cancel(); timer = nil }
    }
}

/// window_stream_frame {window_id, max_dimension?, format?, quality?}: the window's newest frame from its stream
/// (started on first use). The picture is the window at its backing scale, long edge capped at max_dimension.
func cmdWindowStreamFrame(_ p: Params) throws -> Any {
    let t0 = Date()
    guard #available(macOS 14.0, *) else { throw HelperError("unsupported", "window streams need macOS 14") }
    guard CGPreflightScreenCaptureAccess() else { throw HelperError("permission_denied", "Screen Recording permission is not granted") }
    let wid = try p.reqInt("window_id")
    guard wid > 0, wid <= Int(UInt32.max) else { throw HelperError.invalid("window_id out of range") }
    guard let info = windowInfo(CGWindowID(wid)) else { throw HelperError.notFound("no window with id \(wid)") }
    let maxDim = try p.int("max_dimension") ?? 0
    let format = (try p.string("format") ?? "jpeg").lowercased()
    let quality = try p.double("quality") ?? 0.85
    let scale = Double(NSScreen.screens.first(where: { $0.frame.intersects(info.bounds) })?.backingScaleFactor ?? 2)
    var w = Double(info.bounds.width) * scale, h = Double(info.bounds.height) * scale
    if maxDim > 0, max(w, h) > Double(maxDim) { let k = Double(maxDim) / max(w, h); w *= k; h *= k }
    let size = (max(1, Int(w.rounded())), max(1, Int(h.rounded())))
    let (s, started) = try WindowStreams.shared.stream(for: CGWindowID(wid), size: size)
    guard let img = s.frame(since: t0, timeout: started ? 1.5 : 0.5) else {
        throw HelperError("capture_failed", "window stream gave no frame (window minimised or on another Space?)")
    }
    let final = (img.width == size.0 && img.height == size.1) ? img : try resizeImage(img, width: size.0, height: size.1, opaque: false)
    let data = try encodeImage(final, format: format == "png" ? "png" : "jpeg", quality: quality)
    return [
        "image_base64": data.base64EncodedString(),
        "format": format == "png" ? "png" : "jpeg",
        "width": size.0,
        "height": size.1,
        "bounds": rectDict(info.bounds),
        "app": info.app,
        "title": info.title,
        "started": started,
        "elapsed_ms": Int(Date().timeIntervalSince(t0) * 1000),
    ]
}

func cmdWindowStreamStop(_ p: Params) throws -> Any {
    guard #available(macOS 14.0, *) else { return ["stopped": 0] }
    return ["stopped": WindowStreams.shared.stopAll()]
}
