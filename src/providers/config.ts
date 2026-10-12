type Environment = Record<string, string | undefined>;

export type AgentConfig =
  | { provider: "cursor"; apiKey: string; model: string }
  | { provider: "openai"; apiKey: string; model: string };

export function readAgentConfig(env: Environment = process.env): AgentConfig {
  const provider = env.AGENT_PROVIDER?.trim().toLowerCase() || "openai";
  const model = env.AGENT_MODEL?.trim();
  const apiKey = env.AGENT_API_KEY?.trim() || "";
  if (provider === "cursor") {
    return {
      provider,
      apiKey,
      model: model || "composer-2.5",
    };
  }
  if (provider === "openai") {
    return {
      provider,
      apiKey,
      model: model || "gpt-4.1-mini",
    };
  }
  throw new Error(`Unknown AGENT_PROVIDER "${provider}". Choose openai or cursor.`);
}

export function missingAgentKeys(env: Environment = process.env): string[] {
  const config = readAgentConfig(env);
  if (config.apiKey) return [];
  return ["AGENT_API_KEY"];
}
