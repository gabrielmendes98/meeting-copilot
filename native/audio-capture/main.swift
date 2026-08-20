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
            return "Usage: audio-capture <file.wav>"
        case .noDisplay:
            return "No display found to capture audio from."
        case .noAudio:
            return "No system audio reached the capture. Allow Screen Recording, keep the video/call playing, and use the main display."
        }
    }
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
    private let outputURL: URL
    private var stream: SCStream?
    private var fileHandle: FileHandle?
    private var dataSize: UInt32 = 0
    private let lock = NSLock()
    private let sampleRate: Int = 48_000
    private let channels: Int = 2

    init(outputURL: URL) {
        self.outputURL = outputURL
        super.init()
    }

    var capturedBytes: UInt32 {
        snapshotSize()
    }

    func start() async throws {
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

        FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        let handle = try FileHandle(forWritingTo: outputURL)
        fileHandle = handle
        handle.write(Self.wavHeader(dataSize: 0, sampleRate: sampleRate, channels: channels))

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        let videoQueue = DispatchQueue(label: "meeting.copilot.video")
        let audioQueue = DispatchQueue(label: "meeting.copilot.audio")
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async {
        try? await stream?.stopCapture()
        stream = nil
        try? await Task.sleep(nanoseconds: 200_000_000)
        let size = snapshotSize()
        rewriteHeader(dataSize: size)
        try? fileHandle?.close()
        fileHandle = nil
    }

    private func snapshotSize() -> UInt32 {
        lock.lock()
        defer { lock.unlock() }
        return dataSize
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

    private func rewriteHeader(dataSize: UInt32) {
        guard let handle = fileHandle else { return }
        do {
            try handle.seek(toOffset: 0)
            handle.write(Self.wavHeader(dataSize: dataSize, sampleRate: sampleRate, channels: channels))
            try handle.seekToEnd()
        } catch {
            fputs("wav header: \(error.localizedDescription)\n", stderr)
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

@main
struct AudioCaptureApp {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count == 2 else {
            fputs("Usage: audio-capture <file.wav>\n", stderr)
            exit(1)
        }

        let url = URL(fileURLWithPath: args[1])
        let session = CaptureSession(outputURL: url)
        let gate = StopGate()

        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        sigint.setEventHandler { gate.signal() }
        sigterm.setEventHandler { gate.signal() }
        sigint.resume()
        sigterm.resume()

        DispatchQueue.global().async {
            while let line = readLine() {
                if line.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == "STOP" {
                    gate.signal()
                    break
                }
            }
        }

        do {
            try await session.start()
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            exit(2)
        }

        FileHandle.standardOutput.write(Data("RECORDING\n".utf8))

        await gate.wait()
        await session.stop()
        if session.capturedBytes == 0 {
            fputs("\(CaptureError.noAudio.localizedDescription)\n", stderr)
            exit(3)
        }
        FileHandle.standardOutput.write(Data("DONE\n".utf8))
        exit(0)
    }
}
