import AppKit
import Foundation
import Speech

enum TranscribeError: LocalizedError {
    case usage
    case denied
    case unavailable
    case empty
    case convert
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: SpeechTranscribe <file.wav> [output.txt]"
        case .denied:
            return "Speech Recognition was denied. In System Settings, allow Meeting Copilot Speech."
        case .unavailable:
            return "English speech recognition is unavailable on this Mac."
        case .empty:
            return "Transcription came back empty."
        case .convert:
            return "Failed to convert audio to 16 kHz mono."
        case .failed(let message):
            return message
        }
    }
}

func convertTo16kMono(from input: URL) throws -> URL {
    let output = input.deletingLastPathComponent()
        .appendingPathComponent(input.deletingPathExtension().lastPathComponent + "-16k.wav")
    try? FileManager.default.removeItem(at: output)

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/afconvert")
    proc.arguments = ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", input.path, output.path]
    try proc.run()
    proc.waitUntilExit()
    guard proc.terminationStatus == 0, FileManager.default.fileExists(atPath: output.path) else {
        throw TranscribeError.convert
    }
    return output
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
            "macOS Speech found no speech in this clip (common with music or quiet audio). Record spoken audio or set STT_PROVIDER=groq / openai."
        )
    }
    return error
}

func recognize(url: URL, onDevice: Bool) async throws -> String {
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
          recognizer.isAvailable
    else {
        throw TranscribeError.unavailable
    }

    let request = SFSpeechURLRecognitionRequest(url: url)
    request.shouldReportPartialResults = false
    request.requiresOnDeviceRecognition = onDevice && recognizer.supportsOnDeviceRecognition

    return try await withCheckedThrowingContinuation { cont in
        var resumed = false
        let finish: (Result<String, Error>) -> Void = { result in
            guard !resumed else { return }
            resumed = true
            cont.resume(with: result)
        }

        _ = recognizer.recognitionTask(with: request) { result, error in
            if let error {
                finish(.failure(mappedSpeechError(error)))
                return
            }
            guard let result, result.isFinal else { return }
            let text = result.bestTranscription.formattedString
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty {
                finish(.failure(TranscribeError.empty))
            } else {
                finish(.success(text))
            }
        }
    }
}

func transcribe(wav: URL) async throws -> String {
    let status = await requestAuth()
    guard status == .authorized else { throw TranscribeError.denied }

    let converted = try convertTo16kMono(from: wav)
    defer { try? FileManager.default.removeItem(at: converted) }

    let supportsOnDevice = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))?
        .supportsOnDeviceRecognition ?? false

    if supportsOnDevice {
        do {
            return try await recognize(url: converted, onDevice: true)
        } catch {
            return try await recognize(url: converted, onDevice: false)
        }
    }
    return try await recognize(url: converted, onDevice: false)
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
