import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCREENCAPTURE = "/usr/sbin/screencapture";

export async function captureRegion(): Promise<string | null> {
  const pngPath = path.join(os.tmpdir(), `meeting-copilot-${Date.now()}.png`);
  const code = await new Promise<number | null>((resolve, reject) => {
    const proc = spawn(SCREENCAPTURE, ["-i", "-x", pngPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.on("error", reject);
    proc.on("close", (exitCode) => resolve(exitCode));
  });

  if (code !== 0 || !fs.existsSync(pngPath) || fs.statSync(pngPath).size === 0) {
    try {
      fs.unlinkSync(pngPath);
    } catch {
      // ignore
    }
    return null;
  }
  return pngPath;
}
