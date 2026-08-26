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

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: audio-capture <file.wav>\n       audio-capture --rotate <dir>"
        case .noDisplay:
            return "No display found to capture audio from."
        case .noAudio:
            return "No system audio reached the capture. Allow Screen Recording, keep the video/call playing, and use the main display."
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

final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var fileHandle: FileHandle?
    private var currentURL: URL?
    private var dataSize: UInt32 = 0
    private let lock = NSLock()
    private let sampleRate: Int = 48_000
    private let channels: Int = 2

    func startCapture() async throws {
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
        config.capturesAudio = true
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
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    func beginFile(_ url: URL) throws {
        lock.lock()
        defer { lock.unlock() }
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        fileHandle = handle
        currentURL = url
        dataSize = 0
        handle.write(Self.wavHeader(dataSize: 0, sampleRate: sampleRate, channels: channels))
    }

    func endFile() -> (url: URL, bytes: UInt32)? {
        lock.lock()
        defer { lock.unlock() }
        guard let url = currentURL, let handle = fileHandle else { return nil }
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
        if type == .screen { return }
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let pcm = Self.int16PCM(from: sampleBuffer), !pcm.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        fileHandle?.write(pcm)
        dataSize &+= UInt32(pcm.count)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("capture error: \(error.localizedDescription)\n", stderr)
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
    private let interval: TimeInterval = 15

    init(session: CaptureSession, dir: URL) {
        self.session = session
        self.dir = dir
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
        try session.beginFile(url)
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
        if args.count == 3, args[1] == "--rotate" {
            await runRotate(dir: URL(fileURLWithPath: args[2]))
            return
        }
        guard args.count == 2, args[1] != "--rotate" else {
            fputs("\(CaptureError.usage.localizedDescription)\n", stderr)
            exit(1)
        }
        await runSingle(url: URL(fileURLWithPath: args[1]))
    }

    static func runSingle(url: URL) async {
        let session = CaptureSession()
        let gate = StopGate()
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

    static func runRotate(dir: URL) async {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            exit(2)
        }

        let session = CaptureSession()
        let rotator = RotateWriter(session: session, dir: dir)
        let gate = StopGate()
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
