/**
 * Neutral vocabulary shared by the UI, shell, and host core.
 *
 * NOTHING in this file may reference pi (or any other concrete harness).
 * These shapes are modeled on pi's RPC vocabulary (§6 of the plan) but are
 * owned here; adapters translate their harness's native shapes into these.
 */

/** Capability flags (§1). The UI feature-detects against these. */
export interface HarnessCapabilities {
  /** Stable adapter id, e.g. "pi", "mock". */
  id: string;
  displayName: string;
  harnessVersion?: string;
  supportsSessionTree: boolean;
  supportsToolCallInterception: boolean;
  supportsMcpBridge: boolean;
  supportsPluginInstall: boolean;
  supportsDynamicProviderRegistration: boolean;
  supportsCustomTools: boolean;
  supportsCompaction: boolean;
  supportsSteering: boolean;
  supportsThinkingLevels: boolean;
  supportsSkills: boolean;
}

/* ------------------------------ thinking level ----------------------------- */

/** Reasoning-effort levels, ordered from none to maximum. Adapters clamp to
 *  what the active model supports. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Current thinking state of a session (HarnessSession.getThinking()). */
export interface ThinkingInfo {
  level: ThinkingLevel;
  /** Levels the active model supports (subset of ThinkingLevel). */
  available: ThinkingLevel[];
}

/** App-level modes (§7.2). A mode is a host-core concept, never a harness concept. */
export type ModeId = "chat" | "plan" | "code" | "deepsearch";

/** Neutral session config produced by the mode engine. */
export interface SessionConfig {
  /** Working directory. Undefined => in-memory / no filesystem binding. */
  cwd?: string;
  /** Allowlist of tool names. Undefined => harness default toolset. */
  tools?: string[];
  systemPromptOverride?: string;
  permissionPolicy?: PermissionPolicyConfig;
  /** Force an in-memory (non-persisted) session. */
  inMemory?: boolean;
  /** Resume an existing persisted session by adapter-native path/id. */
  resumeSession?: string;
  model?: ModelRef;
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

/* ------------------------------- permissions ------------------------------ */

export type PermissionMode = "ask" | "full-auto" | "deny-all-mutation" | "custom";
export type ToolDecision = "allow" | "deny" | "ask";

export interface PermissionRule {
  /** Tool name this rule applies to ("*" for any). */
  toolName: string;
  /** Optional path prefix constraint (matched against path-like inputs). */
  pathPrefix?: string;
  decision: ToolDecision;
}

export interface PermissionPolicyConfig {
  mode: PermissionMode;
  /** Only used when mode === "custom". */
  rules?: PermissionRule[];
}

/** Handler installed by the host-core policy engine (§7.3). */
export type ToolCallInterceptor = (
  toolName: string,
  input: unknown,
  sessionId: string,
) => ToolDecision | Promise<ToolDecision>;

/* --------------------------------- events -------------------------------- */

export type MessageDelta =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "toolcall"; delta: string };

/** Neutral streamed event, forwarded verbatim to the UI over the wire protocol. */
export type HarnessEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; aborted?: boolean; errorMessage?: string }
  | { type: "message_start"; role: string }
  | { type: "message_update"; delta: MessageDelta }
  | {
      type: "message_end";
      role: string;
      text: string;
      /** Token usage for assistant messages, when the harness reports it. */
      usage?: {
        inputTokens: number;
        outputTokens: number;
        /** Total context consumed by the last call (input+output+cache). */
        totalTokens?: number;
        /** Context window of the model that produced this message. */
        contextWindow?: number;
      };
    }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start" }
  | {
      type: "compaction_end";
      errorMessage?: string;
      /** Context tokens before compaction (for the "freed" delta). */
      tokensBefore?: number;
      /** Estimated context tokens after compaction — lets the UI drop the
       *  context-fill donut immediately instead of waiting for the next reply. */
      tokensAfter?: number;
    }
  | { type: "session_replaced"; newSessionId: string }
  | { type: "error"; message: string };

/* ---------------------------------- tools --------------------------------- */

export interface NeutralToolResultContent {
  type: "text";
  text: string;
}

export interface NeutralToolResult {
  content: NeutralToolResultContent[];
  isError?: boolean;
  /** Structured details for UI rendering (e.g. search result cards). */
  details?: unknown;
}

/** Per-session context adapters pass to tool executions. Lets globally
 *  registered tools (file access, shell, ...) act on the session's cwd. */
export interface ToolExecutionContext {
  /** Session working directory. Undefined for folderless sessions. */
  cwd?: string;
  sessionId?: string;
}

/** Harness-agnostic custom tool definition (used for web_search, file/shell
 *  tools, MCP proxies, ...). */
