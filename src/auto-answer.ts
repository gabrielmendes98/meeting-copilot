// ASR punctuation varies by engine. Accept common unpunctuated interview prompts too.
export function isInterviewPrompt(text: string): boolean {
  const value = text.trim();
  if (!value || /(?:\.{2,}|…|\b(?:if|and|because|the|with|when|se|porque|que))\s*[?.!]?$/iu.test(value)) return false;
  return /[?？]\s*$/u.test(value) ||
    /(?:^|[.!?]\s+)(?:how|why|what|where|when|which|can you|could you|would you|tell (?:me|us)|walk (?:me|us) through|describe|explain|design|implement|como|qual|quais|por que|conte|descreva|explique)\s+\S/iu.test(value);
}

export class QuietTurn {
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;

  constructor(private readonly delay: number) {}

  cancel(): void {
    clearTimeout(this.timer);
    this.revision++;
  }

  activity(onQuiet: (current: () => boolean) => void): void {
    this.cancel();
    const revision = this.revision;
    this.timer = setTimeout(() => onQuiet(() => revision === this.revision), this.delay);
  }
}
