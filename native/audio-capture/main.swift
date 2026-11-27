import AVFoundation
import AudioToolbox
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

enum CaptureError: LocalizedError {
    case usage
    case noDisplay
    case noAudio
    case microphoneUnavailable
    case microphoneDenied

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: audio-capture <file.wav>\n       audio-capture --rotate <dir>"
        case .noDisplay:
            return "No display found to capture audio from."
        case .noAudio:
            return "No audio reached the capture. Check the selected source and its macOS permission."
        case .microphoneUnavailable:
            return "Microphone capture in Meeting Copilot requires macOS 15 or later."
        case .microphoneDenied:
            return "Microphone access is unavailable. Allow Meeting Copilot in Privacy & Security → Microphone."

        }
    }
}

func writeStdout(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
    fflush(stdout)
}

final class StopGate: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        await withCheckedContinuation { cont in
            lock.lock()
            if stopped {
                lock.unlock()
                cont.resume()
            } else {
                continuation = cont
                lock.unlock()
            }
        }
    }

    func signal() {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        stopped = true
        continuation?.resume()
        continuation = nil
    }
}

enum AudioSource: String {
    case system, microphone, both

    static var configured: AudioSource {
        AudioSource(rawValue: ProcessInfo.processInfo.environment["AUDIO_SOURCE"] ?? "") ?? .system
    }
}

