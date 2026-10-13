import Foundation
import CoreGraphics
import ScreenCaptureKit
import CoreMedia
import CoreImage

final class FrameOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let continuation: AsyncStream<CGImage>.Continuation
    let context = CIContext()
    init(_ continuation: AsyncStream<CGImage>.Continuation) { self.continuation = continuation }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let image = CIImage(cvPixelBuffer: buffer)
        if let cgImage = context.createCGImage(image, from: image.extent) { continuation.yield(cgImage) }
    }
}

// Local diagnostic only: samples test colors, never saves screen images.
@main
struct ScreenProtectionCheck {
    static func emit(_ image: CGImage) throws {
        let pixelsWide = image.width, pixelsHigh = image.height
        var bytes = [UInt8](repeating: 0, count: pixelsWide * pixelsHigh * 4)
        let counts: (Int, Int) = try bytes.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: pixelsWide, height: pixelsHigh, bitsPerComponent: 8, bytesPerRow: pixelsWide * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
                throw NSError(domain: "CaptureCheck", code: 4)
            }
            context.draw(image, in: CGRect(x: 0, y: 0, width: pixelsWide, height: pixelsHigh))
            var red = 0, gray = 0
            for index in stride(from: 0, to: buffer.count, by: 4) {
                let r = Int(buffer[index]), g = Int(buffer[index + 1]), b = Int(buffer[index + 2])
                if r > 180 && g < 70 && b < 70 { red += 1 }
                if r > 10 && r < 100 && abs(r - g) < 10 && abs(r - b) < 10 { gray += 1 }
            }
            return (red, gray)
        }
        let result: [String: Double] = ["redRatio": Double(counts.0) / Double(pixelsWide * pixelsHigh), "grayRatio": Double(counts.1) / Double(pixelsWide * pixelsHigh)]
        let encoded = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(encoded)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    static func main() async {
        do {
            guard CommandLine.arguments.count == 5 || CommandLine.arguments.count == 6,
                  let x = Double(CommandLine.arguments[1]),
                  let y = Double(CommandLine.arguments[2]),
                  let width = Double(CommandLine.arguments[3]),
                  let height = Double(CommandLine.arguments[4]), width > 0, height > 0 else {
                throw NSError(domain: "CaptureCheck", code: 1, userInfo: [NSLocalizedDescriptionKey: "Usage: capture-check x y width height"])
            }
            guard CGPreflightScreenCaptureAccess() else {
                throw NSError(domain: "CaptureCheck", code: 2, userInfo: [NSLocalizedDescriptionKey: "Screen recording access is not available for this diagnostic process. No capture was made."])
            }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
                throw NSError(domain: "CaptureCheck", code: 3, userInfo: [NSLocalizedDescriptionKey: "Main display not found."])
            }
            // No excluded windows or applications: model a full-display share.
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = 100
            config.height = 80
            config.sourceRect = CGRect(x: x, y: y, width: width, height: height)
            config.showsCursor = false
            let image: CGImage
            if CommandLine.arguments.last == "--stream" || CommandLine.arguments.last == "--watch" {
                let frames = AsyncStream<CGImage>.makeStream(bufferingPolicy: .bufferingNewest(1))
                let output = FrameOutput(frames.continuation)
                let stream = SCStream(filter: filter, configuration: config, delegate: nil)
                try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture-check.frames"))
                try await stream.startCapture()
                if CommandLine.arguments.last == "--watch" {
                    for await frame in frames.stream { try emit(frame) }
                    try await stream.stopCapture()
                    return
                }
                var iterator = frames.stream.makeAsyncIterator()
                guard let frame = await iterator.next() else { throw NSError(domain: "CaptureCheck", code: 5) }
                image = frame
                try await stream.stopCapture()
                frames.continuation.finish()
            } else {
                image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            }
            try emit(image)
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
}
