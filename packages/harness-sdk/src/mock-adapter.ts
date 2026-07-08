/**
 * MockAdapter: a tiny in-memory HarnessAdapter.
 *
 * Two jobs:
 *  1. Validate the conformance suite itself (it is the "hypothetical second
 *     adapter" from §1).
 *  2. Let the UI run without pi or API keys (PI_DESKTOP_ADAPTER=mock): prompts
 *     are answered by streaming an echo back.
 */
import { randomUUID } from "node:crypto";
import type {
  AdapterInitOptions,
  HarnessAdapter,
  HarnessSession,
  ProviderManager,
} from "./adapter.js";
import type {
  HarnessCapabilities,
  HarnessEvent,
  ModelInfo,
  NeutralToolDefinition,
  ProviderInfo,
  SessionConfig,
  SessionSummary,
  ThinkingInfo,
  ThinkingLevel,
  ToolCallInterceptor,
  UiBridge,
} from "./types.js";

const MOCK_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

class MockSession implements HarnessSession {
  readonly id = randomUUID();
  #listeners = new Set<(event: HarnessEvent) => void>();
  #streaming = false;

  constructor(
    readonly config: SessionConfig,
    private readonly adapter: MockAdapter,
  ) {}

  get isStreaming(): boolean {
    return this.#streaming;
  }

  #emit(event: HarnessEvent): void {
    for (const l of this.#listeners) l(event);
  }

  async prompt(text: string): Promise<void> {
    this.#streaming = true;
    this.#emit({ type: "agent_start" });
    this.#emit({ type: "message_start", role: "assistant" });
    const reply = `[mock:${this.adapter.model.modelId}] you said: ${text}`;
    for (const word of reply.split(/(?<= )/)) {
      this.#emit({ type: "message_update", delta: { kind: "text", delta: word } });
      await new Promise((r) => setTimeout(r, 5));
    }
    this.#emit({ type: "message_end", role: "assistant", text: reply });
    this.#emit({ type: "agent_end" });
    this.#streaming = false;
  }

  async abort(): Promise<void> {
    if (this.#streaming) {
      this.#streaming = false;
      this.#emit({ type: "agent_end", aborted: true });
    }
  }

  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.adapter.model = { provider, modelId };
  }

  #thinking: ThinkingLevel = "off";

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    // Clamp like a real adapter would: unsupported levels fall back to "off".
    this.#thinking = MOCK_THINKING_LEVELS.includes(level) ? level : "off";
  }

  async getThinking(): Promise<ThinkingInfo> {
    return { level: this.#thinking, available: [...MOCK_THINKING_LEVELS] };
  }

  async dispose(): Promise<void> {
    this.#listeners.clear();
  }
}

class MockProviderManager implements ProviderManager {
  #keys = new Map<string, string>();

  async listProviders(): Promise<ProviderInfo[]> {
    const builtin = ["anthropic", "openai", "google"];
    const ids = new Set([...builtin, ...this.#keys.keys()]);
    return [...ids].map((id) => ({ id, hasCredentials: this.#keys.has(id) }));
  }

  async addProvider(id: string, apiKey: string): Promise<void> {
    this.#keys.set(id, apiKey);
  }

  async removeProvider(id: string): Promise<void> {
    this.#keys.delete(id);
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return [...this.#keys.keys()].map((provider) => ({
      provider,
      modelId: `${provider}-mock-model`,
      displayName: `${provider} mock model`,
      available: true,
    }));
  }
}

export class MockAdapter implements HarnessAdapter {
  readonly capabilities: HarnessCapabilities = {
    id: "mock",
    displayName: "Mock harness (echo)",
    supportsSessionTree: false,
    supportsToolCallInterception: true,
    supportsMcpBridge: false,
    supportsPluginInstall: false,
    supportsDynamicProviderRegistration: true,
    supportsCustomTools: true,
    supportsCompaction: false,
    supportsSteering: false,
    supportsThinkingLevels: true,
    supportsSkills: false,
  };

  readonly providers = new MockProviderManager();
  model = { provider: "mock", modelId: "echo-1" };

  #ui: UiBridge | undefined;
  #interceptor: ToolCallInterceptor | undefined;
  #tools = new Map<string, NeutralToolDefinition>();
  #sessions = new Set<MockSession>();

  async initialize(_options: AdapterInitOptions): Promise<void> {
    this.#ui = _options.ui;
  }

  async createSession(config: SessionConfig): Promise<HarnessSession> {
    const session = new MockSession(config, this);
    this.#sessions.add(session);
    return session;
  }

  async listSessions(_cwd?: string): Promise<SessionSummary[]> {
    return [...this.#sessions].map((s) => ({ id: s.id, cwd: s.config.cwd }));
  }

  registerToolCallInterceptor(handler: ToolCallInterceptor): void {
    this.#interceptor = handler;
  }

  registerTool(tool: NeutralToolDefinition): void {
    this.#tools.set(tool.name, tool);
  }

  async dispose(): Promise<void> {
    for (const s of this.#sessions) await s.dispose();
    this.#sessions.clear();
  }
}
