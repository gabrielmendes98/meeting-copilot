import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { speechAppPath } from "./native-bin";

export class TranscribeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscribeError";
  }
}

export type SttProvider = "openai" | "groq" | "macos";

const LANGUAGE = "en";

function pickProvider(): SttProvider {
  const explicit = (process.env.STT_PROVIDER || "auto").trim().toLowerCase();
  if (explicit === "macos" || explicit === "speech" || explicit === "local") {
    return "macos";
  }
  if (explicit === "groq") return "groq";
  if (explicit === "openai") return "openai";

  if (process.env.GROQ_API_KEY?.trim()) return "groq";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  return "macos";
}

function cloudConfig(provider: "openai" | "groq"): {
  apiKey: string;
  url: string;
  model: string;
} {
  if (provider === "groq") {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new TranscribeError("GROQ_API_KEY is not set.");
    return {
      apiKey,
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      model: "whisper-large-v3-turbo",
    };
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new TranscribeError("OPENAI_API_KEY is not set.");
  return {
    apiKey,
    url: "https://api.openai.com/v1/audio/transcriptions",
    model: "gpt-4o-mini-transcribe",
  };
}

async function transcribeCloud(
  wavPath: string,
  provider: "openai" | "groq",
): Promise<string> {
  const { apiKey, url, model } = cloudConfig(provider);
  const wav = fs.readFileSync(wavPath);
  if (wav.length < 44) {
    throw new TranscribeError("Captured audio is empty.");
  }

  const blob = new Blob([wav], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, path.basename(wavPath));
  form.append("model", model);
  form.append("language", LANGUAGE);
  form.append("response_format", "json");

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new TranscribeError(
      `STT failed (${response.status}): ${body.slice(0, 400)}`,
    );
  }

  const json = (await response.json()) as { text?: string };
  const text = json.text?.trim() ?? "";
  if (!text) throw new TranscribeError("Transcription came back empty.");
  return text;
}

function transcribeMacos(wavPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let appPath: string;
    try {
      appPath = speechAppPath();
    } catch (err) {
      reject(err instanceof Error ? err : new TranscribeError(String(err)));
      return;
    }

    const outPath = `${wavPath}.stt.json`;
    try {
      fs.unlinkSync(outPath);
    } catch {
      // ignore
    }

    const proc = spawn(
      "open",
      ["-W", "-n", "-a", appPath, "--args", wavPath, outPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(
        new TranscribeError(
          "Timed out waiting for SpeechAnalyzer. The first run may download an on-device English model; if a permission dialog appeared, allow Meeting Copilot Speech.",
        ),
      );
    }, 180000);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(fs.readFileSync(outPath, "utf8")) as {
          ok?: boolean;
          text?: string;
          error?: string;
        };
        try {
          fs.unlinkSync(outPath);
        } catch {
          // ignore
        }
        const text = json.text?.trim() ?? "";
        if (json.ok && text) {
          resolve(text);
          return;
        }
        reject(
          new TranscribeError(
            json.error?.trim() ||
              "SpeechAnalyzer failed. Allow Meeting Copilot Speech in System Settings → Privacy → Speech Recognition.",
          ),
        );
      } catch {
        reject(
          new TranscribeError(
            stderr.trim() ||
              (code
                ? `open exited with code ${code}`
                : "Could not start macOS speech recognition."),
          ),
        );
      }
    });
  });
}

export async function transcribeWav(wavPath: string): Promise<string> {
  const provider = pickProvider();
  if (provider === "macos") return transcribeMacos(wavPath);
  return transcribeCloud(wavPath, provider);
}
