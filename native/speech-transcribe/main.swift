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
            return "Usage: SpeechTranscribe <file.wav> [output.json]"
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
func transcribeWithAnalyzer(wav: URL) async throws -> String {
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
    if text.isEmpty { throw TranscribeError.empty }
    return text
}

func transcribe(wav: URL) async throws -> String {
    let status = await requestAuth()
    guard status == .authorized else { throw TranscribeError.denied }

    if #available(macOS 26, *) {
        return try await transcribeWithAnalyzer(wav: wav)
    }
    throw TranscribeError.unavailable
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

@main
struct SpeechTranscribeMain {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            fputs("Usage: SpeechTranscribe <file.wav> [output.json]\n", stderr)
            exit(1)
        }

        let wav = URL(fileURLWithPath: args[1])
        let outFile = args.count >= 3 ? URL(fileURLWithPath: args[2]) : nil

        let app = NSApplication.shared
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
