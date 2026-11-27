// Recognizers may render a listening cue as a question ("Right?") or split it across words.
const acknowledgment = /^(?:(?:m+|u+h+)[\s-]*h+[mu]+h*|m+|h+m+|o+h+|ooh+|ah+|right|all right|great|good|okay|ok|yeah|yep|yes|sure|exactly|got it|i see|makes sense|go on|please continue|certo|aham|entendi|sim|ótimo|legal|beleza)\b[\s.,;:!?？…—–-]*/iu;

export function isAcknowledgment(text: string): boolean {
  let remaining = text.trim();
  if (!remaining) return false;
  while (remaining) {
    const cue = acknowledgment.exec(remaining);
    if (!cue) return false;
    remaining = remaining.slice(cue[0].length);
  }
  return true;
}

// ASR punctuation varies by engine. Accept common unpunctuated interview prompts too.
export function isInterviewPrompt(text: string): boolean {
  const value = text.trim();
  if (!value || isAcknowledgment(value) || /(?:\.{2,}|…|\b(?:if|and|because|the|with|when|se|porque|que))\s*[?.!]?$/iu.test(value)) return false;
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
