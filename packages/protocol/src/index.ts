/**
 * Shell/UI ↔ host wire protocol (§6).
 *
 * Modeled on pi's RPC vocabulary but owned here — these are OUR types, and the
 * active adapter translates to/from them. Transport: JSON messages over a
 * localhost WebSocket, multiplexed by sessionId.
 */
import type {
  CustomModelDef,
  HarnessCapabilities,
  HarnessEvent,
  McpServerConfig,
  ModeId,
  ModelPatch,
  PermissionPolicyConfig,
  ProviderConfig,
  ThinkingLevel,
} from "@pi-desktop/harness-sdk";

export type {
  CustomModelDef,
  HarnessCapabilities,
  HarnessEvent,
  HistoryItem,
  McpServerConfig,
  McpServerStatus,
  MessageDelta,
  ModeId,
  ModelInfo,
  ModelPatch,
  OAuthProviderInfo,
  PermissionPolicyConfig,
  PermissionRule,
  PluginInfo,
  ProviderConfig,
  ProviderInfo,
  SessionSummary,
  SkillInfo,
  SubscriptionUsage,
  SubscriptionUsageWindow,
  ThinkingInfo,
  ThinkingLevel,
  ToolDecision,
} from "@pi-desktop/harness-sdk";

export const DEFAULT_HOST_PORT = 43117;

/**
 * pi-desktop's default system prompt: used for chats when no global system
 * prompt is configured, and shown as the placeholder in Settings → Prompts.
 * Mode prompts (Plan/Deepsearch) and the user's global prompt take precedence.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are a senior software engineer working inside pi-desktop, an agent workbench. You complete tasks end to end — exploring code, editing files, running commands, and researching — with whichever tools this session provides.

Working method:
- Understand before changing: read the relevant files first and follow the project's existing conventions, naming, and formatting. Never guess at an API you could check in the code.
- Prefer small, surgical edits over rewrites. Keep changes scoped to what was asked; don't refactor, reformat, or "improve" unrelated code.
- Verify your work: run the project's tests or build when a shell is available, re-read the edited section when it isn't. Don't declare something done that you haven't checked.
- If the same command or approach fails twice, stop and rethink instead of retrying variations blindly.
- State clearly which files you created or modified, with their paths.

Communication:
- Be direct and concise. Lead with the result, not a narration of your process.
- If a request is ambiguous in a way that changes the outcome, ask one targeted question; otherwise pick the sensible interpretation and say what you assumed.
- Flag risks before acting on them: destructive commands, breaking API changes, secrets in code.
- Honesty over confidence: when you're unsure something works or is true, say so — and check it when you can.`;

/* ------------------------------- client → host ---------------------------- */

interface Cmd<T extends string> {
  /** Correlation id; the host answers with a response carrying the same id. */
  id: string;
  type: T;
}

interface SessionCmd<T extends string> extends Cmd<T> {
  sessionId: string;
}

