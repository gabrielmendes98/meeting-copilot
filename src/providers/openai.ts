import OpenAI from "openai";
import type { Stream } from "openai/streaming";
import type { ResponseInputContent, ResponseStreamEvent } from "openai/resources/responses/responses";
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
      if (this.config.serviceTier === "ultrafast") {
        return await this.answerUltrafast(request, onText, controller.signal);
      }
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      if (request.text) content.push({ type: "text", text: request.text });
      for (const image of request.images ?? []) {
        content.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
      }
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        ...(this.config.serviceTier === "priority" ? { service_tier: "priority" } : {}),
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

  private async answerUltrafast(request: AgentRequest, onText: OnText, signal: AbortSignal): Promise<string> {
    const content: ResponseInputContent[] = [];
    if (request.text) content.push({ type: "input_text", text: request.text });
    for (const image of request.images ?? []) {
      content.push({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}`, detail: "auto" });
    }
    // The Responses endpoint accepts ultrafast before the bundled SDK types do.
    const stream = await this.client.post<Stream<ResponseStreamEvent>>("/responses", {
      body: {
        model: this.config.model,
        service_tier: "ultrafast",
        reasoning: { effort: reasoningEffort[this.config.model] },
        instructions: request.instructions,
        input: [{ role: "user", content }],
        store: false,
        stream: true,
      },
      stream: true,
      signal,
    });
    let full = "";
    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          full += event.delta;
          onText(full);
          break;
        case "response.refusal.delta":
        case "response.refusal.done":
          throw new Error("The agent declined this request.");
        case "response.incomplete":
          throw new Error(event.response.incomplete_details?.reason === "content_filter"
            ? "The agent response was blocked by the provider's content filter."
            : "The Ultrafast response ended before completion.");
        case "response.failed":
          throw new Error(event.response.error?.message ?? "The Ultrafast response failed.");
        case "error":
          throw new Error(event.message);
        case "response.completed":
          if (!full.trim()) throw new Error("The agent returned an empty response. Check that the model supports this request.");
          return full.trim();
      }
    }
    signal.throwIfAborted();
    throw new Error("The Ultrafast response stream ended before completion.");
  }

  async dispose(): Promise<void> {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}
