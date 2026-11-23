import Foundation
import CoreMedia
import CoreVideo
import VideoToolbox
import ScreenCaptureKit

// Live view as video: the display, live, as an H.264 stream for a phone watching it (the desktop's liveView.ts).
// One ScreenCaptureKit stream of the display (the cursor left out: the phone draws its own) hands its frames straight
// to a hardware VideoToolbox encoder (no copy, no CGImage): real time, low-latency rate control, no frame reordering
// (no B-frames), so each frame leaves the moment it is encoded. Only a screen that changed is encoded (ScreenCaptureKit
// reports a still one as idle frames): a still screen sends nothing, but for a couple of "settle" frames after a
// change, the same picture again, which a still screen's rate control spends sharpening it (a frame encoded mid-motion
// is the bitrate's share of a second; text stays soft until a frame comes with nothing else to spend it on).
//
// Each encoded frame goes out as an unsolicited `{"event":"video", ...}` line from the encoder's own thread, never
// through the command queue: a bot's step never waits behind the video, and the video never waits behind a step.
// Keyframes come on request (`display_video_key`: a phone that joins, lost frames, a decoder error) and every
// `key_interval` seconds. The desktop renews its lease (`display_video_config`) while anyone watches; without it the
// stream stops by itself after `leaseSeconds`, so a desktop gone wrong never leaves the screen recorded.

struct VideoSettings: Equatable {
    /// the picture's long edge in pixels (never above the display's own)
    var maxDim: Int
    /// average bits per second
    var bitrate: Int
    var fps: Int
    /// a keyframe at least this often (seconds) while the screen changes
    var keyInterval: Double
}

