import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeBin, speechBinaryPath } from "./native-bin";

export class LiveSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveSessionError";
  }
}

const MIN_WAV_BYTES = 44 + 48_000 * 2 * 2 * 0.2;

function attachLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
      idx = buf.indexOf("\n");
    }
  });
}

type JsonWaiter = {
  resolve: (value: { ok: boolean; text: string; error: string }) => void;
  reject: (err: Error) => void;
};

export class MacosLiveSession {
  private capture: ChildProcessWithoutNullStreams | null = null;
  private speech: ChildProcessWithoutNullStreams | null = null;
  private dir: string | null = null;
  private transcript = "";
  private sttChain: Promise<void> = Promise.resolve();
  private chunkDone = new Map<string, Promise<void>>();
  private flushWaiters: Array<{
    resolve: (wavPath: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private readyWaiter: { resolve: () => void; reject: (err: Error) => void } | null =
    null;
  private recordingWaiter: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private speechJsonWaiter: JsonWaiter | null = null;
  private stopping = false;
  onUnexpectedExit: ((err: Error) => void) | null = null;

  get active(): boolean {
    return this.capture !== null || this.speech !== null;
  }

  async start(): Promise<void> {
    if (this.capture || this.speech) {
      throw new LiveSessionError("Already listening.");
    }
    this.stopping = false;
    this.transcript = "";
    this.sttChain = Promise.resolve();
    this.chunkDone.clear();
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-copilot-live-"));
    try {
      await this.startSpeech();
      await this.startCapture();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async flushAndTranscript(): Promise<string> {
    if (!this.capture) throw new LiveSessionError("Not listening.");
    const flushed = new Promise<string>((resolve, reject) => {
      this.flushWaiters.push({ resolve, reject });
    });
    try {
      this.capture.stdin.write("FLUSH\n");
    } catch {
      throw new LiveSessionError("Capture is not running.");
    }
    const wavPath = await flushed;
    await this.chunkDone.get(wavPath);
    return this.transcript.trim();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const capture = this.capture;
    const speech = this.speech;
    this.capture = null;
    this.speech = null;
    try {
      capture?.stdin.write("STOP\n");
    } catch {
      // ignore
    }
    try {
      speech?.stdin.write("STOP\n");
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      capture?.kill("SIGTERM");
    } catch {
      // ignore
    }
    try {
      speech?.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.rejectWaiters(new LiveSessionError("Stopped."));
    if (this.dir) {
      try {
        fs.rmSync(this.dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    this.dir = null;
    this.transcript = "";
    this.chunkDone.clear();
  }

  private rejectWaiters(err: Error): void {
    for (const waiter of this.flushWaiters) waiter.reject(err);
    this.flushWaiters = [];
    this.readyWaiter?.reject(err);
    this.readyWaiter = null;
    this.recordingWaiter?.reject(err);
    this.recordingWaiter = null;
    this.speechJsonWaiter?.reject(err);
    this.speechJsonWaiter = null;
  }

  private startSpeech(): Promise<void> {
    return new Promise((resolve, reject) => {
      let bin: string;
      try {
        bin = speechBinaryPath();
      } catch (err) {
        reject(err instanceof Error ? err : new LiveSessionError(String(err)));
        return;
      }
      const proc = spawn(bin, ["--watch"], { stdio: ["pipe", "pipe", "pipe"] });
      this.speech = proc;
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        const err = new LiveSessionError(
          "Timed out waiting for SpeechAnalyzer. The first run may download an on-device English model; if a permission dialog appeared, allow Meeting Copilot Speech.",
        );
        this.readyWaiter?.reject(err);
      }, 180000);
      this.readyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          this.readyWaiter = null;
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          this.readyWaiter = null;
          reject(err);
        },
      };
      attachLineReader(proc.stdout, (line) => this.onSpeechLine(line));
      proc.on("exit", (code) => {
        if (this.speech === proc) this.speech = null;
        if (this.stopping) return;
        const err = new LiveSessionError(
          stderr.trim() || `Speech helper exited (${code ?? "?"}).`,
        );
        this.readyWaiter?.reject(err);
        this.speechJsonWaiter?.reject(err);
        this.onUnexpectedExit?.(err);
      });
    });
  }

  private startCapture(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.dir) {
        reject(new LiveSessionError("No session directory."));
        return;
      }
      let bin: string;
      try {
        bin = nativeBin("audio-capture");
      } catch (err) {
        reject(err instanceof Error ? err : new LiveSessionError(String(err)));
        return;
      }
      const proc = spawn(bin, ["--rotate", this.dir], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.capture = proc;
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        const err = new LiveSessionError(
          stderr.trim() ||
            "Timed out starting capture. Check Screen Recording permission for Terminal, Electron, and audio-capture.",
        );
        this.recordingWaiter?.reject(err);
      }, 20000);
      this.recordingWaiter = {
        resolve: () => {
          clearTimeout(timer);
          this.recordingWaiter = null;
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          this.recordingWaiter = null;
          reject(err);
        },
      };
      attachLineReader(proc.stdout, (line) => this.onCaptureLine(line));
      proc.on("exit", (code) => {
        if (this.capture === proc) this.capture = null;
        if (this.stopping) return;
        const err = new LiveSessionError(
          stderr.trim() || `audio-capture exited (${code ?? "?"}).`,
        );
        this.recordingWaiter?.reject(err);
        for (const waiter of this.flushWaiters) waiter.reject(err);
        this.flushWaiters = [];
        this.onUnexpectedExit?.(err);
      });
    });
  }

