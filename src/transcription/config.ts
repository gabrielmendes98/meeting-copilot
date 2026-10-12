import { TranscribeError } from "./errors";
import type { SttProvider } from "./types";

type Environment = Record<string, string | undefined>;

export type TranscriptionConfig =
  | { provider: "macos"; mode: "live" }
  | { provider: "openai" | "groq"; mode: "clip"; apiKey: string; model: string; url: string };

export function pickTranscriptionProvider(env: Environment = process.env): SttProvider {
  const explicit = env.STT_PROVIDER?.trim().toLowerCase() || "auto";
  if (["macos", "speech", "local"].includes(explicit)) return "macos";
  if (explicit === "openai" || explicit === "groq") return explicit;
  if (explicit !== "auto") {
    throw new TranscribeError(`Unknown STT_PROVIDER "${explicit}". Choose auto, macos, openai, or groq.`);
  }
  if (env.STT_PROVIDER_API_KEY?.trim()) return "openai";
  return "macos";
}

export function readTranscriptionConfig(env: Environment = process.env): TranscriptionConfig {
  const provider = pickTranscriptionProvider(env);
  const apiKey = env.STT_PROVIDER_API_KEY?.trim() || "";
  if (provider === "macos") return { provider, mode: "live" };
  if (provider === "groq") {
    return {
      provider, mode: "clip",
      apiKey,
      model: "whisper-large-v3-turbo",
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
    };
  }
  return {
    provider, mode: "clip",
    apiKey,
    model: "gpt-4o-mini-transcribe",
    url: "https://api.openai.com/v1/audio/transcriptions",
  };
}

export function missingTranscriptionKeys(env: Environment = process.env): string[] {
  const config = readTranscriptionConfig(env);
  if (config.provider === "macos" || config.apiKey) return [];
  return ["STT_PROVIDER_API_KEY"];
}
