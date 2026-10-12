import { pickTranscriptionProvider } from "./transcription/config";
import { createTranscriptionProvider } from "./transcription";
import { TranscriptionService } from "./transcription/service";

export { TranscribeError } from "./transcription/errors";
export type { SttProvider } from "./transcription/types";

export const transcription = new TranscriptionService(createTranscriptionProvider);

// Preserve the existing facade for callers of the clip transcription API.
export const pickProvider = pickTranscriptionProvider;

export async function transcribeWav(wavPath: string): Promise<string> {
  return transcription.transcribe(wavPath);
}