  private onCaptureLine(line: string): void {
    if (line === "RECORDING") {
      this.recordingWaiter?.resolve();
      return;
    }
    if (line === "DONE") return;
    const match = /^(CHUNK|FLUSHED) (.+)$/.exec(line);
    if (!match) return;
    const kind = match[1];
    const wavPath = match[2];
    const job = this.sttChain.then(() => this.transcribeChunk(wavPath));
    this.sttChain = job.then(
      () => undefined,
      (err) => {
        const error =
          err instanceof Error ? err : new LiveSessionError(String(err));
        this.onUnexpectedExit?.(error);
        void this.stop();
      },
    );
    this.chunkDone.set(wavPath, job);
    if (kind === "FLUSHED") {
      const waiter = this.flushWaiters.shift();
      waiter?.resolve(wavPath);
    }
  }

  private onSpeechLine(line: string): void {
    if (line === "READY") {
      this.readyWaiter?.resolve();
      return;
    }
    let json: { ok?: boolean; text?: string; error?: string };
    try {
      json = JSON.parse(line) as {
        ok?: boolean;
        text?: string;
        error?: string;
      };
    } catch {
      this.speechJsonWaiter?.reject(new LiveSessionError("Bad STT output."));
      this.speechJsonWaiter = null;
      return;
    }
    const parsed = {
      ok: json.ok !== false,
      text: json.text?.trim() ?? "",
      error: json.error?.trim() ?? "",
    };
    if (this.readyWaiter && !parsed.ok) {
      this.readyWaiter.reject(
        new LiveSessionError(
          parsed.error ||
            "SpeechAnalyzer failed. Allow Meeting Copilot Speech in System Settings → Privacy → Speech Recognition.",
        ),
      );
      return;
    }
    this.speechJsonWaiter?.resolve(parsed);
    this.speechJsonWaiter = null;
  }

  private async transcribeChunk(wavPath: string): Promise<void> {
    try {
      let size = 0;
      try {
        size = fs.statSync(wavPath).size;
      } catch {
        return;
      }
      if (size >= MIN_WAV_BYTES && this.speech) {
        const result = await this.sendToSpeech(wavPath);
        if (!result.ok) {
          throw new LiveSessionError(
            result.error ||
              "SpeechAnalyzer failed. Allow Meeting Copilot Speech in System Settings → Privacy → Speech Recognition.",
          );
        }
        if (result.text) {
          this.transcript = this.transcript
            ? `${this.transcript} ${result.text}`
            : result.text;
        }
      }
    } finally {
      try {
        fs.unlinkSync(wavPath);
      } catch {
        // ignore
      }
    }
  }

  private sendToSpeech(
    wavPath: string,
  ): Promise<{ ok: boolean; text: string; error: string }> {
    const proc = this.speech;
    if (!proc) {
      return Promise.reject(new LiveSessionError("Speech helper is not running."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.speechJsonWaiter = null;
        reject(new LiveSessionError("Timed out waiting for SpeechAnalyzer."));
      }, 180000);
      this.speechJsonWaiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      try {
        proc.stdin.write(`${wavPath}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.speechJsonWaiter = null;
        reject(err instanceof Error ? err : new LiveSessionError(String(err)));
      }
    });
  }
}
