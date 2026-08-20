import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { SDKAgent, SDKMessage } from "@cursor/sdk";

const SYSTEM_PROMPT = `You are a meeting copilot. The transcript below is a short clip from a call in English.

Rules:
- Extract the question or request aimed at the person who will answer.
- Reply in English, in 2 to 4 short spoken sentences.
- No markdown, lists, headings, or preamble.
- No filler. Do not explain what you are doing.
- If there is no clear request, reply exactly: The request wasn't clear.`;

const SCREENSHOT_PROMPT = `You are answering a question from a screenshot.

Rules:
- Use only this screenshot. Ignore any earlier conversation.
- If it is multiple choice, reply with the option letter or label and one short justification. Example: B — the derivative of x^2 is 2x.
- If it is an open question, reply in 2 to 4 short sentences.
- Match the language of the question.
- No markdown, lists, headings, or preamble.
- No filler. Do not explain what you are doing.
- If there is no clear question, reply exactly: The request wasn't clear.`;

let agent: SDKAgent | null = null;
let creating: Promise<SDKAgent> | null = null;

function agentCwd(): string {
  const packaged = path.join(process.resourcesPath, "agent-home");
  const dev = path.join(process.cwd(), "agent-home");
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return dev;
}

async function createAgent(): Promise<SDKAgent> {
  const { Agent } = await import("@cursor/sdk");
  return Agent.create({
    apiKey: process.env.CURSOR_API_KEY!,
    model: {
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    },
    local: {
      cwd: agentCwd(),
      settingSources: ["project"],
    },
  });
}

export async function warmAgent(): Promise<void> {
  if (agent) return;
  if (!creating) {
    creating = createAgent().finally(() => {
      creating = null;
    });
  }
  agent = await creating;
}

async function getAgent(): Promise<SDKAgent> {
  await warmAgent();
  if (!agent) throw new Error("Could not start the Cursor agent.");
  return agent;
}

function extractAssistantText(event: SDKMessage): string {
  if (event.type !== "assistant") return "";
  let text = "";
  for (const block of event.message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

function mergeText(full: string, piece: string): string {
  if (!piece) return full;
  if (!full) return piece;
  if (piece.startsWith(full)) return piece;
  if (full.startsWith(piece)) return full;
  return full + piece;
}

async function collectAnswer(
  run: Awaited<ReturnType<SDKAgent["send"]>>,
  onText: (fullText: string) => void,
): Promise<string> {
  let full = "";
  try {
    for await (const event of run.stream()) {
      full = mergeText(full, extractAssistantText(event));
      if (full) onText(full);
    }
    const result = await run.wait();
    if (result.status === "error") {
      throw new Error("The Cursor agent finished with an error.");
    }
    const maybeText = result.result?.trim() ?? "";
    if (maybeText && maybeText.length > full.length) {
      full = maybeText;
      onText(full);
    }
  } catch (err) {
    agent = null;
    throw err;
  }
  return full.trim();
}

export async function askFromTranscript(
  transcript: string,
  onText: (fullText: string) => void,
): Promise<string> {
  const current = await getAgent();
  const prompt = `${SYSTEM_PROMPT}

Transcript:
"""
${transcript}
"""`;

  const run = await current.send(prompt);
  return collectAnswer(run, onText);
}

export async function askFromScreenshot(
  pngPath: string,
  onText: (fullText: string) => void,
): Promise<string> {
  const png = fs.readFileSync(pngPath);
  const current = await getAgent();
  const run = await current.send({
    text: SCREENSHOT_PROMPT,
    images: [{ data: png.toString("base64"), mimeType: "image/png" }],
  });
  return collectAnswer(run, onText);
}

export async function disposeAgent(): Promise<void> {
  if (!agent) return;
  const current = agent;
  agent = null;
  try {
    current.close();
  } catch {
    try {
      await current[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
  }
}
