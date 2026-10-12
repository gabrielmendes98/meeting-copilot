/** Provider-independent input. Each request carries all of its own context. */
export interface AgentRequest {
  instructions: string;
  text?: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export type OnText = (fullText: string) => void;

/** Adapters normalize provider streams into accumulated text for the overlay. */
export interface AgentProvider {
  warm(): Promise<void>;
  answer(request: AgentRequest, onText: OnText): Promise<string>;
  dispose(): Promise<void>;
}