@available(macOS 14.0, *)
final class LiveVideo: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = LiveVideo()

    /// stops by itself this long after the desktop last renewed it
    private let leaseSeconds: TimeInterval = 30
    /// after a change, the same picture again this long after it (seconds), if nothing newer came
    private let settleAfter: [Double] = [0.15, 0.5]

    // the stream's life (start, stop, restart) is one at a time
    private let life = NSLock()
    /// frames, encoding and the state below: only on this queue
    private let queue = DispatchQueue(label: "appubot.live-video", qos: .userInteractive)
    /// restarts after a lock or a failure (finding the display can take seconds: never on the frames' queue)
    private let control = DispatchQueue(label: "appubot.live-video.control", qos: .utility)

    private var stream: SCStream?
    private var display: DisplayInfo?
    private var settings = VideoSettings(maxDim: 1280, bitrate: 1_500_000, fps: 30, keyInterval: 10)
    private var session: VTCompressionSession?
    private var sessionSize = (0, 0)
    private var lowLatency = false
    /// the newest picture (encoded again as a keyframe on request, or to settle)
    private var last: CVPixelBuffer?
    private var lastPts = CMTime.zero
    private var wantKey = true
    private var settleTimers: [DispatchWorkItem] = []
    private var touched = Date()
    private var timer: DispatchSourceTimer?
    /// the screen is locked: no capture until it is unlocked
    private var locked = false
    private var failed: Error?
    /// the last trouble the desktop heard of (told once, not every second)
    private var lastError: String?
    /// a stream started again gets a new number: what an older one still had in the encoder is not sent
    private var generation = 0

    // the encoder's thread reads these
    private let outLock = NSLock()
    private var outGeneration = 0
    private var outSeq = 0
    private var outBounds = CGRect.zero

    // MARK: commands

    /// Starts the stream (or, running, takes the new settings). Answers the display's bounds and the picture's size.
    func start(display d: DisplayInfo, settings s: VideoSettings) throws -> [String: Any] {
        life.lock(); defer { life.unlock() }
        let same = queue.sync { () -> Bool in
            touched = Date()
            return (stream != nil || locked) && display?.id == d.id
        }
        if same {
            apply(s)
            return info(started: false)
        }
        stopLocked()
        let gen = queue.sync { () -> Int in
            display = d
            settings = s
            wantKey = true
            failed = nil
            lastError = nil
            generation += 1
            outLock.lock(); outGeneration = generation; outBounds = d.bounds; outLock.unlock()
            return generation
        }
        armTimer()
        DisplayAwake.keep(true, for: "video")
        if DisplayAwake.locked {
            queue.sync { locked = true }
            emitState(["blocked": "locked"])
            return info(started: true)
        }
        DisplayAwake.wake()
        do {
            let st = try makeStream(d, s)
            if !install(st, gen) { st.stopCapture { _ in } }
        } catch {
            stopLocked()
            throw error
        }
        return info(started: true)
    }

    /// New settings (bitrate, size, frame rate) while running; renews the lease either way. Never waits for a start
    /// or a restart (it is the desktop's heartbeat, on the helper's one command queue).
    func config(_ s: VideoSettings?) -> [String: Any] {
        queue.sync { touched = Date() }
        if let s { apply(s) }
        return info(started: false)
    }

    /// The settings now (what `display_video_config` changes from).
    var current: VideoSettings { queue.sync { settings } }

    /// The next frame is a keyframe; on a still screen the newest picture goes again, as one, at once.
    func key() -> Bool {
        queue.sync {
            touched = Date()
            wantKey = true
            guard stream != nil, let pb = last else { return false }
            encode(pb, captured: nil, settle: false)
            return true
        }
    }

    func stop() -> Bool {
        life.lock(); defer { life.unlock() }
        return stopLocked()
    }

    @discardableResult
    private func stopLocked() -> Bool {
        let (s, was) = queue.sync { () -> (SCStream?, Bool) in
            let s = stream
            let was = s != nil || locked
            stream = nil
            locked = false
            last = nil
            settleTimers.forEach { $0.cancel() }
            settleTimers = []
            if let session {
                VTCompressionSessionInvalidate(session)
                self.session = nil
            }
            sessionSize = (0, 0)
            generation += 1
            outLock.lock(); outGeneration = -1; outLock.unlock()
            return (s, was)
        }
        if let s {
            let sem = DispatchSemaphore(value: 0)
            s.stopCapture { _ in sem.signal() }
            _ = sem.wait(timeout: .now() + 2)
        }
        timer?.cancel()
        timer = nil
        DisplayAwake.keep(false, for: "video")
        return was
    }

    private func info(started: Bool) -> [String: Any] {
        queue.sync {
            var o: [String: Any] = [
                "started": started,
                "running": stream != nil,
                "max_dimension": settings.maxDim,
                "bitrate": settings.bitrate,
                "fps": settings.fps,
                "key_interval": settings.keyInterval,
            ]
            if let d = display {
                o["bounds"] = rectDict(d.bounds)
                let (w, h) = pictureSize(d, settings.maxDim)
                o["width"] = w
                o["height"] = h
            }
            if locked { o["blocked"] = "locked" }
            o["cursor"] = pointDict(currentCursor())
            return o
        }
    }

    // MARK: capture

    /// The picture's size for a long edge of `maxDim`: never above the display's own pixels, even (4:2:0).
    private func pictureSize(_ d: DisplayInfo, _ maxDim: Int) -> (Int, Int) {
        var w = Double(d.bounds.width) * d.scale, h = Double(d.bounds.height) * d.scale
        if maxDim > 0, max(w, h) > Double(maxDim) { let k = Double(maxDim) / max(w, h); w *= k; h *= k }
        let even = { (v: Double) in max(2, Int(v.rounded()) & ~1) }
        return (even(w), even(h))
    }

    private func streamConfig(_ d: DisplayInfo, _ s: VideoSettings) -> SCStreamConfiguration {
        let cfg = SCStreamConfiguration()
        let (w, h) = pictureSize(d, s.maxDim)
        cfg.width = w
        cfg.height = h
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, min(60, s.fps))))
        // the encoder may hold a couple while it works, and the newest is kept for keyframes and settling
        cfg.queueDepth = 6
        cfg.showsCursor = false
        // straight into the encoder in its own format: no conversion on the way
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        cfg.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        cfg.colorSpaceName = CGColorSpace.sRGB
        return cfg
    }

    /// A running capture of the display (slow: finding the display may take a few seconds).
    private func makeStream(_ d: DisplayInfo, _ s: VideoSettings) throws -> SCStream {
        // a display that was asleep comes back within a second or two: look again meanwhile
        var found: SCDisplay?
        for attempt in 0..<8 {
            if attempt > 0 { usleep(300_000) }
            found = sckShareableContent()?.displays.first(where: { $0.displayID == d.id })
            if found != nil { break }
        }
        guard let scd = found else { throw HelperError.notFound("no capturable display with id \(d.id) (asleep or locked?)") }
        let filter = SCContentFilter(display: scd, excludingWindows: [])
        let st = SCStream(filter: filter, configuration: streamConfig(d, s), delegate: self)
        try st.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        let sem = DispatchSemaphore(value: 0)
        let box = Box<Error?>(nil)
        st.startCapture { err in box.value = err; sem.signal() }
        if sem.wait(timeout: .now() + 3) == .timedOut { throw HelperError("timeout", "video stream did not start") }
        if let e = box.value { throw HelperError("capture_failed", "video stream: \(e.localizedDescription)") }
        return st
    }

    /// Makes `st` the stream, unless this one was stopped or started afresh meanwhile (then false: the caller stops it).
    private func install(_ st: SCStream, _ gen: Int) -> Bool {
        queue.sync {
            guard gen == generation, stream == nil, display != nil else { return false }
            stream = st
            locked = false
            failed = nil
            lastError = nil
            wantKey = true
            return true
        }
    }

    /// Takes new settings: the bitrate and frame rate at once, a new size with the next frame (a new encoder, a keyframe).
    private func apply(_ s: VideoSettings) {
        let (st, d, sizeChanged, rateChanged) = queue.sync { () -> (SCStream?, DisplayInfo?, Bool, Bool) in
            let old = settings
            settings = s
            if let session, old.bitrate != s.bitrate || old.fps != s.fps { setRate(session) }
            if let session, old.keyInterval != s.keyInterval { setKeyInterval(session) }
            return (stream, display, old.maxDim != s.maxDim, old.fps != s.fps)
        }
        if let st, let d, sizeChanged || rateChanged {
            st.updateConfiguration(streamConfig(d, s)) { err in
                if let err { logErr("video: reconfigure failed: \(err.localizedDescription)") }
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { [weak self] in
            guard let self, stream === self.stream else { return }
            logErr("video: stream stopped: \(error.localizedDescription)")
            self.failed = error
        }
    }

    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        // (on `queue`)
        guard type == .screen, s === stream else { return }
        let info = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
        // idle: nothing changed, nothing to send
        guard info?[.status] as? Int == SCFrameStatus.complete.rawValue, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        last = pb
        // when the display showed it (mach time): how long it took to leave, from there
        encode(pb, captured: (info?[.displayTime] as? NSNumber)?.uint64Value, settle: false)
        // the same picture again in a moment, to sharpen it, unless the screen moves on first
        settleTimers.forEach { $0.cancel() }
        settleTimers = settleAfter.map { delay in
            let item = DispatchWorkItem { [weak self] in
                guard let self, self.stream != nil, let pb = self.last else { return }
                self.encode(pb, captured: nil, settle: true)
            }
            queue.asyncAfter(deadline: .now() + delay, execute: item)
            return item
        }
    }

    // MARK: encoding

    private func setRate(_ s: VTCompressionSession) {
        let st = settings
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: st.bitrate))
        // a burst (a keyframe, a whole new window) may take up to twice the average for a moment, never more
        let limits = [NSNumber(value: st.bitrate / 8 * 2), NSNumber(value: 1.0)] as CFArray
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: st.fps))
    }

    private func setKeyInterval(_ s: VTCompressionSession) {
        let st = settings
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: NSNumber(value: st.keyInterval))
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: max(1, Int(st.keyInterval * Double(st.fps)))))
    }

    private func makeSession(_ w: Int, _ h: Int) -> VTCompressionSession? {
        if let old = session {
            // what it still holds goes out first: no frame of the old size may follow the new size's keyframe
            VTCompressionSessionCompleteFrames(old, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(old)
        }
        session = nil
        var s: VTCompressionSession?
        // low-latency rate control (Apple's for video calls): each frame near its share, no lookahead
        let lowSpec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!] as CFDictionary
        var st = VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
                                            encoderSpecification: lowSpec, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                            outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        lowLatency = st == noErr
        if st != noErr {
            st = VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
                                            encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                            outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        }
        guard st == noErr, let s else {
            logErr("video: no encoder (\(st))")
            return nil
        }
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        if VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel) != noErr {
            VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
        }
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ColorPrimaries, value: kCVImageBufferColorPrimaries_ITU_R_709_2)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_TransferFunction, value: kCVImageBufferTransferFunction_ITU_R_709_2)
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_YCbCrMatrix, value: kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        setRate(s)
        setKeyInterval(s)
        VTCompressionSessionPrepareToEncodeFrames(s)
        session = s
        sessionSize = (w, h)
        return s
    }

    /// (on `queue`) One picture into the encoder. `captured`: when the display showed it (mach time), for the latency.
    private func encode(_ pb: CVPixelBuffer, captured: UInt64?, settle: Bool) {
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        var s = session
        if s == nil || sessionSize != (w, h) {
            s = makeSession(w, h)
            wantKey = true
        }
        guard let s else { return }
        let host = CMClockGetHostTimeClock()
        var pts = CMClockGetTime(host)
        if CMTimeCompare(pts, lastPts) <= 0 { pts = CMTimeAdd(lastPts, CMTime(value: 1, timescale: 1000)) }
        lastPts = pts
        let key = wantKey
        wantKey = false
        let props: CFDictionary? = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary : nil
        let submitted = CMClockGetTime(host)
        let gen = generation
        let low = lowLatency
        let status = VTCompressionSessionEncodeFrame(s, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid,
                                                     frameProperties: props, infoFlagsOut: nil) { [weak self] st, flags, sb in
            self?.emit(st, flags, sb, gen: gen, size: (w, h), captured: captured, submitted: submitted, settle: settle, lowLatency: low)
        }
        if status != noErr {
            logErr("video: encode failed (\(status)); a new encoder next time")
            VTCompressionSessionInvalidate(s)
            session = nil
            wantKey = true
        }
    }

    /// (on the encoder's thread) An encoded frame out as a `video` event.
    private func emit(_ status: OSStatus, _ flags: VTEncodeInfoFlags, _ sb: CMSampleBuffer?, gen: Int, size: (Int, Int), captured: UInt64?, submitted: CMTime, settle: Bool, lowLatency: Bool) {
        guard status == noErr, let sb, !flags.contains(.frameDropped), CMSampleBufferDataIsReady(sb),
              let block = CMSampleBufferGetDataBuffer(sb) else {
            if status != noErr { logErr("video: encoder said \(status)") }
            // a frame the encoder dropped is no one's reference: the next one decodes without it
            return
        }
        let length = CMBlockBufferGetDataLength(block)
        var data = Data(count: length)
        let copied = data.withUnsafeMutableBytes { buf in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: buf.baseAddress!)
        }
        guard copied == kCMBlockBufferNoErr else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
        let key = !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let ms = { (t: CMTime) in Int((CMTimeGetSeconds(CMTimeSubtract(now, t)) * 1000).rounded()) }

        outLock.lock()
        guard gen == outGeneration else { outLock.unlock(); return }
        outSeq += 1
        let seq = outSeq
        let bounds = outBounds
        outLock.unlock()

        var o: [String: Any] = [
            "seq": seq,
            "key": key,
            "data": data.base64EncodedString(),
            "bytes": length,
            "width": size.0,
            "height": size.1,
            "encode_ms": ms(submitted),
            "bounds": rectDict(bounds),
            "cursor": pointDict(currentCursor()),
        ]
        if let captured, captured > 0 { o["latency_ms"] = Int((machMs(mach_absolute_time()) - machMs(captured)).rounded()) }
        if settle { o["settle"] = true }
        if key { o["low_latency"] = lowLatency }
        if key, let fmt = CMSampleBufferGetFormatDescription(sb) {
            let sets = parameterSets(fmt)
            if sets.count >= 2 {
                o["sps"] = sets[0].base64EncodedString()
                o["pps"] = sets[1].base64EncodedString()
            }
        }
        Output.shared.event("video", o)
    }

    /// The H.264 parameter sets (SPS, then PPS) of an encoded frame's format.
    private func parameterSets(_ fmt: CMFormatDescription) -> [Data] {
        var count = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                                 parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                                 nalUnitHeaderLengthOut: nil) == noErr else { return [] }
        var out: [Data] = []
        for i in 0..<count {
            var ptr: UnsafePointer<UInt8>?
            var size = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
                                                                  parameterSetSizeOut: &size, parameterSetCountOut: nil,
                                                                  nalUnitHeaderLengthOut: nil) == noErr, let ptr {
                out.append(Data(bytes: ptr, count: size))
            }
        }
        return out
    }

    // MARK: lock, failure, lease

    private func armTimer() {
        guard timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: control)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    private func emitState(_ fields: [String: Any]) {
        var o = fields
        if o["blocked"] == nil { o["blocked"] = NSNull() }
        Output.shared.event("video_state", o)
    }

    /// (on `control`, every second) The lease, the screen locking and unlocking, a stream that stopped by itself.
    private func tick() {
        life.lock()
        let (idle, wasLocked, st, d, s, broken, active, gen) = queue.sync {
            (Date().timeIntervalSince(touched), locked, stream, display, settings, failed != nil, stream != nil || locked || failed != nil, generation)
        }
        guard active else { life.unlock(); return }
        if idle > leaseSeconds {
            logErr("video: nobody renewed it for \(Int(idle)) s, stopping")
            stopLocked()
            life.unlock()
            emitState(["stopped": true])
            return
        }
        let nowLocked = DisplayAwake.locked
        if nowLocked && !wasLocked {
            // nothing to capture until it is unlocked; only the person at the Mac can
            queue.sync {
                locked = true
                stream = nil
                failed = nil
                last = nil
                settleTimers.forEach { $0.cancel() }
                settleTimers = []
            }
            life.unlock()
            st?.stopCapture { _ in }
            emitState(["blocked": "locked"])
            return
        }
        guard let d, !nowLocked, wasLocked || broken else { life.unlock(); return }
        // unlocked, or the stream stopped by itself (the display slept, its resolution changed): start it again,
        // without holding up a stop or a start meanwhile
        queue.sync { stream = nil }
        life.unlock()
        if broken { st?.stopCapture { _ in } }
        // its resolution may have changed meanwhile
        let fresh = activeDisplays().first(where: { $0.id == d.id }) ?? d
        DisplayAwake.wake()
        do {
            let next = try makeStream(fresh, s)
            life.lock()
            let ok = queue.sync { () -> Bool in
                guard gen == generation else { return false }
                display = fresh
                return true
            } && install(next, gen)
            if ok { outLock.lock(); outBounds = fresh.bounds; outLock.unlock() }
            life.unlock()
            if ok { emitState([:]) } else { next.stopCapture { _ in } }
        } catch {
            logErr("video: could not start again: \(error)")
            let message = (error as? HelperError)?.message ?? String(describing: error)
            // tried again next second while the lease lasts; the desktop hears why, once
            let tell = queue.sync { () -> Bool in
                guard gen == generation else { return false }
                failed = error
                if wasLocked { locked = false }
                defer { lastError = message }
                return lastError != message
            }
            if tell { emitState(["error": message]) }
        }
    }
}