final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var fileHandle: FileHandle?
    private var currentURL: URL?
    private var dataSize: UInt32 = 0
    private let lock = NSLock()
    private let sampleRate: Int = 48_000
    private let channels: Int = 2
    private let source: AudioSource
    private let onStreamError: () -> Void
    private let monitorActivity = ProcessInfo.processInfo.environment["AUTO_ANSWER"] == "on"
    private var lastActivity = -Double.infinity
    private var mixStart: Double = 0
    private var mixedSamples: [Int32] = []
    private var rotating = false

    init(source: AudioSource, onStreamError: @escaping () -> Void) {
        self.source = source
        self.onStreamError = onStreamError
    }

    func startCapture() async throws {
        if source != .system {
            guard #available(macOS 15, *) else { throw CaptureError.microphoneUnavailable }
            let status = AVCaptureDevice.authorizationStatus(for: .audio)
            if status == .notDetermined {
                guard await AVCaptureDevice.requestAccess(for: .audio) else { throw CaptureError.microphoneDenied }
            } else if status != .authorized {
                throw CaptureError.microphoneDenied
            }
        }
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
            throw CaptureError.noDisplay
        }

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = source != .microphone
        if #available(macOS 15, *) { config.captureMicrophone = source != .system }
        config.excludesCurrentProcessAudio = true
        config.sampleRate = sampleRate
        config.channelCount = channels
        config.width = 128
        config.height = 128
        config.minimumFrameInterval = CMTime(value: 1, timescale: 5)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.queueDepth = 8

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        let videoQueue = DispatchQueue(label: "meeting.copilot.video")
        let audioQueue = DispatchQueue(label: "meeting.copilot.audio")
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        if source != .microphone {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        }
        if #available(macOS 15, *), source != .system {
            try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: audioQueue)
        }
        try await stream.startCapture()
        self.stream = stream
    }

    func beginFile(_ url: URL, rotating: Bool = false) throws {
        lock.lock()
        defer { lock.unlock() }
        _ = FileManager.default.createFile(
            atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]
        )
        let handle = try FileHandle(forWritingTo: url)
        fileHandle = handle
        currentURL = url
        dataSize = 0
        self.rotating = rotating
        mixStart = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        mixedSamples.removeAll(keepingCapacity: true)
        handle.write(Self.wavHeader(dataSize: 0, sampleRate: sampleRate, channels: channels))
    }

    func endFile() -> (url: URL, bytes: UInt32)? {
        lock.lock()
        defer { lock.unlock() }
        guard let url = currentURL, let handle = fileHandle else { return nil }
        if !mixedSamples.isEmpty {
            let samples = mixedSamples.map { Int16(clamping: $0) }
            let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
            handle.write(data)
            dataSize = UInt32(data.count)
        }
        let bytes = dataSize
        do {
            try handle.seek(toOffset: 0)
            handle.write(Self.wavHeader(dataSize: bytes, sampleRate: sampleRate, channels: channels))
        } catch {
            fputs("wav header: \(error.localizedDescription)\n", stderr)
        }
        try? handle.close()
        fileHandle = nil
        currentURL = nil
        dataSize = 0
        return (url, bytes)
    }

    func stopCapture() async {
        try? await stream?.stopCapture()
        stream = nil
        try? await Task.sleep(nanoseconds: 200_000_000)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid else { return }
        let microphone: Bool
        if #available(macOS 15, *), type == .microphone {
            microphone = true
        } else if type == .audio {
            microphone = false
        } else {
            return
        }
        guard let pcm = Self.int16PCM(from: sampleBuffer), !pcm.isEmpty else { return }
        let format = sampleBuffer.formatDescription?.audioStreamBasicDescription
        let inputChannels = Int(format?.mChannelsPerFrame ?? UInt32(channels))
        let inputRate = format?.mSampleRate ?? Double(sampleRate)

        lock.lock()
        defer { lock.unlock() }
        guard let fileHandle else { return }
        if monitorActivity && rotating && source == .system {
            let now = ProcessInfo.processInfo.systemUptime
            if now - lastActivity >= 0.15 {
                let audible = pcm.withUnsafeBytes { raw -> Bool in
                    let samples = raw.bindMemory(to: Int16.self)
                    var energy = 0.0
                    for index in stride(from: 0, to: samples.count, by: 8) {
                        let amplitude = Double(samples[index])
                        energy += amplitude * amplitude
                    }
                    return energy > 180 * 180 * Double((samples.count + 7) / 8)
                }
                if audible {
                    lastActivity = now
                    writeStdout("ACTIVITY")
                }
            }
        }
        if source == .both && rotating {
            mix(pcm, sampleBuffer: sampleBuffer, inputChannels: inputChannels, inputRate: inputRate)
        } else {
            let output = microphone ? converted(pcm, inputChannels: inputChannels, inputRate: inputRate) : pcm
            fileHandle.write(output)
            dataSize &+= UInt32(output.count)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("capture error: \(error.localizedDescription)\n", stderr)
        onStreamError()
    }

    private func converted(_ pcm: Data, inputChannels: Int, inputRate: Double) -> Data {
        guard inputChannels > 0, inputRate.isFinite, inputRate > 0 else { return Data() }
        if inputChannels == channels && inputRate == Double(sampleRate) { return pcm }
        return pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            let inputFrames = samples.count / inputChannels
            guard inputFrames > 0 else { return Data() }
            let ratio = inputRate / Double(sampleRate)
            let count = Int((Double(inputFrames) / ratio).rounded())
            var stereo = [Int16]()
            stereo.reserveCapacity(count * channels)
            for frame in 0..<count {
                let offset = min(inputFrames - 1, Int(Double(frame) * ratio)) * inputChannels
                stereo.append(samples[offset])
                stereo.append(samples[offset + min(1, inputChannels - 1)])
            }
            return stereo.withUnsafeBufferPointer { Data(buffer: $0) }
        }
    }

    private func mix(_ pcm: Data, sampleBuffer: CMSampleBuffer, inputChannels: Int, inputRate: Double) {
        let data = converted(pcm, inputChannels: inputChannels, inputRate: inputRate)
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        let presentation = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        let duration = Double(data.count / (channels * MemoryLayout<Int16>.size)) / Double(sampleRate)
        let timestamp = presentation.isFinite && abs(presentation - now) < 2 ? presentation : now - duration
        let firstSample = Int(((timestamp - mixStart) * Double(sampleRate)).rounded()) * channels
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            let end = min(sampleRate * channels * 32, firstSample + samples.count)
            let start = max(0, firstSample)
            guard start < end else { return }
            if end > mixedSamples.count {
                mixedSamples.append(contentsOf: repeatElement(0, count: end - mixedSamples.count))
            }
            for index in start..<end {
                mixedSamples[index] += Int32(samples[index - firstSample]) / 2
            }
        }
    }

    private static func wavHeader(dataSize: UInt32, sampleRate: Int, channels: Int) -> Data {
        let ch = UInt16(channels)
        let bits: UInt16 = 16
        let rate = UInt32(sampleRate)
        let byteRate = rate * UInt32(ch) * UInt32(bits / 8)
        let blockAlign = ch * bits / 8
        var data = Data()
        func ascii(_ s: String) { data.append(contentsOf: s.utf8) }
        func u32(_ v: UInt32) {
            var le = v.littleEndian
            data.append(Data(bytes: &le, count: 4))
        }
        func u16(_ v: UInt16) {
            var le = v.littleEndian
            data.append(Data(bytes: &le, count: 2))
        }
        ascii("RIFF")
        u32(36 + dataSize)
        ascii("WAVE")
        ascii("fmt ")
        u32(16)
        u16(1)
        u16(ch)
        u32(rate)
        u32(byteRate)
        u16(blockAlign)
        u16(bits)
        ascii("data")
        u32(dataSize)
        return data
    }

    private static func int16PCM(from sampleBuffer: CMSampleBuffer) -> Data? {
        let asbd = sampleBuffer.formatDescription?.audioStreamBasicDescription
        do {
            return try sampleBuffer.withAudioBufferList { list, _ in
                pcmData(from: list, asbd: asbd)
            }
        } catch {
            return pcmDataFallback(from: sampleBuffer, asbd: asbd)
        }
    }

    private static func pcmDataFallback(from sampleBuffer: CMSampleBuffer, asbd: AudioStreamBasicDescription?) -> Data? {
        let maxBuffers = 8
        let listByteSize = AudioBufferList.sizeInBytes(maximumBuffers: maxBuffers)
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: listByteSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { raw.deallocate() }
        let listPtr = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        listPtr.initialize(to: AudioBufferList())

        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: listPtr,
            bufferListSize: listByteSize,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return nil }
        return pcmData(from: UnsafeMutableAudioBufferListPointer(listPtr), asbd: asbd)
    }

    private static func pcmData(from list: UnsafeMutableAudioBufferListPointer, asbd: AudioStreamBasicDescription?) -> Data {
        let flags = asbd?.mFormatFlags ?? 0
        let isFloat = flags & kAudioFormatFlagIsFloat != 0
        if list.count >= 2 {
            let left = int16Samples(list[0], isFloat: isFloat)
            let right = int16Samples(list[1], isFloat: isFloat)
            let frames = min(left.count, right.count)
            var interleaved = [Int16]()
            interleaved.reserveCapacity(frames * 2)
            for i in 0..<frames {
                interleaved.append(left[i])
                interleaved.append(right[i])
            }
            return interleaved.withUnsafeBufferPointer { Data(buffer: $0) }
        }
        guard let first = list.first else { return Data() }
        return int16Samples(first, isFloat: isFloat).withUnsafeBufferPointer { Data(buffer: $0) }
    }

    private static func int16Samples(_ buffer: AudioBuffer, isFloat: Bool) -> [Int16] {
        guard let data = buffer.mData, buffer.mDataByteSize > 0 else { return [] }
        if isFloat {
            let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            let floats = data.bindMemory(to: Float.self, capacity: count)
            var out = [Int16](repeating: 0, count: count)
            for i in 0..<count {
                let clipped = max(-1.0, min(1.0, floats[i]))
                out[i] = Int16((clipped * 32767.0).rounded())
            }
            return out
        }
        let count = Int(buffer.mDataByteSize) / MemoryLayout<Int16>.size
        let samples = data.bindMemory(to: Int16.self, capacity: count)
        return Array(UnsafeBufferPointer(start: samples, count: count))
    }
}

