import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { SDKAgent, SDKMessage } from "@cursor/sdk";
import type { AgentConfig } from "./config";
import type { AgentProvider, AgentRequest, OnText } from "./types";

function agentCwd(): string {
  const packaged = path.join(process.resourcesPath, "agent-home");
  const dev = path.join(process.cwd(), "agent-home");
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return dev;
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

export class CursorProvider implements AgentProvider {
  private agent: SDKAgent | null = null;

  constructor(private readonly config: Extract<AgentConfig, { provider: "cursor" }>) {}

  async warm(): Promise<void> {
    if (this.agent) return;
    const { Agent } = await import("@cursor/sdk");
    this.agent = await Agent.create({
      apiKey: this.config.apiKey,
      model: {
        id: this.config.model,
        params: this.config.model === "composer-2.5" ? [{ id: "fast", value: "true" }] : [],
      },
      local: { cwd: agentCwd(), settingSources: ["project"] },
    });
  }

  async answer(request: AgentRequest, onText: OnText): Promise<string> {
    await this.warm();
    const text = request.text ? `${request.instructions}\n\n${request.text}` : request.instructions;
    try {
      const run = await this.agent!.send(request.images?.length ? { text, images: request.images } : text);
      let full = "";
      for await (const event of run.stream()) {
        const next = mergeText(full, extractAssistantText(event));
        if (next !== full) {
          full = next;
          onText(full);
        }
      }
      const result = await run.wait();
      if (result.status === "error") throw new Error("The Cursor agent finished with an error.");
      const final = result.result?.trim() ?? "";
      if (final && final.length > full.length) {
        full = final;
        onText(full);
      }
      return full.trim();
    } catch (err) {
      await this.dispose();
      throw err;
    }
  }

  async dispose(): Promise<void> {
    const current = this.agent;
    this.agent = null;
    if (!current) return;
    try {
      current.close();
    } catch {
      try {
        await current[Symbol.asyncDispose]();
      } catch {
        // Best-effort shutdown.
      }
    }
  }
}
