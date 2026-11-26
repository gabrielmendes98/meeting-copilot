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
            let args = Array(CommandLine.arguments.dropFirst())
            if args == ["--request-access"] {
                guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
                    throw NSError(domain: "CaptureCheck", code: 2, userInfo: [NSLocalizedDescriptionKey:
                        "Allow screen recording for the app named by macOS in System Settings → Privacy & Security → Screen & System Audio Recording, then rerun the diagnostic."])
                }
                return
            }
            let windowMode = args.first == "--window"
            let rect: CGRect?
            if windowMode, args.count == 3, Int32(args[1]) != nil {
                rect = nil
            } else if (args.count == 4 || args.count == 5),
                      let x = Double(args[0]), let y = Double(args[1]),
                      let width = Double(args[2]), let height = Double(args[3]),
                      [x, y, width, height].allSatisfy({ $0.isFinite }), width > 0, height > 0,
                      args.count == 4 || ["--stream", "--watch"].contains(args[4]) {
                rect = CGRect(x: x, y: y, width: width, height: height)
            } else {
                throw NSError(domain: "CaptureCheck", code: 1, userInfo: [NSLocalizedDescriptionKey:
                    "Usage: capture-check x y width height [--stream|--watch] or capture-check --window owner-pid title"])
            }
            guard CGPreflightScreenCaptureAccess() else {
                throw NSError(domain: "CaptureCheck", code: 2, userInfo: [NSLocalizedDescriptionKey: "Screen recording access is not available for this diagnostic process. No capture was made."])
            }
            // Initialize the display connection before creating either filter. The
            // single-window filter also queries displays behind the scenes.
            var mainDisplay: CGDirectDisplayID = 0
            var displayCount: UInt32 = 0
            guard CGGetActiveDisplayList(1, &mainDisplay, &displayCount) == .success, displayCount > 0 else {
                throw NSError(domain: "CaptureCheck", code: 3, userInfo: [NSLocalizedDescriptionKey: "No active display found."])
            }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let config = SCStreamConfiguration()
            config.showsCursor = false
            let filter: SCContentFilter
            if let rect {
                guard let display = content.displays.first(where: { $0.displayID == mainDisplay }) else {
                    throw NSError(domain: "CaptureCheck", code: 3, userInfo: [NSLocalizedDescriptionKey: "Main display not found."])
                }
                filter = SCContentFilter(display: display, excludingWindows: [])
                config.width = 100
                config.height = 80
                config.sourceRect = rect
            } else {
                guard let target = content.windows.first(where: {
                    $0.owningApplication?.processID == Int32(args[1]) && $0.title == args[2]
                }) else {
                    throw NSError(domain: "CaptureCheck", code: 6, userInfo: [NSLocalizedDescriptionKey: "Synthetic share window could not be located."])
                }
                filter = SCContentFilter(desktopIndependentWindow: target)
                config.width = 320
                config.height = 180
            }
            let image: CGImage
            if !windowMode && (args.last == "--stream" || args.last == "--watch") {
                let frames = AsyncStream<CGImage>.makeStream(bufferingPolicy: .bufferingNewest(1))
                let output = FrameOutput(frames.continuation)
                let stream = SCStream(filter: filter, configuration: config, delegate: nil)
                try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture-check.frames"))
                try await stream.startCapture()
                if args.last == "--watch" {
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
