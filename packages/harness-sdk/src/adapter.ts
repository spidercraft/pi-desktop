/**
 * The HarnessAdapter contract (§1).
 *
 * This is the ONLY interface `apps/ui`, `apps/shell`, and the host core are
 * allowed to know about. Swapping harnesses = new implementation of this
 * interface + a config flip in the adapter registry.
 */
import type {
  CustomModelDef,
  HarnessCapabilities,
  HarnessEvent,
  HistoryItem,
  McpServerConfig,
  McpServerStatus,
  ModelInfo,
  ModelPatch,
  NeutralToolDefinition,
  OAuthProviderInfo,
  PluginInfo,
  ProviderConfig,
  ProviderInfo,
  SessionConfig,
  SessionSummary,
  SkillInfo,
  SubscriptionStatus,
  SubscriptionUsage,
  ThinkingInfo,
  ThinkingLevel,
  ToolCallInterceptor,
  UiBridge,
} from "./types.js";

/** A live agent session, harness-neutral. */
export interface HarnessSession {
  readonly id: string;
  readonly config: SessionConfig;
  readonly isStreaming: boolean;
  /** Adapter-native persistent path, usable with SessionConfig.resumeSession.
   *  Undefined for in-memory sessions. */
  readonly path?: string;
  prompt(text: string): Promise<void>;
  /** Only when capabilities.supportsSteering. */
  steer?(text: string): Promise<void>;
  followUp?(text: string): Promise<void>;
  abort(): Promise<void>;
  /** Subscribe to neutral events. Returns an unsubscribe function. */
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  setModel?(provider: string, modelId: string): Promise<void>;
  /** Override the active model's context window for this session only.
   *  undefined restores the model's own value. Optional per adapter. */
  setContextWindow?(tokens?: number): Promise<void>;
  /** Only when capabilities.supportsThinkingLevels. The adapter clamps the
   *  level to what the active model supports; read back via getThinking(). */
  setThinkingLevel?(level: ThinkingLevel): Promise<void>;
  /** Only when capabilities.supportsThinkingLevels. */
  getThinking?(): Promise<ThinkingInfo>;
  /** Only when capabilities.supportsCompaction. */
  compact?(): Promise<void>;
  /** Past transcript (user/assistant text), for resumed sessions. Optional. */
  history?(): Promise<HistoryItem[]>;
  dispose(): Promise<void>;
}

/** Neutral provider/model management (§7.8). */
export interface ProviderManager {
  listProviders(): Promise<ProviderInfo[]>;
  /** Store credentials and (optionally) endpoint config for a provider. */
  addProvider(id: string, apiKey: string, config?: ProviderConfig): Promise<void>;
  removeProvider(id: string): Promise<void>;
  getAvailableModels(): Promise<ModelInfo[]>;
  /** Register a custom model (e.g. local Ollama). Optional per adapter. */
  addModel?(def: CustomModelDef): Promise<void>;
  /** Remove a previously added custom model. Optional per adapter. */
  removeModel?(provider: string, modelId: string): Promise<void>;
  /** Edit model metadata (context window, ...). Works on custom AND built-in
   *  models (built-ins via a persisted override). Optional per adapter. */
  updateModel?(provider: string, modelId: string, patch: ModelPatch): Promise<void>;
  /** Subscription providers supporting interactive OAuth login. Optional. */
  listOAuthProviders?(): Promise<OAuthProviderInfo[]>;
  /** Run a provider's interactive login flow. The adapter drives the user
   *  dialogs through the UiBridge; resolves once credentials are stored. */
  oauthLogin?(providerId: string): Promise<void>;
  /** Validate stored subscription logins (refreshing tokens as needed).
   *  Expired entries could not be refreshed and need a fresh login. */
  checkSubscriptions?(): Promise<SubscriptionStatus[]>;
  /** Plan usage for a subscription login. null = not supported/available. */
  getSubscriptionUsage?(providerId: string): Promise<SubscriptionUsage | null>;
}

/** Neutral plugin/package management (§2). */
export interface PluginManager {
  list(): Promise<PluginInfo[]>;
  install(source: string): Promise<void>;
  remove(source: string): Promise<void>;
  update(source?: string): Promise<void>;
}

/** Neutral skill management (Agent Skills standard — Claude-skills compatible). */
export interface SkillManager {
  /** All discovered skills: global + project (when cwd given) + sources. */
  list(cwd?: string): Promise<SkillInfo[]>;
  /** Copy a skill (directory with SKILL.md, or a single .md file) into the
   *  global or project skills directory. */
  install(source: string, scope: "global" | "project", cwd?: string): Promise<void>;
  /** Delete a skill from disk by SkillInfo.path. Works for skills in a managed
   *  directory (global/project) and for external skills inside a registered
   *  source directory; never deletes a skills root itself. */
  remove(path: string, cwd?: string): Promise<void>;
  /** Extra directories searched for skills (e.g. ~/.claude/skills). */
  listSources(): Promise<string[]>;
  addSource(path: string): Promise<void>;
  removeSource(path: string): Promise<void>;
}

/** Neutral MCP bridge surface (§7.7). */
export interface McpManager {
  list(): Promise<McpServerStatus[]>;
  add(config: McpServerConfig): Promise<void>;
  remove(name: string): Promise<void>;
  /** Enable or disable a server without removing it. Disabling disconnects it
   *  and stops reconnect attempts; enabling (re)connects. Persisted. */
  setEnabled(name: string, enabled: boolean): Promise<void>;
}

export interface AdapterInitOptions {
  /** Bridge for interactive prompts (permission dialogs etc.). */
  ui: UiBridge;
}

export interface HarnessAdapter {
  readonly capabilities: HarnessCapabilities;

  initialize(options: AdapterInitOptions): Promise<void>;

  createSession(config: SessionConfig): Promise<HarnessSession>;
  listSessions(cwd?: string): Promise<SessionSummary[]>;

  /**
   * Install the tool-call interception hook (§7.3). The adapter must consult
   * the handler before every tool execution in every session; "ask" means the
   * adapter resolves via the UiBridge confirm() and blocks on rejection.
   * Only meaningful when capabilities.supportsToolCallInterception.
   */
  registerToolCallInterceptor(handler: ToolCallInterceptor): void;

  /**
   * Register a custom tool made available to sessions created afterwards.
   * Only meaningful when capabilities.supportsCustomTools.
   */
  registerTool(tool: NeutralToolDefinition): void;

  /** Delete a persisted session (by HarnessSession.path). Optional. */
  deleteSession?(path: string): Promise<void>;

  /** Present iff capabilities.supportsDynamicProviderRegistration. */
  readonly providers?: ProviderManager;
  /** Present iff capabilities.supportsPluginInstall. */
  readonly plugins?: PluginManager;
  /** Present iff capabilities.supportsMcpBridge. */
  readonly mcp?: McpManager;
  /** Present iff capabilities.supportsSkills. */
  readonly skills?: SkillManager;

  dispose(): Promise<void>;
}
