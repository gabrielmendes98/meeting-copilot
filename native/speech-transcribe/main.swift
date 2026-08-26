import AppKit
import AVFoundation
import Foundation
import Speech

enum TranscribeError: LocalizedError {
    case usage
    case denied
    case unavailable
    case empty
    case assets
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: SpeechTranscribe --watch | <file.wav> [output.json]"
        case .denied:
            return "Speech Recognition was denied. In System Settings, allow Meeting Copilot Speech."
        case .unavailable:
            return "SpeechAnalyzer English transcription is unavailable on this Mac. macOS 26+ is required."
        case .empty:
            return "Transcription came back empty."
        case .assets:
            return "Could not download the on-device English speech model. Check the network and try again."
        case .failed(let message):
            return message
        }
    }
}

func requestAuth() async -> SFSpeechRecognizerAuthorizationStatus {
    await withCheckedContinuation { cont in
        SFSpeechRecognizer.requestAuthorization { status in
            cont.resume(returning: status)
        }
    }
}

func mappedSpeechError(_ error: Error) -> Error {
    let text = error.localizedDescription.lowercased()
    if text.contains("no speech") || text.contains("nenhuma fala") || text.contains("não foi detectada") {
        return TranscribeError.failed(
            "SpeechAnalyzer found no speech in this clip. Record spoken audio or set STT_PROVIDER=groq / openai."
        )
    }
    return error
}

@available(macOS 26, *)
func transcribeWithAnalyzer(wav: URL, allowEmpty: Bool = false) async throws -> String {
    guard SpeechTranscriber.isAvailable else { throw TranscribeError.unavailable }

    let requested = Locale(identifier: "en-US")
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
        throw TranscribeError.unavailable
    }

    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    } catch {
        throw TranscribeError.assets
    }

    let audioFile = try AVAudioFile(forReading: wav)
    let analyzer = SpeechAnalyzer(modules: [transcriber])

    let resultsTask = Task { () -> String in
        var segments: [String] = []
        for try await result in transcriber.results {
            let piece = String(result.text.characters)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !piece.isEmpty else { continue }
            if result.isFinal {
                segments.append(piece)
            }
        }
        return segments.joined(separator: " ")
    }

    do {
        if let last = try await analyzer.analyzeSequence(from: audioFile) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        }
    } catch {
        await analyzer.cancelAndFinishNow()
        resultsTask.cancel()
        throw mappedSpeechError(error)
    }

    let text = try await resultsTask.value
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty {
        if allowEmpty { return "" }
        throw TranscribeError.empty
    }
    return text
}

@available(macOS 26, *)
func prepareSpeechAssets() async throws {
    guard SpeechTranscriber.isAvailable else { throw TranscribeError.unavailable }
    let requested = Locale(identifier: "en-US")
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
        throw TranscribeError.unavailable
    }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    } catch {
        throw TranscribeError.assets
    }
}

func transcribe(wav: URL) async throws -> String {
    let status = await requestAuth()
    guard status == .authorized else { throw TranscribeError.denied }

    if #available(macOS 26, *) {
        return try await transcribeWithAnalyzer(wav: wav)
    }
    throw TranscribeError.unavailable
}

func writeStdout(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
    fflush(stdout)
}

func writeJsonLine(ok: Bool, text: String, error: String) {
    let payload: [String: Any] = ["ok": ok, "text": text, "error": error]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    fflush(stdout)
}

func isSoftSpeechFailure(_ error: Error) -> Bool {
    if let typed = error as? TranscribeError {
        switch typed {
        case .empty:
            return true
        case .failed(let message):
            let text = message.lowercased()
            return text.contains("no speech") || text.contains("nenhuma fala")
        default:
            return false
        }
    }
    let text = error.localizedDescription.lowercased()
    return text.contains("no speech") || text.contains("nenhuma fala") || text.contains("não foi detectada")
}

func stdinLines() -> AsyncStream<String> {
    AsyncStream { continuation in
        DispatchQueue.global().async {
            while let line = readLine() {
                continuation.yield(line)
            }
            continuation.finish()
        }
    }
}

func writeResult(ok: Bool, text: String?, error: String?, to file: URL?) {
    let payload: [String: Any] = [
        "ok": ok,
        "text": text ?? "",
        "error": error ?? "",
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    if let file {
        try? data.write(to: file)
    }
    if ok, let text {
        FileHandle.standardOutput.write(Data((text + "\n").utf8))
    } else if let error {
        FileHandle.standardError.write(Data((error + "\n").utf8))
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let wav: URL
    let outFile: URL?

    init(wav: URL, outFile: URL?) {
        self.wav = wav
        self.outFile = outFile
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        Task { @MainActor in
            do {
                let text = try await transcribe(wav: wav)
                writeResult(ok: true, text: text, error: nil, to: outFile)
                NSApp.terminate(nil)
            } catch {
                writeResult(ok: false, text: nil, error: error.localizedDescription, to: outFile)
                NSApp.terminate(nil)
            }
        }
    }
}

final class WatchDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in
            let status = await requestAuth()
            guard status == .authorized else {
                writeJsonLine(ok: false, text: "", error: TranscribeError.denied.localizedDescription)
                NSApp.terminate(nil)
                return
            }

            if #available(macOS 26, *) {
                do {
                    try await prepareSpeechAssets()
                } catch {
                    writeJsonLine(ok: false, text: "", error: error.localizedDescription)
                    NSApp.terminate(nil)
                    return
                }
                writeStdout("READY")
                for await line in stdinLines() {
                    let path = line.trimmingCharacters(in: .whitespacesAndNewlines)
                    if path.isEmpty { continue }
                    if path.uppercased() == "STOP" { break }
                    await transcribeWatchChunk(wav: URL(fileURLWithPath: path))
                }
                NSApp.terminate(nil)
                return
            }

            writeJsonLine(ok: false, text: "", error: TranscribeError.unavailable.localizedDescription)
            NSApp.terminate(nil)
        }
    }
}

@available(macOS 26, *)
func transcribeWatchChunk(wav: URL) async {
    do {
        let text = try await transcribeWithAnalyzer(wav: wav, allowEmpty: true)
        writeJsonLine(ok: true, text: text, error: "")
    } catch {
        let mapped = mappedSpeechError(error)
        if isSoftSpeechFailure(mapped) {
            writeJsonLine(ok: true, text: "", error: "")
            return
        }
        if let typed = mapped as? TranscribeError {
            switch typed {
            case .denied, .unavailable, .assets:
                writeJsonLine(ok: false, text: "", error: typed.localizedDescription)
                await NSApp.terminate(nil)
                return
            default:
                break
            }
        }
        writeJsonLine(ok: true, text: "", error: "")
    }
}

@main
struct SpeechTranscribeMain {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            fputs("Usage: SpeechTranscribe --watch | <file.wav> [output.json]\n", stderr)
            exit(1)
        }

        let app = NSApplication.shared

        if args[1] == "--watch" {
            app.setActivationPolicy(.accessory)
            let delegate = WatchDelegate()
            app.delegate = delegate
            app.run()
            exit(0)
        }

        let wav = URL(fileURLWithPath: args[1])
        let outFile = args.count >= 3 ? URL(fileURLWithPath: args[2]) : nil

        app.setActivationPolicy(.regular)
        let delegate = AppDelegate(wav: wav, outFile: outFile)
        app.delegate = delegate
        app.run()

        if let outFile,
           let data = try? Data(contentsOf: outFile),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let ok = json["ok"] as? Bool
        {
            exit(ok ? 0 : 2)
        }
        exit(0)
    }
}