export type ClientCommand =
  | Cmd<"get_capabilities">
  | Cmd<"list_workspaces">
  | (Cmd<"open_workspace"> & { cwd?: string; mode: ModeId })
  | (Cmd<"open_session"> & { path: string; cwd?: string; mode?: ModeId })
  | SessionCmd<"close_workspace">
  /** Stop any chats that are currently generating before the shell exits. */
  | Cmd<"pause_streaming">
  | (SessionCmd<"prompt"> & { text: string })
  /** Resend an edited message: drop everything from the `keepUserMessages`-th
   *  user message onward (0-based) from the transcript, then prompt with `text`. */
  | (SessionCmd<"edit_prompt"> & { keepUserMessages: number; text: string })
  | SessionCmd<"abort">
  | SessionCmd<"compact">
  | (SessionCmd<"rename_workspace"> & { name: string })
  | (SessionCmd<"link_workspace"> & { cwd: string })
  | (SessionCmd<"set_mode"> & { mode: ModeId })
  | (SessionCmd<"set_model"> & { provider: string; modelId: string })
  | (SessionCmd<"set_thinking_level"> & { level: ThinkingLevel })
  | SessionCmd<"get_thinking">
  | (SessionCmd<"set_context_window"> & { tokens?: number })
  | (SessionCmd<"set_goal"> & { goal?: string })
  | (SessionCmd<"set_disabled_tools"> & { tools: string[] })
  | SessionCmd<"get_history">
  | SessionCmd<"get_permission_policy">
  | (SessionCmd<"set_permission_policy"> & { policy: PermissionPolicyConfig })
  | (SessionCmd<"deepsearch_query"> & { query: string })
  | Cmd<"list_providers">
  | Cmd<"list_oauth_providers">
  | (Cmd<"oauth_login"> & { providerId: string })
  | (Cmd<"test_provider"> & { providerId: string })
  | (Cmd<"subscription_usage"> & { providerId: string })
  | (Cmd<"add_provider"> & { providerId: string; apiKey: string; config?: ProviderConfig })
  | (Cmd<"remove_provider"> & { providerId: string })
  | Cmd<"list_models">
  | (Cmd<"add_model"> & { def: CustomModelDef })
  | (Cmd<"remove_model"> & { provider: string; modelId: string })
  | (Cmd<"update_model"> & { provider: string; modelId: string; patch: ModelPatch })
  | (Cmd<"list_skills"> & { cwd?: string })
  | (Cmd<"install_skill"> & { source: string; scope: "global" | "project"; cwd?: string })
  | (Cmd<"remove_skill"> & { path: string; cwd?: string })
  | Cmd<"list_skill_sources">
  | Cmd<"list_tools">
  | (Cmd<"add_skill_source"> & { path: string })
  | (Cmd<"remove_skill_source"> & { path: string })
  | (Cmd<"read_project_prompt"> & { cwd: string })
  | (Cmd<"write_project_prompt"> & { cwd: string; content: string })
  | (Cmd<"set_project_goal"> & { cwd: string; goal?: string })
  | (Cmd<"list_sessions"> & { cwd?: string })
  | Cmd<"list_mcp_servers">
  | (Cmd<"add_mcp_server"> & { config: McpServerConfig })
  | (Cmd<"remove_mcp_server"> & { name: string })
  | (Cmd<"set_mcp_server_enabled"> & { name: string; enabled: boolean })
  | Cmd<"mcp_server_status">
  | Cmd<"plugin_list">
  | (Cmd<"plugin_install"> & { source: string })
  | (Cmd<"plugin_remove"> & { source: string })
  | (Cmd<"plugin_update"> & { source?: string })
  | Cmd<"get_settings">
  | (Cmd<"set_setting"> & { key: string; value: unknown })
  | (Cmd<"save_attachment"> & { name: string; dataBase64: string })
  | (Cmd<"read_file_base64"> & { path: string })
  | (Cmd<"open_path"> & { path: string })
  | (Cmd<"list_dir"> & { path: string })
  | (Cmd<"search_files"> & { cwd: string; query: string })
  | (Cmd<"ui_response"> & { requestId: string; value: unknown });

/** Result of test_provider: a live round-trip against one of its models. */
export interface ProviderTestResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  /** Model used for the probe. */
  modelId?: string;
}

/** One registered tool (list_tools) — name plus a short UI description. */
export interface ToolInfo {
  name: string;
  description?: string;
  /** Full model-facing description for hover tooltips. */
  fullDescription?: string;
  readOnlyAllowedByDefault?: boolean;
}

/** Result of list_dir. */
export interface DirEntry {
  name: string;
  dir: boolean;
}

/** Result of search_files: project-relative path (forward slashes). */
export interface FileMatch {
  path: string;
  dir: boolean;
}

/* ------------------------------- host → client ---------------------------- */

