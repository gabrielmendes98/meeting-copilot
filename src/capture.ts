import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeBin } from "./native-bin";

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

function helperPath(): string {
  try {
    return nativeBin("audio-capture");
  } catch (err) {
    throw new CaptureError(
      err instanceof Error ? err.message : "Audio helper not found.",
    );
  }
}

export class SystemAudioCapture {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private wavPath: string | null = null;

  get active(): boolean {
    return this.proc !== null;
  }

  async start(): Promise<void> {
    if (this.proc) throw new CaptureError("Already recording.");
    const wavPath = path.join(os.tmpdir(), `meeting-copilot-${Date.now()}.wav`);
    const proc = spawn(helperPath(), [wavPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.wavPath = wavPath;

    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    await new Promise<void>((resolve, reject) => {
      let stdoutBuf = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        this.kill();
        finish(() =>
          reject(
            new CaptureError(
              stderrBuf.trim() ||
                "Timed out starting capture. Check Screen Recording permission for Terminal, Electron, and audio-capture.",
            ),
          ),
        );
      }, 20000);
      const onExit = (code: number | null) => {
        this.proc = null;
        finish(() =>
          reject(
            new CaptureError(
              stderrBuf.trim() || `audio-capture exited with code ${code ?? "?"}`,
            ),
          ),
        );
      };
      const onOut = (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        if (stdoutBuf.includes("RECORDING")) {
          proc.stdout.off("data", onOut);
          proc.off("exit", onExit);
          finish(resolve);
        }
      };
      proc.stdout.on("data", onOut);
      proc.once("exit", onExit);
    });
  }

  async stop(): Promise<string> {
    const proc = this.proc;
    const wavPath = this.wavPath;
    if (!proc || !wavPath) {
      throw new CaptureError("No capture in progress.");
    }

    return new Promise((resolve, reject) => {
      let stderrBuf = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
      });
      proc.once("exit", (code) => {
        this.proc = null;
        this.wavPath = null;
        if (code === 0 && fs.existsSync(wavPath)) {
          resolve(wavPath);
          return;
        }
        reject(
          new CaptureError(
            stderrBuf.trim() || `Failed to finish capture (code ${code}).`,
          ),
        );
      });
      try {
        proc.stdin.write("STOP\n");
      } catch {
        proc.kill("SIGTERM");
      }
      setTimeout(() => {
        if (this.proc === proc) proc.kill("SIGTERM");
      }, 3000);
    });
  }

  kill(): void {
    if (!this.proc) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.proc = null;
    if (this.wavPath && fs.existsSync(this.wavPath)) {
      try {
        fs.unlinkSync(this.wavPath);
      } catch {
        // ignore
      }
    }
    this.wavPath = null;
  }
}
