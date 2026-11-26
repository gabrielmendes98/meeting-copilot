import OpenAI from "openai";
import type { AgentConfig } from "./config";
import type { AgentProvider, AgentRequest, OnText } from "./types";

// Official model guidance checked 2026-11-26. Keep effort explicit for live use;
// GPT-6.2 rejects `none`, while GPT-5.4 mini supports it. Unknown/custom IDs retain API defaults.
const reasoningEffort: Record<string, "none" | "low" | "medium"> = {
  "gpt-6.2-sol": "low",
  "gpt-6.1-terra": "low",
  "gpt-6-luna": "low",
  "gpt-6.2-astra": "medium",
  "gpt-5.4-mini": "none",
};

export class OpenAIProvider implements AgentProvider {
  private readonly client: OpenAI;
  private readonly active = new Set<AbortController>();

  constructor(private readonly config: Extract<AgentConfig, { provider: "openai" }>, client?: OpenAI) {
    this.client = client ?? new OpenAI({
      apiKey: config.apiKey,
      baseURL: "https://api.openai.com/v1",
      timeout: 60_000,
      maxRetries: 1,
    });
  }

  async warm(): Promise<void> {
    // The HTTP client has no remote session to initialize.
  }

  async answer(request: AgentRequest, onText: OnText): Promise<string> {
    request.signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal?.addEventListener("abort", cancel, { once: true });
    this.active.add(controller);
    try {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      if (request.text) content.push({ type: "text", text: request.text });
      for (const image of request.images ?? []) {
        content.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
      }
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        ...(Object.hasOwn(reasoningEffort, this.config.model) ? { reasoning_effort: reasoningEffort[this.config.model] } : {}),
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content },
        ],
        stream: true,
      }, { signal: controller.signal });
      let full = "";
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice?.delta.refusal) throw new Error("The agent declined this request.");
        if (choice?.delta.content) {
          full += choice.delta.content;
          onText(full);
        }
        if (choice?.finish_reason === "content_filter") {
          throw new Error("The agent response was blocked by the provider's content filter.");
        }
        if (choice?.finish_reason === "length") {
          throw new Error("The agent response reached the provider's output limit. Try a shorter request.");
        }
      }
      if (!full.trim()) throw new Error("The agent returned an empty response. Check that the model supports this request.");
      return full.trim();
    } finally {
      request.signal?.removeEventListener("abort", cancel);
      controller.abort();
      this.active.delete(controller);
    }
  }

  async dispose(): Promise<void> {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}
