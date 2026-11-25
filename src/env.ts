import fs from "node:fs";
import path from "node:path";
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
      (require("dotenv") as typeof import("dotenv")).config({ path: file, override: false });
    }
  }
}

export function missingKeys(): string[] {
  return [...new Set([...missingAgentKeys(), ...missingTranscriptionKeys()])];
}
