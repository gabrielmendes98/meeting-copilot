import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeBin, speechBinaryPath } from "./native-bin";
import { wavHasAudio } from "./wav";
import type { LiveTranscriptionSession } from "./transcription/types";

export class LiveSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveSessionError";
  }
}

function attachLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let buf = "";
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk: Buffer) => {
    buf += decoder.write(chunk);
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

export class RotatingLiveSession implements LiveTranscriptionSession {
  private capture: ChildProcessWithoutNullStreams | null = null;
  private speech: ChildProcessWithoutNullStreams | null = null;
  private dir: string | null = null;
  private transcript = "";
  private sttChain: Promise<void> = Promise.resolve();
  private stopTask: Promise<void> | null = null;
  private flushWaiters: Array<{
    resolve: (job: Promise<void>) => void;
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
  onTranscript: ((text: string) => void) | null = null;

  constructor(private readonly transcribe?: (file: string) => Promise<string>) {}

  get active(): boolean {
    return !this.stopping && (this.capture !== null || this.speech !== null);
  }

  async start(): Promise<void> {
    if (this.stopTask) await this.stopTask;
    if (this.capture || this.speech) {
      throw new LiveSessionError("Already listening.");
    }
    this.stopping = false;
    this.transcript = "";
    this.sttChain = Promise.resolve();

    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-copilot-live-"));
    try {
      if (!this.transcribe) await this.startSpeech();
      await this.startCapture();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async flushAndTranscript(): Promise<string> {
    const capture = this.capture;
    if (!capture || this.stopping) throw new LiveSessionError("Not listening.");
    await new Promise<void>((resolve, reject) => {
      function fail(error: Error) {
        clearTimeout(timer);
        reject(error);
      }
      const waiter = { resolve: (job: Promise<void>) => { clearTimeout(timer); resolve(job); }, reject: fail };
      const timer = setTimeout(() => {
        fail(new LiveSessionError("Timed out waiting for audio capture to flush."));
        // The FLUSH protocol is ordered. Stop before another request can consume
        // a response belonging to this expired request.
        void this.stop();
      }, 5_000);
      this.flushWaiters.push(waiter);
      capture.stdin.write("FLUSH\n", (error) => {
        if (!error) return;
        fail(new LiveSessionError(error.message));
        void this.stop();
      });
    });
    return this.transcript.trim();
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = this.stopHelpers().finally(() => { this.stopTask = null; });
    return this.stopTask;
  }

  private async stopHelpers(): Promise<void> {
    this.stopping = true;
    const capture = this.capture;
    const speech = this.speech;
    this.capture = null;
    this.speech = null;
    this.rejectWaiters(new LiveSessionError("Stopped."));
    for (const process of [capture, speech]) {
      if (!process) continue;
      process.stdin.end("STOP\n");
      process.kill("SIGTERM");
    }
    await this.sttChain;
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
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
      proc.stdin.on("error", () => {});
      proc.on("error", (error) => this.fail(error));
      proc.on("close", (code) => {
        if (this.speech === proc) this.speech = null;
        if (this.stopping) return;
        const err = new LiveSessionError(
          stderr.trim() || `Speech helper exited (${code ?? "?"}).`,
        );
        this.fail(err);
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
      const proc = spawn(bin, ["--rotate", this.dir, this.transcribe ? "8" : "5"], {
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
      proc.stdin.on("error", () => {});
      proc.on("error", (error) => this.fail(error));
      proc.on("close", (code) => {
        if (this.capture === proc) this.capture = null;
        if (this.stopping) return;
        const err = new LiveSessionError(
          stderr.trim() || `audio-capture exited (${code ?? "?"}).`,
        );
        this.fail(err);
      });
    });
  }

  private fail(error: Error): void {
    if (this.stopping) return;
    const wasStarting = this.readyWaiter !== null || this.recordingWaiter !== null;
    this.rejectWaiters(error);
    void this.stop().catch(() => {});
    if (!wasStarting) this.onUnexpectedExit?.(error);
  }

  private onCaptureLine(line: string): void {
    if (this.stopping) return;
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
        this.fail(error);
      },
    );
    if (kind === "FLUSHED") {
      const waiter = this.flushWaiters.shift();
      waiter?.resolve(job);
    }
  }

  private onSpeechLine(line: string): void {
    if (this.stopping) return;
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
      if (this.stopping || !wavHasAudio(wavPath)) return;
      let text: string;
      if (this.transcribe) {
        text = await this.transcribe(wavPath);
      } else {
        const result = await this.sendToSpeech(wavPath);
        if (!result.ok) throw new LiveSessionError(result.error || "SpeechAnalyzer failed.");
        text = result.text;
      }
      if (text && !this.stopping) {
        this.transcript = [this.transcript, text].filter(Boolean).join(" ");
        this.onTranscript?.(this.transcript);
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

export class MacosLiveSession extends RotatingLiveSession {}