export interface NeutralToolDefinition {
  name: string;
  label: string;
  description: string;
  /** Whether this tool should be enabled by default under the Read-only policy. */
  readOnlyAllowedByDefault?: boolean;
  /** JSON Schema (draft 7-ish object schema) for the tool parameters. */
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate?: (partial: NeutralToolResult) => void,
    context?: ToolExecutionContext,
  ): Promise<NeutralToolResult>;
}

/* -------------------------------- UI bridge ------------------------------- */

/** Interactive prompts the adapter/host may surface to the frontend (§7.3). */
export interface UiBridge {
  confirm(title: string, message: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

/** One transcript entry returned by HarnessSession.history().
 *  role "tool" = a completed tool call (text carries the result). */
export interface HistoryItem {
  role: string;
  text: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  /** Token usage for assistant messages (same shape as message_end.usage). */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    contextWindow?: number;
  };
}

/* ------------------------------ misc summaries ---------------------------- */

export interface SessionSummary {
  id: string;
  name?: string;
  /** Adapter-native path/identifier usable with SessionConfig.resumeSession. */
  path?: string;
  cwd?: string;
  createdAt?: string;
  parentPath?: string;
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName?: string;
  available: boolean;
  /** True for user-added custom models (removable via remove_model). */
  custom?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** Model supports reasoning/thinking. */
  reasoning?: boolean;
}

/** Editable per-model fields (ProviderManager.updateModel). Applies to both
 *  custom and built-in models; undefined fields are left unchanged. */
export interface ModelPatch {
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/** User-supplied custom model definition (§7.8), e.g. a local Ollama model. */
export interface CustomModelDef {
  provider: string;
  modelId: string;
  displayName?: string;
  /** Required for new/custom providers, optional for built-in ones. */
  baseUrl?: string;
  /** Wire API dialect, e.g. "openai-completions" | "anthropic-messages". */
  api?: string;
  /** Optional credential stored alongside (local servers usually need none). */
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Model supports reasoning/thinking — enables thinking-level selection. */
  reasoning?: boolean;
}

export interface ProviderInfo {
  id: string;
  hasCredentials: boolean;
  /** How the stored credential authenticates: API key or OAuth subscription. */
  authType?: "api_key" | "oauth";
}

/** A subscription provider available for interactive OAuth login
 *  (e.g. Claude Pro/Max, ChatGPT/Codex, GitHub Copilot). */
export interface OAuthProviderInfo {
  id: string;
  name: string;
}

/** One rate-limit window of a subscription (e.g. the 5-hour window). */
export interface SubscriptionUsageWindow {
  label: string;
  /** 0–100. */
  usedPercent: number;
  /** ISO timestamp when the window resets, when known. */
  resetsAt?: string;
}

/** Plan usage for a subscription login (ProviderManager.getSubscriptionUsage). */
export interface SubscriptionUsage {
  windows: SubscriptionUsageWindow[];
}

/** Health of a stored subscription login (ProviderManager.checkSubscriptions). */
export interface SubscriptionStatus {
  id: string;
  name: string;
  /** True when the stored token is invalid and could not be refreshed. */
  expired: boolean;
}

/** Optional endpoint configuration for a user-added provider (§7.8). */
export interface ProviderConfig {
  /** Human-readable display name. */
  name?: string;
  baseUrl?: string;
  /** Wire API dialect, e.g. "openai-completions" | "anthropic-messages". */
  api?: string;
}

export interface PluginInfo {
  name: string;
  source: string;
  scope: "global" | "project";
}

/* ---------------------------------- skills --------------------------------- */

/** One discovered skill (Agent Skills standard: a directory with SKILL.md,
 *  or a single .md file — the format Claude skills use). */
export interface SkillInfo {
  name: string;
  description: string;
  /** Skill root: the skill directory, or the .md file for single-file skills.
   *  Also the identity used by SkillManager.remove(). */
  path: string;
  /** global = harness config dir; project = under the workspace folder;
   *  external = extra source directories (e.g. ~/.claude/skills). */
  scope: "global" | "project" | "external";
  /** True when the skill can be deleted from disk via remove_skill — skills in a
   *  managed directory (global/project) or inside a registered source directory.
   *  Built-in/default skills are not removable. */
  removable?: boolean;
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export type McpServerState = "connected" | "connecting" | "error" | "disabled";

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  toolCount: number;
  lastError?: string;
  /** True while an errored server is scheduled to auto-reconnect. */
  retrying?: boolean;
  /** Epoch ms of the next scheduled reconnect attempt (when retrying). */
  nextRetryAt?: number;
  /** The last failure was a connect/listTools timeout (vs an outright error). */
  timedOut?: boolean;
}
