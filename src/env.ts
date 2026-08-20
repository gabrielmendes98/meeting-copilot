import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { app } from "electron";

export function loadEnv(): void {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(app.getAppPath(), ".env"),
    path.join(path.dirname(app.getAppPath()), ".env"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file, override: false });
    }
  }
}

export function hotkey(): string {
  return process.env.HOTKEY?.trim() || "Alt+Space";
}

export function screenshotHotkey(): string {
  return process.env.SCREENSHOT_HOTKEY?.trim() || "Alt+Shift+Space";
}

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!process.env.CURSOR_API_KEY?.trim()) missing.push("CURSOR_API_KEY");
  const provider = (process.env.STT_PROVIDER || "auto").trim().toLowerCase();
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasGroq = Boolean(process.env.GROQ_API_KEY?.trim());
  if (provider === "openai" && !hasOpenAI) missing.push("OPENAI_API_KEY");
  if (provider === "groq" && !hasGroq) missing.push("GROQ_API_KEY");
  return missing;
}
