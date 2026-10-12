import { readTranscriptionConfig, type TranscriptionConfig } from "./config";
import { TranscribeError } from "./errors";
import type { TranscriptionProvider } from "./types";

export async function createTranscriptionProvider(
  config: TranscriptionConfig = readTranscriptionConfig(),
): Promise<TranscriptionProvider> {
  switch (config.provider) {
    case "macos": {
      const { MacosTranscriptionProvider } = await import("./macos.js");
      return new MacosTranscriptionProvider();
    }
    case "openai":
    case "groq": {
      if (!config.apiKey) {
        throw new TranscribeError("STT_PROVIDER_API_KEY is not set. See .env.example.");
      }
      const { CloudTranscriptionProvider } = await import("./cloud.js");
      return new CloudTranscriptionProvider(config);
    }
    default: {
      const unsupported: never = config;
      throw new TranscribeError(`Unsupported transcription configuration: ${unsupported}`);
    }
  }
}
