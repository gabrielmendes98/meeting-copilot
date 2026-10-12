export type SttProvider = "openai" | "groq" | "macos";

/** Optional capability for providers that support continuous listening. */
export interface LiveTranscriptionSession {
  readonly active: boolean;
  onUnexpectedExit: ((err: Error) => void) | null;
  start(): Promise<void>;
  flushAndTranscript(): Promise<string>;
  stop(): Promise<void>;
}

export interface TranscriptionProvider {
  transcribe(wavPath: string): Promise<string>;
  createLiveSession?(): LiveTranscriptionSession;
  dispose(): Promise<void>;
}
