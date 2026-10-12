import { spawn } from "node:child_process";
import fs from "node:fs";
import { MacosLiveSession } from "../live-session";
import { speechAppPath } from "../native-bin";
import { TranscribeError } from "./errors";
import type { LiveTranscriptionSession, TranscriptionProvider } from "./types";

export class MacosTranscriptionProvider implements TranscriptionProvider {
  private readonly pending = new Set<() => void>();
  private live: LiveTranscriptionSession | null = null;

  constructor(
    private readonly resolveAppPath: () => string = speechAppPath,
    private readonly launch: typeof spawn = spawn,
    private readonly newLiveSession: () => LiveTranscriptionSession = () => new MacosLiveSession(),
  ) {}

  createLiveSession(): LiveTranscriptionSession {
    return this.live ??= this.newLiveSession();
  }

  transcribe(wavPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const outPath = `${wavPath}.stt.json`;
      const removeOutput = () => {
        try { fs.unlinkSync(outPath); } catch { /* May not exist yet. */ }
      };
      removeOutput();
      let appPath: string;
      try {
        appPath = this.resolveAppPath();
      } catch (err) {
        reject(new TranscribeError(err instanceof Error ? err.message : String(err)));
        return;
      }

      const proc = this.launch("open", ["-W", "-n", "-a", appPath, "--args", wavPath, outPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      let settled = false;
      const finish = (error?: Error, text?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(cancel);
        removeOutput();
        if (error) reject(error);
        else resolve(text!);
      };
      const cancel = () => {
        finish(new TranscribeError("Transcription was cancelled."));
        proc.kill("SIGTERM");
      };
      const timer = setTimeout(() => {
        finish(new TranscribeError(
          "Timed out waiting for SpeechAnalyzer. The first run may download an on-device English model; if a permission dialog appeared, allow Meeting Copilot Speech.",
        ));
        proc.kill("SIGTERM");
      }, 180_000);
      this.pending.add(cancel);
      proc.on("error", (err) => finish(new TranscribeError(err.message)));
      proc.on("close", (code) => {
        if (settled) {
          removeOutput();
          return;
        }
        try {
          const json = JSON.parse(fs.readFileSync(outPath, "utf8")) as {
            ok?: boolean; text?: string; error?: string;
          };
          const text = typeof json?.text === "string" ? json.text.trim() : "";
          if (json?.ok && text) {
            finish(undefined, text);
          } else {
            finish(new TranscribeError(
              (typeof json?.error === "string" && json.error.trim()) ||
              "SpeechAnalyzer failed. Allow Meeting Copilot Speech in System Settings → Privacy → Speech Recognition.",
            ));
          }
        } catch {
          finish(new TranscribeError(stderr.trim() || (code
            ? `open exited with code ${code}` : "Could not start macOS speech recognition.")));
        }
      });
    });
  }

  async dispose(): Promise<void> {
    for (const cancel of this.pending) cancel();
    this.pending.clear();
    if (this.live) {
      const live = this.live;
      this.live = null;
      await live.stop();
    }
  }
}
