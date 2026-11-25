import { RotatingLiveSession } from "../live-session";
import fs from "node:fs";
import path from "node:path";
import type { TranscriptionConfig } from "./config";
import { TranscribeError } from "./errors";
import type { TranscriptionProvider } from "./types";

/** OpenAI and Groq share the same multipart transcription protocol. */
export class CloudTranscriptionProvider implements TranscriptionProvider {
  private disposed = false;
  private live: RotatingLiveSession | null = null;
  private readonly active = new Set<AbortController>();

  constructor(
    private readonly config: Exclude<TranscriptionConfig, { provider: "macos" }>,
    private readonly request: typeof fetch = fetch,
  ) {}

  createLiveSession(): RotatingLiveSession {
    return this.live ??= new RotatingLiveSession((file) => this.transcribe(file, true));
  }

  async transcribe(wavPath: string, allowEmpty = false): Promise<string> {
    if (this.disposed) throw new TranscribeError("Transcription was cancelled.");
    const wav = await fs.promises.readFile(wavPath);
    if (this.disposed) throw new TranscribeError("Transcription was cancelled.");
    if (wav.length <= 44) throw new TranscribeError("Captured audio is empty.");
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), path.basename(wavPath));
    form.append("model", this.config.model);
    form.append("language", (process.env.MEETING_AUDIO_LANGUAGE || "en-US").split("-")[0]);
    form.append("response_format", "json");

    const controller = new AbortController();
    this.active.add(controller);
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await this.request(this.config.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new TranscribeError(`STT failed (${response.status}): ${body.slice(0, 400)}`);
      }
      const json: unknown = await response.json();
      const text = json && typeof json === "object" && "text" in json && typeof json.text === "string"
        ? json.text.trim() : "";
      if (!text && !allowEmpty) throw new TranscribeError("Transcription came back empty.");
      return text;
    } catch (err) {
      if (err instanceof TranscribeError) throw err;
      throw new TranscribeError(controller.signal.aborted
        ? "Transcription was cancelled or timed out."
        : `Transcription failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
      this.active.delete(controller);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
    await this.live?.stop();
    this.live = null;
  }
}
