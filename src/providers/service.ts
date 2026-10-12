import type { AgentProvider, AgentRequest, OnText } from "./types";

/** Owns initialization and shutdown; the application only sees the shared contract. */
export class AgentService {
  private provider: Promise<AgentProvider> | null = null;
  private disposed = false;

  constructor(private readonly create: () => Promise<AgentProvider>) {}

  async warm(): Promise<void> {
    await this.getProvider();
  }

  private getProvider(): Promise<AgentProvider> {
    if (this.disposed) return Promise.reject(new Error("The agent service has been disposed."));
    if (!this.provider) {
      this.provider = this.create().then(async (provider) => {
        try {
          await provider.warm();
          return provider;
        } catch (err) {
          await provider.dispose();
          throw err;
        }
      }).catch((err) => {
        this.provider = null;
        throw err;
      });
    }
    return this.provider;
  }

  async answer(request: AgentRequest, onText: OnText): Promise<string> {
    const provider = await this.getProvider();
    if (this.disposed) throw new Error("The agent service has been disposed.");
    return provider.answer(request, onText);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = this.provider;
    this.provider = null;
    if (pending) {
      // Initialization failures have already cleaned up the adapter.
      const provider = await pending.catch(() => null);
      await provider?.dispose();
    }
  }
}