export interface WorkspaceInfo {
  sessionId: string;
  /** Stable chat identity across restarts and mode switches (unlike sessionId,
   *  which is a fresh id each time the underlying session is (re)created). */
  chatId: string;
  cwd?: string;
  defaultWorkspace?: boolean;
  mode: ModeId;
  name?: string;
  isStreaming: boolean;
  /** Last prompt/agent activity (ms epoch) — drives sidebar recency groups. */
  lastActiveAt?: number;
  /** Per-chat context window override (set_context_window), when active. */
  contextWindow?: number;
  /** Standing goal for this chat (@goal), shown as a banner and fed to the model. */
  goal?: string;
  /** The last agent run stopped before completing successfully. Cleared only by
   *  the next successful agent_end so the sidebar dot stays red until finished. */
  interrupted?: boolean;
  /** Tools disabled for this chat (overrides the settings default). undefined =
   *  use the default. Applied when the session is (re)created. */
  disabledTools?: string[];
}

/** Interactive request surfaced by the adapter/host (permission dialogs, ...).
 *  "ask" = model question: pick one of `options` or type a custom answer. */
export interface UiRequest {
  method: "confirm" | "select" | "input" | "notify" | "ask";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  level?: "info" | "warning" | "error";
}

export type HostMessage =
  | { kind: "response"; id: string; ok: true; result?: unknown }
  | { kind: "response"; id: string; ok: false; error: string }
  | { kind: "event"; sessionId: string; event: HarnessEvent }
  | { kind: "ui_request"; requestId: string; sessionId?: string; request: UiRequest }
  | { kind: "workspaces"; workspaces: WorkspaceInfo[] }
  | { kind: "hello"; capabilities: HarnessCapabilities; workspaces: WorkspaceInfo[] };

/** An open chat persisted across host restarts. */
export interface SavedWorkspace {
  cwd?: string;
  mode: ModeId;
  name?: string;
  /** Adapter-native session path, resumed on restart when present. */
  sessionPath?: string;
  defaultWorkspace?: boolean;
  /** Adapter that owns sessionPath — other harnesses restore from the
   *  host's neutral chat log instead. */
  adapter?: string;
  /** Host-owned chat id: keys the neutral transcript log. */
  chatId?: string;
  /** Standing goal for the chat (@goal), restored on reopen. */
  goal?: string;
  /** Per-chat disabled tools override, restored on reopen. */
  disabledTools?: string[];
  /** Persisted interruption marker for the sidebar status dot. */
  interrupted?: boolean;
  lastActiveAt?: number;
}

/** Host settings exposed over get_settings/set_setting. */
export interface HostSettings {
  adapter: string;
  /** Search engine used by web_search for every search. Default: duckduckgo. */
  searchEngine?: "duckduckgo" | "brave" | "searxng";
  /** Brave Search API key (searchEngine === "brave"). */
  braveApiKey?: string;
  /** SearXNG instance URL (searchEngine === "searxng"). */
  searxngUrl?: string;
  /** Default model: preselected in the picker, applied to new workspaces. */
  defaultModel?: { provider: string; modelId: string };
  /** Default reasoning effort applied to new workspaces (clamped per model). */
  defaultThinking?: ThinkingLevel;
  /** Default permission policy applied to new workspaces. */
  defaultPermissionPolicy?: PermissionPolicyConfig;
  /** Tools disabled by default for new chats (names from list_tools). A chat can
   *  override this with its own list via set_disabled_tools. */
  disabledTools?: string[];
  /** Tool names allowed when the permission policy is Read-only. Defaults to
   *  non-mutating inspection/search utilities such as read, grep, find, and ls. */
  readOnlyAllowedTools?: string[];
  /** Standing goal per project folder (cwd → goal), injected into the system
   *  prompt of chats opened in that project. Set from a project's right-click menu. */
  projectGoals?: Record<string, string>;
  /** Fallback context window for custom models added without one. */
  defaultContextWindow?: number;
  /** Replaces the harness's built-in system prompt for all chats.
   *  Mode prompts (Plan/Deepsearch) still take precedence. */
  globalSystemPrompt?: string;
  /** Per-vendor choice: route subscription work through the official CLI
   *  (claude_code / codex tools, plan billing) instead of pi's own OAuth.
   *  Defaults when undefined: anthropic → true, openai → false. */
  useOfficialCli?: { anthropic?: boolean; openai?: boolean };
  /** Open chats, restored when the host starts. */
  openWorkspaces?: SavedWorkspace[];
}