final class RotateWriter: @unchecked Sendable {
    private let session: CaptureSession
    private let dir: URL
    private let queue = DispatchQueue(label: "meeting.copilot.rotate")
    private var index = 0
    private var timer: DispatchSourceTimer?
    private var totalBytes: UInt32 = 0
    private let interval: TimeInterval

    init(session: CaptureSession, dir: URL, interval: TimeInterval) {
        self.session = session
        self.dir = dir
        self.interval = interval
    }

    func openFirst() throws {
        try queue.sync {
            try openNewLocked()
            scheduleTimerLocked()
        }
    }

    func flush() {
        queue.sync {
            rotateLocked(emitted: "FLUSHED")
            scheduleTimerLocked()
        }
    }

    func closeLast() -> UInt32 {
        queue.sync {
            timer?.cancel()
            timer = nil
            if let ended = session.endFile() {
                totalBytes &+= ended.bytes
                writeStdout("CHUNK \(ended.url.path)")
            }
            return totalBytes
        }
    }

    private func rotateLocked(emitted: String) {
        if let ended = session.endFile() {
            totalBytes &+= ended.bytes
            writeStdout("\(emitted) \(ended.url.path)")
        }
        try? openNewLocked()
    }

    private func openNewLocked() throws {
        index += 1
        let name = String(format: "%04d.wav", index)
        let url = dir.appendingPathComponent(name)
        try session.beginFile(url, rotating: true)
    }

