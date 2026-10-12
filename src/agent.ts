import fs from "node:fs";
import { createAgentProvider } from "./providers";
import { AgentService } from "./providers/service";

const SYSTEM_PROMPT = `You are a meeting copilot. The transcript below is a short clip from a call in English.

Rules:
- Extract the question or request aimed at the person who will answer.
- Reply in English, in 2 to 4 short spoken sentences.
- No markdown, lists, headings, or preamble.
- No filler. Do not explain what you are doing.
- If there is no clear request, reply exactly: The request wasn't clear.`;

const CHECKPOINT_PROMPT = `You are a meeting copilot. The transcript below is everything said so far in a call in English.

Mentally summarize the call so far. Do not include that summary in your reply.
Reply with ONLY the answer to the latest question or request aimed at the person who will answer.

Rules:
- Reply in English, in 2 to 4 short spoken sentences.
- No markdown, lists, headings, or preamble.
- No filler. Do not explain what you are doing.
- If there is no clear request, reply exactly: The request wasn't clear.`;

const SUMMARY_PROMPT = `You are a meeting copilot. The transcript below is everything said so far in a call in English.

Summarize the discussion so far.

Rules:
- Reply in English.
- 1 short paragraph, or up to 6 short lines.
- Cover the main topics, decisions, and next steps.
- No markdown, no preamble, no filler.
- If there is nothing useful to summarize, reply exactly: Nothing to summarize yet.`;

const BRIEFING_PROMPT = `You are a meeting copilot. The transcript below is everything said so far in a call in English.

Reply with three short sections, in this order:

Summary: the discussion so far
Concerns: risks, blockers, and things to watch
Questions: useful questions to ask next on this topic

Rules:
- Reply in English.
- Keep each section to a few short lines.
- Use those three labels, each on its own line, then the content.
- No markdown, no preamble, no filler.
- If there is nothing useful yet, reply exactly: Nothing to summarize yet.`;

const SCREENSHOT_PROMPT = `You are answering a question from a screenshot.

Rules:
- Use only this screenshot. Ignore any earlier conversation.
- If it is multiple choice, reply with the option letter or label and one short justification. Example: B — the derivative of x^2 is 2x.
- If it is an open question, reply in 2 to 4 short sentences.
- Match the language of the question.
- No markdown, lists, headings, or preamble.
- No filler. Do not explain what you are doing.
- If there is no clear question, reply exactly: The request wasn't clear.`;

let service = new AgentService(createAgentProvider);

export async function resetAgent(): Promise<void> {
  await service.dispose();
  service = new AgentService(createAgentProvider);
}

export async function warmAgent(): Promise<void> {
  await service.warm();
}

export type TranscriptMode = "clip" | "checkpoint" | "summary" | "briefing";

const PROMPTS: Record<TranscriptMode, string> = {
  clip: SYSTEM_PROMPT,
  checkpoint: CHECKPOINT_PROMPT,
  summary: SUMMARY_PROMPT,
  briefing: BRIEFING_PROMPT,
};

export function overlayLabel(mode: TranscriptMode): string | undefined {
  if (mode === "summary") return "Summary";
  if (mode === "briefing") return "Notes";
  return undefined;
}

export function emptyReply(mode: TranscriptMode): string {
  if (mode === "summary" || mode === "briefing") {
    return "Nothing to summarize yet.";
  }
  return "The request wasn't clear.";
}

export async function askFromTranscript(
  transcript: string,
  onText: (fullText: string) => void,
  options?: { mode?: TranscriptMode },
): Promise<string> {
  return service.answer({
    instructions: PROMPTS[options?.mode ?? "clip"],
    text: `Transcript:\n"""\n${transcript}\n"""`,
  }, onText);
}

export async function askFromScreenshot(
  pngPath: string,
  onText: (fullText: string) => void,
): Promise<string> {
  const png = fs.readFileSync(pngPath);
  return service.answer({
    instructions: SCREENSHOT_PROMPT,
    images: [{ data: png.toString("base64"), mimeType: "image/png" }],
  }, onText);
}

export async function disposeAgent(): Promise<void> {
  await service.dispose();
}
