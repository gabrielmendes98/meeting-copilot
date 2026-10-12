import fs from "node:fs";
import path from "node:path";
import type { TranscriptionConfig } from "./config";
import { TranscribeError } from "./errors";
import type { TranscriptionProvider } from "./types";

/** OpenAI and Groq share the same multipart transcription protocol. */
export class CloudTranscriptionProvider implements TranscriptionProvider {
  private readonly active = new Set<AbortController>();

  constructor(
    private readonly config: Exclude<TranscriptionConfig, { provider: "macos" }>,
    private readonly request: typeof fetch = fetch,
  ) {}

  async transcribe(wavPath: string): Promise<string> {
    const wav = fs.readFileSync(wavPath);
    if (wav.length <= 44) throw new TranscribeError("Captured audio is empty.");
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), path.basename(wavPath));
    form.append("model", this.config.model);
    form.append("language", "en");
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
      if (!text) throw new TranscribeError("Transcription came back empty.");
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
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}
