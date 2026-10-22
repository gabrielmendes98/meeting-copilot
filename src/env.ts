import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { app } from "electron";
import { missingAgentKeys } from "./providers/config";
import { missingTranscriptionKeys } from "./transcription/config";
export { missingAgentKeys } from "./providers/config";

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

export function fullScreenshotHotkey(): string {
  return process.env.FULL_SCREENSHOT_HOTKEY?.trim() || "Alt+Ctrl+Space";
}

export function checkpointHotkey(): string {
  return process.env.CHECKPOINT_HOTKEY?.trim() || "Alt+1";
}

export function summaryHotkey(): string {
  return process.env.SUMMARY_HOTKEY?.trim() || "Alt+2";
}

export function briefingHotkey(): string {
  return process.env.BRIEFING_HOTKEY?.trim() || "Alt+3";
}

export function stealthHotkey(): string {
  return process.env.STEALTH_HOTKEY?.trim() || "Alt+Shift+S";
}

export function missingKeys(): string[] {
  return [...new Set([...missingAgentKeys(), ...missingTranscriptionKeys()])];
}