private let machTimebase: mach_timebase_info_data_t = { var t = mach_timebase_info_data_t(); mach_timebase_info(&t); return t }()
private func machMs(_ t: UInt64) -> Double { Double(t) * Double(machTimebase.numer) / Double(machTimebase.denom) / 1_000_000 }

// MARK: - Commands

private func videoSettings(_ p: Params, base: VideoSettings) throws -> VideoSettings {
    var s = base
    if let v = try p.int("max_dimension") { guard v >= 160, v <= 8192 else { throw HelperError.invalid("max_dimension must be 160...8192") }; s.maxDim = v }
    if let v = try p.int("bitrate") { guard v >= 50_000, v <= 100_000_000 else { throw HelperError.invalid("bitrate must be 50000...100000000") }; s.bitrate = v }
    if let v = try p.int("fps") { guard v >= 1, v <= 60 else { throw HelperError.invalid("fps must be 1...60") }; s.fps = v }
    if let v = try p.double("key_interval") { guard v >= 0.5, v <= 600 else { throw HelperError.invalid("key_interval must be 0.5...600") }; s.keyInterval = v }
    return s
}

private let videoDefaults = VideoSettings(maxDim: 1280, bitrate: 1_500_000, fps: 30, keyInterval: 10)

/// display_video_start {display?, max_dimension?, bitrate?, fps?, key_interval?}: the display as H.264 video. Each
/// encoded frame comes as an event {event: "video", seq, key, data (base64 AVCC: NAL units with 4-byte big-endian
/// lengths), sps/pps (base64, with every keyframe), width, height, bounds, cursor, encode_ms, latency_ms?, settle?};
/// what stops it as {event: "video_state", blocked: "locked"|null, error?, stopped?}. Running already, it takes the new
/// settings. Answers {started, running, bounds, width, height, blocked?, low_latency}.
func cmdDisplayVideoStart(_ p: Params) throws -> Any {
    guard #available(macOS 14.0, *) else { throw HelperError("unsupported", "live video needs macOS 14") }
    guard CGPreflightScreenCaptureAccess() else { throw HelperError("permission_denied", "Screen Recording permission is not granted") }
    let displays = activeDisplays()
    guard !displays.isEmpty else { throw HelperError.notFound("no display") }
    let display = try resolveDisplay(try p.int("display") ?? 0, displays)
    return try LiveVideo.shared.start(display: display, settings: try videoSettings(p, base: videoDefaults))
}

/// display_video_config {max_dimension?, bitrate?, fps?, key_interval?}: new settings, at once; renews the lease (the
/// stream stops by itself 30 s after the last start, config or key).
func cmdDisplayVideoConfig(_ p: Params) throws -> Any {
    guard #available(macOS 14.0, *) else { throw HelperError("unsupported", "live video needs macOS 14") }
    let any = p.has("max_dimension") || p.has("bitrate") || p.has("fps") || p.has("key_interval")
    return LiveVideo.shared.config(any ? try videoSettings(p, base: LiveVideo.shared.current) : nil)
}

/// display_video_key: the next frame is a keyframe (on a still screen, the newest picture goes again as one at once).
func cmdDisplayVideoKey(_ p: Params) throws -> Any {
    guard #available(macOS 14.0, *) else { throw HelperError("unsupported", "live video needs macOS 14") }
    return ["sent": LiveVideo.shared.key()]
}

func cmdDisplayVideoStop(_ p: Params) throws -> Any {
    guard #available(macOS 14.0, *) else { return ["stopped": false] }
    return ["stopped": LiveVideo.shared.stop()]
}
