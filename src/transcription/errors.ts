export class TranscribeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscribeError";
  }
}
