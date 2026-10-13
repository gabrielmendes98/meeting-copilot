import { readTranscriptionConfig, type TranscriptionConfig } from "./config";
import { TranscribeError } from "./errors";
import type { LiveTranscriptionSession, TranscriptionProvider } from "./types";

/** Owns the selected adapter and its optional live session. */
export class TranscriptionService implements LiveTranscriptionSession {
  private provider: Promise<TranscriptionProvider> | null = null;
  private initialized: TranscriptionProvider | null = null;
  private live: LiveTranscriptionSession | null = null;
  private disposed = false;
  onUnexpectedExit: ((err: Error) => void) | null = null;
  onTranscript: ((text: string) => void) | null = null;

  constructor(
    private readonly create: (config: TranscriptionConfig) => Promise<TranscriptionProvider>,
    private readonly config: () => TranscriptionConfig = readTranscriptionConfig,
  ) {}

  get supportsLive(): boolean {
    return this.config().mode === "live";
  }

  get active(): boolean {
    return this.live?.active ?? false;
  }

  private getProvider(): Promise<TranscriptionProvider> {
    if (this.disposed) return Promise.reject(new TranscribeError("The transcription service has been disposed."));
    if (!this.provider) {
      this.provider = this.create(this.config()).then((provider) => {
        this.initialized = provider;
        return provider;
      }).catch((err) => {
        this.provider = null;
        throw err;
      });
    }
    return this.provider;
  }

  private assertAvailable(): void {
    if (this.disposed) throw new TranscribeError("The transcription service has been disposed.");
  }

  async transcribe(wavPath: string): Promise<string> {
    const provider = await this.getProvider();
    this.assertAvailable();
    return provider.transcribe(wavPath);
  }

  async start(): Promise<void> {
    const provider = await this.getProvider();
    this.assertAvailable();
    if (!provider.createLiveSession) {
      throw new TranscribeError("The selected transcription provider does not support live listening.");
    }
    this.live ??= provider.createLiveSession();
    this.live.onUnexpectedExit = (err) => this.onUnexpectedExit?.(err);
    this.live.onTranscript = (text) => this.onTranscript?.(text);
    await this.live.start();
  }

  async flushAndTranscript(): Promise<string> {
    this.assertAvailable();
    if (!this.live) throw new TranscribeError("Not listening.");
    return this.live.flushAndTranscript();
  }

  async stop(): Promise<void> {
    await this.live?.stop();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = this.provider;
    this.provider = null;
    if (pending) {
      // Invoke an initialized adapter immediately so native stop commands are
      // written before Electron exits; only pending creation needs to be awaited.
      const provider = this.initialized ?? await pending.catch(() => null);
      this.initialized = null;
      await provider?.dispose();
    }
    this.live = null;
  }
}
