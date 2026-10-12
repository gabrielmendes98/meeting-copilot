import { readAgentConfig } from "./config";
import type { AgentConfig } from "./config";
import type { AgentProvider } from "./types";

/** Composition root: new protocols need an adapter and one factory branch. */
export async function createAgentProvider(
  config: AgentConfig = readAgentConfig(),
): Promise<AgentProvider> {
  if (!config.apiKey) {
    throw new Error("AGENT_API_KEY is not set. See .env.example.");
  }
  switch (config.provider) {
    case "cursor": {
      const { CursorProvider } = await import("./cursor.js");
      return new CursorProvider(config);
    }
    case "openai": {
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider(config);
    }
    default: {
      // Extending AgentConfig requires explicitly wiring the new adapter here.
      const unsupported: never = config;
      throw new Error(`Unsupported agent configuration: ${unsupported}`);
    }
  }
}