    private func scheduleTimerLocked() {
        timer?.cancel()
        let next = DispatchSource.makeTimerSource(queue: queue)
        next.schedule(deadline: .now() + interval)
        next.setEventHandler { [weak self] in
            guard let self else { return }
            self.rotateLocked(emitted: "CHUNK")
            self.scheduleTimerLocked()
        }
        next.resume()
        timer = next
    }
}

func installStopSignals(_ gate: StopGate) -> (DispatchSourceSignal, DispatchSourceSignal) {
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    sigint.setEventHandler { gate.signal() }
    sigterm.setEventHandler { gate.signal() }
    sigint.resume()
    sigterm.resume()
    return (sigint, sigterm)
}

func readStdin(flush: (() -> Void)?, stop: @escaping () -> Void) {
    DispatchQueue.global().async {
        while let line = readLine() {
            switch line.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() {
            case "STOP":
                stop()
                return
            case "FLUSH":
                flush?()
            default:
                break
            }
        }
        stop()
    }
}

@main
struct AudioCaptureApp {
    static func main() async {
        let args = CommandLine.arguments
        if (3...4).contains(args.count), args[1] == "--rotate" {
            let requestedInterval = args.count == 4 ? Double(args[3]) ?? 15 : 15
            let interval = requestedInterval.isFinite ? min(30, max(3, requestedInterval)) : 15
            await runRotate(dir: URL(fileURLWithPath: args[2]), interval: interval)
            return
        }
        guard args.count == 2, args[1] != "--rotate" else {
            fputs("\(CaptureError.usage.localizedDescription)\n", stderr)
            exit(1)
        }
        await runSingle(url: URL(fileURLWithPath: args[1]))
    }

    static func runSingle(url: URL) async {
        let gate = StopGate()
        let source = AudioSource.configured
        let session = CaptureSession(source: source == .both ? .system : source, onStreamError: { gate.signal() })
        let signals = installStopSignals(gate)
        _ = signals
        readStdin(flush: nil, stop: { gate.signal() })

        do {
            try await session.startCapture()
            try session.beginFile(url)
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            exit(2)
        }

        writeStdout("RECORDING")
        await gate.wait()
        await session.stopCapture()
        let ended = session.endFile()
        if (ended?.bytes ?? 0) == 0 {
            fputs("\(CaptureError.noAudio.localizedDescription)\n", stderr)
            exit(3)
        }
        writeStdout("DONE")
        exit(0)
    }

    static func runRotate(dir: URL, interval: TimeInterval) async {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            exit(2)
        }

        let gate = StopGate()
        let session = CaptureSession(source: AudioSource.configured, onStreamError: { gate.signal() })
        let rotator = RotateWriter(session: session, dir: dir, interval: interval)
        let signals = installStopSignals(gate)
        _ = signals
        readStdin(flush: { rotator.flush() }, stop: { gate.signal() })

        do {
            try await session.startCapture()
            try rotator.openFirst()
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            exit(2)
        }

        writeStdout("RECORDING")
        await gate.wait()
        await session.stopCapture()
        let total = rotator.closeLast()
        if total == 0 {
            fputs("\(CaptureError.noAudio.localizedDescription)\n", stderr)
            exit(3)
        }
        writeStdout("DONE")
        exit(0)
    }
}
