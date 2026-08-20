import fs from "node:fs";

const HEADER = 44;
const BYTES_PER_SEC = 48_000 * 2 * 2;

export function assertWavHasAudio(wavPath: string): void {
  const buf = fs.readFileSync(wavPath);
  const dataBytes = Math.max(0, buf.length - HEADER);
  if (buf.length <= HEADER || dataBytes < BYTES_PER_SEC * 0.2) {
    throw new Error(
      "Capture recorded no system audio. Allow Screen Recording, keep YouTube/Meet playing, and record at least 1–2 seconds.",
    );
  }

  let peak = 0;
  for (let i = HEADER; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i);
    const mag = sample < 0 ? -sample : sample;
    if (mag > peak) peak = mag;
  }
  if (peak < 120) {
    throw new Error(
      "Captured audio is silent. Raise the Mac volume (not muted) and play the video on the main display.",
    );
  }
}
