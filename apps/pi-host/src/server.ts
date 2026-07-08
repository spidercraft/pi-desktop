/**
 * pi-host: the sidecar process (§3). Owns the session registry, mode logic,
 * permission policy and provider/plugin orchestration — written entirely
 * against HarnessAdapter, never against pi directly.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  HarnessAdapter,
  HarnessSession,
  ModeId,
  ModelRef,
  NeutralToolDefinition,
  PermissionPolicyConfig,
  SessionConfig,
  UiBridge,
} from "@pi-desktop/harness-sdk";
import {
  DEFAULT_HOST_PORT,
  DEFAULT_SYSTEM_PROMPT,
  type ClientCommand,
  type DirEntry,
  type HistoryItem,
  type HostMessage,
  type SavedWorkspace,
  type ToolInfo,
  type UiRequest,
  type WorkspaceInfo,
} from "@pi-desktop/protocol";
import { createAdapter } from "./adapter-registry.js";
import {
  ATTACHMENTS_DIR,
  deleteManagedAttachments,
  managedAttachmentPaths,
} from "./attachments.js";
import { ChatLog, toolResultText } from "./chat-log.js";
import { McpService } from "./mcp-service.js";
import { deepsearchPromptTemplate, sessionConfigForMode } from "./mode-engine.js";
import { PermissionPolicyEngine } from "./permission-policy.js";
import { SettingsStore } from "./settings.js";
import { createAskUserTool } from "./tools/ask-user.js";
import { createClaudeCodeTool, createCodexTool } from "./tools/cli-agents.js";
import { createFileTools } from "./tools/file-tools.js";
import { createShellTool } from "./tools/shell-tool.js";
import { createDeepsearchTool, createPlanTool, type SubagentSource } from "./tools/subagent.js";
import { createTodoTool } from "./tools/todo.js";
import { createWebSearchTool, testSearxng } from "./tools/web-search.js";

const SEARCH_SKIP = new Set([".git", "node_modules", "dist", "target", "__pycache__"]);
const SEARCH_MAX_SCANNED = 20_000;
const SEARCH_MAX_DEPTH = 10;

/** Cap on replayed-history text injected into a reopened session's prompt. */
const HISTORY_CONTEXT_MAX_CHARS = 16_000;
const PAUSE_STREAMING_TIMEOUT_MS = 5_000;
const DEFAULT_WORKSPACE_NAME = "Default Workspace";

function defaultWorkspaceDir(): string {
  const path = join(homedir(), ".pi", DEFAULT_WORKSPACE_NAME);
  try {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o555);
  } catch (err) {
    console.error("[pi-host] failed to prepare default workspace:", (err as Error).message);
  }
  return path;
}

function defaultWorkspacePrompt(path: string): string {
  return (
    `<workspace>\n` +
    `This chat is using Pi Desktop's ${DEFAULT_WORKSPACE_NAME} at:\n${path}\n\n` +
    `It is a fallback workspace for chats that were not opened from a project folder. ` +
    `Treat it as read-only: do not create, edit, delete, move, or rename files here. ` +
    `If the user wants file changes, ask them to open or link a real project folder first.\n` +
    `</workspace>`
  );
}

function openWithDefaultApp(path: string): Promise<void> {
  const command = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["-NoProfile", "-Command", "Start-Process -LiteralPath $args[0]", path]
      : [path];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

/** Render a neutral transcript as plain text, for replaying a chat's context
 *  into a fresh session when it can't resume natively (folderless/in-memory
 *  chats). Keeps the most recent messages if the transcript is very long. */
function transcriptContext(items: HistoryItem[]): string {
  const lines: string[] = [];
  for (const it of items) {
    if (it.role === "user") {
      if (it.text?.trim()) lines.push(`User: ${it.text}`);
    } else if (it.role === "assistant") {
      if (it.text?.trim()) lines.push(`Assistant: ${it.text}`);
    } else if (it.role === "tool") {
      const out = (it.text ?? "").slice(0, 400);
      lines.push(`[Tool ${it.toolName ?? "tool"}${out ? ` → ${out}` : ""}]`);
    }
  }
  const text = lines.join("\n\n");
  return text.length > HISTORY_CONTEXT_MAX_CHARS
    ? "…(earlier messages omitted)…\n\n" + text.slice(-HISTORY_CONTEXT_MAX_CHARS)
    : text;
}

function sameHistoryItem(a: HistoryItem, b: HistoryItem): boolean {
  return a.role === b.role && (a.text ?? "") === (b.text ?? "") && a.toolName === b.toolName;
}

/** Native adapter history can be ahead of the neutral log after a resume, but
 *  if the app is closed mid-response some adapters may restore only the partial
 *  assistant state. Keep the host-owned log as a safety net so the first user
 *  prompt never disappears from the reopened transcript. */
function mergeNativeAndNeutralHistory(native: HistoryItem[], neutral: HistoryItem[]): HistoryItem[] {
  if (native.length === 0 || neutral.length === 0) return native.length > 0 ? native : neutral;

  const firstNativeIndexInNeutral = neutral.findIndex((item) => sameHistoryItem(item, native[0]));
  if (firstNativeIndexInNeutral === 0) return native;
  if (firstNativeIndexInNeutral > 0) {
    return [...neutral.slice(0, firstNativeIndexInNeutral), ...native];
  }

  const merged = [...neutral];
  for (const item of native) {
    if (!merged.some((existing) => sameHistoryItem(existing, item))) merged.push(item);
  }
  return merged;
}

/** Breadth-first recursive filename search under `root` (case-insensitive). */
function searchFiles(
  root: string,
  query: string,
  limit: number,
): { path: string; dir: boolean }[] {
  const q = query.toLowerCase().replaceAll("\\", "/");
  const results: { path: string; dir: boolean; score: number }[] = [];
  const queue: string[] = [""];
  let scanned = 0;
  while (queue.length > 0 && scanned < SEARCH_MAX_SCANNED) {
    const rel = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SEARCH_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      scanned++;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (isDir && relPath.split("/").length < SEARCH_MAX_DEPTH) queue.push(relPath);
      const name = entry.name.toLowerCase();
      let score = -1;
      if (!q) score = 0;
      else if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 60;
      else if (relPath.toLowerCase().includes(q)) score = 40;
      if (score >= 0) results.push({ path: relPath, dir: isDir, score });
    }
  }
  return results
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, limit)
    .map(({ path, dir }) => ({ path, dir }));
}

interface Workspace {
  session: HarnessSession;
  mode: ModeId;
  cwd?: string;
  /** User-visible chat name (rename_workspace). */
  name?: string;
  /** True when cwd is the generated read-only fallback workspace, not a user project. */
  defaultWorkspace?: boolean;
  policy: PermissionPolicyEngine;
  unsubscribe: () => void;
  /** Tracked from agent_start/agent_end events — the adapter's own
   *  isStreaming flag may not have flipped yet when agent_end fires. */
  streaming: boolean;
  /** Last prompt/agent activity, for sidebar recency grouping. */
  lastActiveAt: number;
  /** Last run stopped before completing successfully; shown as a red sidebar dot
   *  until the next successful agent_end. */
  interrupted: boolean;
  /** Per-chat context window override, re-applied after model switches. */
  contextWindow?: number;
  /** Current user-selected model. CLI-routed subscription models are not set on
   *  the underlying pi session because pi would require its own credentials. */
  model?: ModelRef;
  /** Standing goal for this chat (@goal). Prepended to the model's context so
   *  it steers the conversation; shown as a banner in the UI. */
  goal?: string;
  /** The goal value last announced to the model, so we inject it once per change
   *  rather than on every turn. */
  goalAnnounced?: string;
  /** Tools disabled for this chat (overrides the settings default). Applied when
   *  the session is (re)created. */
  disabledTools?: string[];
  /** Host-owned chat id + neutral transcript log (survives harness switches). */
  chatId: string;
  log: ChatLog;
  /** toolCallId → log index, to attach results to their calls. */
  toolLogIndex: Map<string, number>;
}

class HostServer {
  private readonly settings = new SettingsStore();
  /** User-facing custom tools — drives @tool autocomplete and the
   *  "@toolname must be used" prompt directive. MCP proxy tools are kept OUT of
   *  this list (hidden from the user) and tracked in `mcpToolNames` instead. */
  private readonly tools: ToolInfo[] = [];
  private readonly toolDefinitions = new Map<string, NeutralToolDefinition>();
  /** Names of registered MCP proxy tools (mcp__<server>__<tool>). Hidden from
   *  the user, but enabled for the model in every non-plan session. */
  private readonly mcpToolNames = new Set<string>();
  private get toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }
  private defaultReadOnlyAllowedTools(): string[] {
    return this.tools.filter((t) => t.readOnlyAllowedByDefault).map((t) => t.name);
  }
  /** Sessions spawned by the plan/deepsearch tools (not user workspaces). */
  private readonly subagentSessions = new Set<string>();

  /** Per-vendor "use official CLI" preference.
   *  Defaults: Claude → on, Codex → off. */
  private cliEnabled(vendor: "anthropic" | "openai"): boolean {
    return this.settings.get("useOfficialCli")?.[vendor] ?? vendor === "anthropic";
  }

  private cliVendorForProvider(provider: string): "anthropic" | "openai" | undefined {
    const id = provider.toLowerCase();
    if (id === "anthropic") return "anthropic";
    if (id === "openai" || id === "openai-codex") return "openai";
    return undefined;
  }

  private usesOfficialCli(model: ModelRef | undefined): boolean {
    const vendor = model ? this.cliVendorForProvider(model.provider) : undefined;
    return Boolean(vendor && this.cliEnabled(vendor));
  }

  private currentOfficialCliModel(model: ModelRef | undefined): ModelRef | undefined {
    if (!model || !this.usesOfficialCli(model)) return model;
    if (model.provider.toLowerCase() !== "anthropic") return model;
    const id = model.modelId.toLowerCase();
    if (id.includes("sonnet")) return { ...model, modelId: "claude-sonnet-5" };
    if (id.includes("opus")) return { ...model, modelId: "claude-opus-4-8" };
    if (id.includes("haiku")) return { ...model, modelId: "claude-haiku-4-5" };
    if (id.includes("fable")) return { ...model, modelId: "claude-fable-5" };
    return model;
  }

  /** Register a custom tool. MCP proxy tools stay hidden from the user (not in
   *  the @mention list) but are still handed to the adapter so the model can
   *  call them; everything else is exposed for @mentions. */
  private registerTool(tool: NeutralToolDefinition): void {
    if (tool.name.startsWith("mcp__")) {
      this.mcpToolNames.add(tool.name);
    } else {
      // First sentence of the model-facing description, as a short UI blurb.
      const sentence = tool.description.split(/(?<=[.!?])\s/)[0] ?? "";
      this.tools.push({
        name: tool.name,
        description: sentence.length > 90 ? `${sentence.slice(0, 87)}…` : sentence,
        fullDescription: tool.description,
        readOnlyAllowedByDefault: tool.readOnlyAllowedByDefault,
      });
    }
    this.toolDefinitions.set(tool.name, tool);
    this.adapter.registerTool(tool);
  }

  /**
   * Run a one-shot, in-memory subagent (plan/deepsearch tool) and return its
   * final assistant message. Tool permissions auto-allow: both configs are
   * read-only toolsets, and the parent chat's own policy already gated the
   * plan/deepsearch tool call itself.
   */
  private async runSubagent(
    mode: "plan" | "deepsearch",
    promptText: string,
    cwd: string | undefined,
    signal?: AbortSignal,
    onProgress?: (partial: { output: string; sources: SubagentSource[] }) => void,
  ): Promise<{ output: string; sources: SubagentSource[] }> {
    const config = sessionConfigForMode(mode, cwd, { mode: "full-auto" });
    config.inMemory = true;
    const defaultModel = this.currentOfficialCliModel(this.settings.get("defaultModel"));
    if (defaultModel && !this.usesOfficialCli(defaultModel)) config.model = defaultModel;

    const session = await this.adapter.createSession(config);
    this.subagentSessions.add(session.id);
    try {
      let output = "";
      let errorMessage: string | undefined;
      let unsubscribe = () => {};
      /** Every source any web_search inside the run touched: url → metadata. */
      const sources = new Map<string, { title: string; snippet?: string }>();
      const done = new Promise<void>((resolve) => {
        unsubscribe = session.subscribe((event) => {
          if (event.type === "message_end" && event.role === "assistant" && event.text.trim()) {
            output = event.text;
          }
          if (
            event.type === "tool_execution_end" &&
            event.toolName === "web_search" &&
            !event.isError
          ) {
            const details = (event.result as { details?: unknown } | undefined)?.details as
              | { results?: Array<{ title?: string; url?: string; snippet?: string }> }
              | undefined;
            let added = false;
            for (const r of details?.results ?? []) {
              if (r?.url && !sources.has(r.url)) {
                sources.set(r.url, { title: r.title ?? "", snippet: r.snippet });
                added = true;
              }
            }
            if (added) {
              const currentSources = [...sources].map(([url, source]) => ({ url, ...source }));
              onProgress?.({
                output: `Deepsearch is running… ${currentSources.length} visited link${currentSources.length === 1 ? "" : "s"} so far.`,
                sources: currentSources,
              });
            }
          }
          if (event.type === "agent_end") {
            errorMessage = event.aborted ? "aborted" : event.errorMessage;
            resolve();
          }
        });
      });
      const onAbort = () => void session.abort();
      signal?.addEventListener("abort", onAbort);
      try {
        await session.prompt(
          mode === "deepsearch" ? deepsearchPromptTemplate(promptText) : promptText,
        );
        await done;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
      }
      if (errorMessage) throw new Error(errorMessage);
      // The report cites a selection; `sources` is the full audit trail of
      // everything the run touched — rendered as cards in the UI.
      return {
        output: output || "(the subagent produced no output)",
        sources: [...sources].map(([url, source]) => ({ url, ...source })),
      };
    } finally {
      this.subagentSessions.delete(session.id);
      await session.dispose().catch(() => {});
    }
  }

  /**
   * Connectivity probe: run a minimal no-tools completion against one of the
   * provider's models. Verifies credentials, endpoint reachability, and that
   * the provider actually answers — the same path real chats use.
   */
  private async testProvider(
    providerId: string,
  ): Promise<{ ok: boolean; error?: string; latencyMs?: number; modelId?: string }> {
    const providers = this.requireProviders();
    const models = await providers.getAvailableModels();
    const model = models.find((m) => m.provider === providerId && m.available);
    if (!model) {
      return { ok: false, error: "No usable model for this provider (missing credentials?)" };
    }

    const config: SessionConfig = {
      inMemory: true,
      tools: [],
      model: { provider: model.provider, modelId: model.modelId },
      systemPromptOverride: "You are a connectivity probe. Reply with the single word OK.",
      permissionPolicy: { mode: "full-auto" },
    };
    const started = Date.now();
    const session = await this.adapter.createSession(config);
    this.subagentSessions.add(session.id);
    try {
      let errorMessage: string | undefined;
      let unsubscribe = () => {};
      const done = new Promise<void>((resolve) => {
        unsubscribe = session.subscribe((event) => {
          if (event.type === "agent_end") {
            errorMessage = event.aborted ? "aborted" : event.errorMessage;
            resolve();
          }
        });
      });
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 30_000),
      );
      await session.prompt("Reply with the single word OK.");
      const result = await Promise.race([done, timeout]);
      unsubscribe();
      if (result === "timeout") {
        await session.abort().catch(() => {});
        return { ok: false, error: "Timed out after 30s", modelId: model.modelId };
      }
      if (errorMessage) return { ok: false, error: errorMessage, modelId: model.modelId };
      return { ok: true, latencyMs: Date.now() - started, modelId: model.modelId };
    } catch (err) {
      return { ok: false, error: (err as Error).message, modelId: model.modelId };
    } finally {
      this.subagentSessions.delete(session.id);
      await session.dispose().catch(() => {});
    }
  }

  /** Set once the startup subscription check has run for this host process. */
  private subscriptionsChecked = false;

  /**
   * Validate stored subscription logins once per host run: tokens that can't
   * be refreshed are signed out automatically and the user is told to log in
   * again. Runs when the first client connects so the dialog is visible.
   */
  private async checkSubscriptionsOnce(): Promise<void> {
    if (this.subscriptionsChecked) return;
    this.subscriptionsChecked = true;
    const providers = this.adapter.providers;
    if (!providers?.checkSubscriptions) return;
    try {
      const statuses = await providers.checkSubscriptions();
      for (const status of statuses.filter((s) => s.expired)) {
        await providers.removeProvider(status.id).catch(() => {});
        void this.requestUi({
          method: "confirm",
          title: "Subscription login expired",
          message:
            `Your ${status.name} login has expired and could not be refreshed, ` +
            `so it was signed out. Log in again in Settings → Providers to keep ` +
            `using its models.`,
        });
      }
    } catch (err) {
      console.error("[pi-host] subscription check failed:", (err as Error).message);
    }
  }

  /** Append an explicit directive when the user @-mentions registered tools. */
  private withToolDirectives(text: string): string {
    const mentioned = this.toolNames.filter((name) =>
      new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text),
    );
    if (mentioned.length === 0) return text;
    return (
      `${text}\n\n[Directive: the user @-mentioned these tools — ` +
      `you MUST use them to fulfil this request: ${mentioned.join(", ")}]`
    );
  }

  /** Prepend the chat's standing goal (@goal) once per change, so the model
   *  works toward it without repeating the reminder on every single turn. */
  private withGoal(workspace: Workspace, text: string): string {
    if (!workspace.goal || workspace.goal === workspace.goalAnnounced) return text;
    workspace.goalAnnounced = workspace.goal;
    return (
      `[Goal for this chat — keep working toward it for the rest of the ` +
      `conversation unless I change it: ${workspace.goal}]\n\n${text}`
    );
  }
  private readonly workspaces = new Map<string, Workspace>();
  private readonly clients = new Set<WebSocket>();
  private readonly pendingUi = new Map<string, (value: unknown) => void>();
  private adapter!: HarnessAdapter;
  /** Host-core MCP bridge (§7.7) — used when the adapter has no native one. */
  private mcpService?: McpService;
  /** Periodically removes chats whose project folders were deleted externally. */
  private missingProjectCleanupTimer?: ReturnType<typeof setInterval>;

  /** Adapter capabilities, upgraded with host-core provided features. */
  private get capabilities() {
    return {
      ...this.adapter.capabilities,
      supportsMcpBridge:
        this.adapter.capabilities.supportsMcpBridge || this.mcpService !== undefined,
    };
  }

  private get mcp() {
    const mcp = this.adapter.mcp ?? this.mcpService;
    if (!mcp) throw new Error("MCP is not supported by the active adapter");
    return mcp;
  }

  /* ------------------------------- transport ------------------------------ */

  private broadcast(message: HostMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  private workspaceList(): WorkspaceInfo[] {
    return [...this.workspaces.entries()].map(([sessionId, w]) => ({
      sessionId,
      chatId: w.chatId,
      cwd: w.cwd,
      defaultWorkspace: w.defaultWorkspace,
      mode: w.mode,
      name: w.name,
      isStreaming: w.streaming,
      lastActiveAt: w.lastActiveAt,
      contextWindow: w.contextWindow,
      goal: w.goal,
      interrupted: w.interrupted,
      disabledTools: w.disabledTools,
    }));
  }

  private pushWorkspaces(): void {
    this.broadcast({ kind: "workspaces", workspaces: this.workspaceList() });
    this.persistWorkspaces();
  }

  /** Save open chats so they survive host restarts. */
  private persistWorkspaces(): void {
    const list: SavedWorkspace[] = [...this.workspaces.values()].map((w) => ({
      cwd: w.cwd,
      mode: w.mode,
      name: w.name,
      sessionPath: w.session.path,
      defaultWorkspace: w.defaultWorkspace,
      adapter: this.adapter.capabilities.id,
      chatId: w.chatId,
      goal: w.goal,
      disabledTools: w.disabledTools,
      interrupted: w.interrupted,
      lastActiveAt: w.lastActiveAt,
    }));
    this.settings.set("openWorkspaces", list);
  }

  private projectFolderExists(cwd: string): boolean {
    try {
      return statSync(cwd).isDirectory();
    } catch {
      return false;
    }
  }

  private async deleteWorkspaceArtifacts(workspace: Workspace, sessionPath?: string): Promise<void> {
    deleteManagedAttachments(managedAttachmentPaths(workspace.log.items));
    workspace.log.delete();
    if (sessionPath) {
      await this.adapter.deleteSession?.(sessionPath).catch((err: Error) => {
        console.error("[pi-host] failed to delete session file:", err.message);
      });
    }
  }

  private async deleteSavedWorkspaceArtifacts(saved: SavedWorkspace): Promise<void> {
    if (saved.chatId) {
      const log = new ChatLog(saved.chatId);
      deleteManagedAttachments(managedAttachmentPaths(log.items));
      log.delete();
    }
    if (saved.sessionPath) {
      await this.adapter.deleteSession?.(saved.sessionPath).catch((err: Error) => {
        console.error("[pi-host] failed to delete session file:", err.message);
      });
    }
  }

  /** Abort active generations without deleting their chats, used before the
   *  native shell exits so reopened chats resume from a stable transcript. */
  private async pauseStreamingWorkspaces(): Promise<number> {
    const targets = [...this.workspaces.values()].filter(
      (workspace) => workspace.streaming || workspace.session.isStreaming,
    );
    await Promise.all(
      targets.map(async (workspace) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            workspace.session.abort(),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, PAUSE_STREAMING_TIMEOUT_MS);
            }),
          ]);
        } catch (err) {
          console.error("[pi-host] failed to pause streaming chat:", (err as Error).message);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    for (const workspace of targets) {
      workspace.streaming = false;
      workspace.interrupted = true;
    }
    if (targets.length > 0) this.pushWorkspaces();
    return targets.length;
  }

  /** Remove chats whose project folder no longer exists. */
  private async pruneMissingProjectWorkspaces(): Promise<void> {
    let savedChanged = false;
    let openChanged = false;

    const openChatIds = new Set([...this.workspaces.values()].map((workspace) => workspace.chatId));
    const saved = this.settings.get("openWorkspaces") ?? [];
    const kept: SavedWorkspace[] = [];
    for (const workspace of saved) {
      if (
        workspace.defaultWorkspace ||
        !workspace.cwd ||
        this.projectFolderExists(workspace.cwd) ||
        (workspace.chatId && openChatIds.has(workspace.chatId))
      ) {
        kept.push(workspace);
      } else {
        savedChanged = true;
        await this.deleteSavedWorkspaceArtifacts(workspace);
      }
    }
    if (savedChanged) this.settings.set("openWorkspaces", kept);

    for (const [sessionId, workspace] of [...this.workspaces.entries()]) {
      if (workspace.defaultWorkspace || !workspace.cwd || this.projectFolderExists(workspace.cwd)) continue;
      const sessionPath = workspace.session.path;
      workspace.unsubscribe();
      await workspace.session.dispose().catch(() => {});
      this.workspaces.delete(sessionId);
      await this.deleteWorkspaceArtifacts(workspace, sessionPath);
      openChanged = true;
    }

    const goals = { ...(this.settings.get("projectGoals") ?? {}) };
    let goalsChanged = false;
    for (const cwd of Object.keys(goals)) {
      if (!this.projectFolderExists(cwd)) {
        delete goals[cwd];
        goalsChanged = true;
      }
    }
    if (goalsChanged) {
      this.settings.set("projectGoals", Object.keys(goals).length > 0 ? goals : undefined);
    }

    if (openChanged) this.pushWorkspaces();
  }

  /* ------------------------------- UI bridge ------------------------------ */

  private requestUi(
    request: UiRequest,
    sessionId?: string,
    timeoutMs = 120_000,
  ): Promise<unknown> {
    if (this.clients.size === 0) return Promise.resolve(undefined);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      // Safety net: never wedge the agent on an unanswered dialog.
      const timer = setTimeout(() => {
        this.pendingUi.delete(requestId);
        resolve(undefined);
      }, timeoutMs);
      this.pendingUi.set(requestId, (value) => {
        clearTimeout(timer);
        this.pendingUi.delete(requestId);
        resolve(value);
      });
      this.broadcast({ kind: "ui_request", requestId, sessionId, request });
    });
  }

  private readonly uiBridge: UiBridge = {
    confirm: async (title, message) =>
      (await this.requestUi({ method: "confirm", title, message })) === true,
    select: async (title, options) => {
      const v = await this.requestUi({ method: "select", title, options });
      return typeof v === "string" ? v : undefined;
    },
    input: async (title, placeholder) => {
      const v = await this.requestUi({ method: "input", title, placeholder });
      return typeof v === "string" ? v : undefined;
    },
    notify: (message, level) => {
      void this.requestUi({ method: "notify", title: message, level });
    },
    setStatus: () => {},
  };

  /* -------------------------------- lifecycle ----------------------------- */

  async start(port: number): Promise<void> {
    this.adapter = await createAdapter(this.settings.get("adapter"));
    await this.adapter.initialize({ ui: this.uiBridge });

    // Neutral custom tools available to every mode that allowlists them.
    if (this.adapter.capabilities.supportsCustomTools) {
      this.registerTool(createWebSearchTool(this.settings));
      // Model → user questions: 10 min to answer before the agent moves on.
      this.registerTool(
        createAskUserTool((request, sessionId) => this.requestUi(request, sessionId, 600_000)),
      );
      // Progress tracking: the model publishes its todo list to the UI.
      this.registerTool(createTodoTool());

      // File access and shell as neutral host tools (replacing harness
      // built-ins of the same name): every adapter gets the same toolset,
      // arg shapes, and permission interception path. Modes still gate them
      // via their SessionConfig.tools allowlists.
      for (const tool of createFileTools()) this.registerTool(tool);
      this.registerTool(createShellTool());

      // Plan & deepsearch as delegable subagent tools (forced via @mentions).
      const run = this.runSubagent.bind(this);
      this.registerTool(createPlanTool(run));
      this.registerTool(createDeepsearchTool(run));

      // Official vendor CLIs as subagents: work runs through Claude Code /
      // Codex, so it bills against the user's subscription plan. Gated by the
      // per-provider "official CLI" toggles in Settings → Providers.
      this.registerTool(createClaudeCodeTool(() => this.cliEnabled("anthropic")));
      this.registerTool(createCodexTool(() => this.cliEnabled("openai")));

      // MCP bridge: host-core implementation over neutral registerTool(),
      // unless the adapter brings its own. Connect in the BACKGROUND — a slow or
      // unreachable server (e.g. a Studio proxy waiting to attach) must not hold
      // up host startup / the app's loading screen. Tools register as each
      // server comes up; chats opened afterwards pick them up.
      if (!this.adapter.mcp) {
        this.mcpService = new McpService((tool) => this.registerTool(tool));
        void this.mcpService.start().catch((err) => {
          console.error("[pi-host] MCP startup error:", (err as Error).message);
        });
      }
    }

    // Single global interceptor: routes to the owning workspace's policy engine.
    if (this.adapter.capabilities.supportsToolCallInterception) {
      this.adapter.registerToolCallInterceptor((toolName, input, sessionId) => {
        const workspace = this.workspaces.get(sessionId);
        if (workspace) return workspace.policy.evaluate(toolName, input);
        // Subagent sessions run constrained read-only toolsets; the parent
        // chat's policy already gated the plan/deepsearch call itself.
        return this.subagentSessions.has(sessionId) ? "allow" : "ask";
      });
    }

    await this.pruneMissingProjectWorkspaces();

    // Restore the chats that were open when the host last ran. Native session
    // files only resume on the harness that wrote them; otherwise the chat
    // reopens fresh and its transcript comes from the neutral chat log.
    for (const saved of this.settings.get("openWorkspaces") ?? []) {
      const sameAdapter = !saved.adapter || saved.adapter === this.adapter.capabilities.id;
      const resume = sameAdapter ? saved.sessionPath : undefined;
      try {
        const info = await this.openWorkspace(
          saved.cwd,
          saved.mode,
          resume,
          saved.chatId,
          undefined,
          saved.goal,
          saved.disabledTools,
          saved.defaultWorkspace,
        );
        const w = this.workspace(info.sessionId);
        if (saved.name) w.name = saved.name;
        w.interrupted = saved.interrupted ?? false;
        if (saved.lastActiveAt) w.lastActiveAt = saved.lastActiveAt;
      } catch {
        // Session file gone or unreadable — reopen the chat fresh.
        try {
          const info = await this.openWorkspace(
            saved.cwd,
            saved.mode,
            undefined,
            saved.chatId,
            undefined,
            saved.goal,
            saved.disabledTools,
            saved.defaultWorkspace,
          );
          const w = this.workspace(info.sessionId);
          if (saved.name) w.name = saved.name;
          w.interrupted = saved.interrupted ?? false;
          if (saved.lastActiveAt) w.lastActiveAt = saved.lastActiveAt;
        } catch (err) {
          console.error("[pi-host] failed to restore workspace:", err);
        }
      }
    }

    this.missingProjectCleanupTimer ??= setInterval(
      () => void this.pruneMissingProjectWorkspaces().catch((err) => {
        console.error("[pi-host] missing project cleanup failed:", (err as Error).message);
      }),
      5 * 60_000,
    );
    this.missingProjectCleanupTimer.unref?.();

    const wss = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        reject(new Error(`Failed to start server on port ${port}. Is it already in use?`, { cause: err }));
      };
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.off("error", onError);
        resolve();
      });
    });
    wss.on("error", (err) => {
      console.error("[pi-host] websocket server error:", err.message);
    });
    wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.send(
        JSON.stringify({
          kind: "hello",
          capabilities: this.capabilities,
          workspaces: this.workspaceList(),
        } satisfies HostMessage),
      );
      ws.on("message", (raw) => void this.onMessage(ws, raw.toString()));
      ws.on("close", () => this.clients.delete(ws));
      // First client of this host run: validate subscription logins now that
      // there is a UI to show the "expired" dialog on.
      void this.checkSubscriptionsOnce();
    });
    console.log(`[pi-host] adapter=${this.adapter.capabilities.id} listening on ws://127.0.0.1:${port}`);
  }

  /* -------------------------------- commands ------------------------------ */

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let command: ClientCommand;
    try {
      command = JSON.parse(raw) as ClientCommand;
    } catch {
      return;
    }
    if (command.type === "ui_response") {
      this.pendingUi.get(command.requestId)?.(command.value);
      return;
    }
    const reply = (message: HostMessage) => ws.send(JSON.stringify(message));
    try {
      const result = await this.execute(command);
      reply({ kind: "response", id: command.id, ok: true, result });
    } catch (err) {
      reply({ kind: "response", id: command.id, ok: false, error: (err as Error).message });
    }
  }

  private workspace(sessionId: string): Workspace {
    const workspace = this.workspaces.get(sessionId);
    if (!workspace) throw new Error(`Unknown session: ${sessionId}`);
    return workspace;
  }

  private async openWorkspace(
    cwd: string | undefined,
    mode: ModeId,
    resumeSession?: string,
    chatId?: string,
    policyOverride?: PermissionPolicyConfig,
    goal?: string,
    disabledTools?: string[],
    defaultWorkspaceOverride?: boolean,
  ): Promise<WorkspaceInfo> {
    const isDefaultWorkspace = defaultWorkspaceOverride ?? cwd === undefined;
    const effectiveCwd = isDefaultWorkspace ? (cwd ?? defaultWorkspaceDir()) : cwd;
    // Carry the existing policy across (e.g. a mode switch); otherwise use the
    // saved default (composer bar / Settings), falling back to "ask".
    const defaultPolicy: PermissionPolicyConfig = isDefaultWorkspace
      ? { mode: "deny-all-mutation" }
      : (policyOverride ?? this.settings.get("defaultPermissionPolicy") ?? { mode: "ask" });
    const config = sessionConfigForMode(mode, effectiveCwd, defaultPolicy);
    if (effectiveCwd) config.cwd = effectiveCwd;
    if (isDefaultWorkspace) config.inMemory = true;
    // MCP proxy tools are hidden from the user but still usable by the model:
    // their dynamic names (mcp__<server>__<tool>) can't sit in a static per-mode
    // allowlist, so append the registered ones here. Skipped in plan mode to
    // preserve its read-only guarantee.
    if (mode !== "plan" && config.tools && this.mcpToolNames.size > 0) {
      // Only include tools from configured, enabled MCP servers — the model
      // shouldn't know about a server the user turned off or removed.
      const active = this.mcpService ? [...this.mcpService.activeToolNames()] : [...this.mcpToolNames];
      config.tools = [...config.tools, ...active];
    }
    // Per-chat / default tool allow-list: drop any tool the user disabled (chat
    // override wins over the Settings default).
    const disabled = new Set(disabledTools ?? this.settings.get("disabledTools") ?? []);
    if (disabled.size > 0 && config.tools) {
      config.tools = config.tools.filter((name) => !disabled.has(name));
    }
    // Saved default model (Settings → defaultModel) applies to new sessions.
    const defaultModel = this.currentOfficialCliModel(this.settings.get("defaultModel"));
    if (defaultModel && !this.usesOfficialCli(defaultModel)) config.model = defaultModel;
    // System prompt precedence: mode prompt (Plan/Deepsearch — they define
    // the mode) > user's global prompt (Settings) > pi-desktop's default.
    if (!config.systemPromptOverride) {
      const globalPrompt = this.settings.get("globalSystemPrompt")?.trim();
      config.systemPromptOverride = globalPrompt || DEFAULT_SYSTEM_PROMPT;
    }
    // Project goal (set from a project's right-click menu): a standing goal for
    // every chat opened in this folder, appended to the system prompt.
    if (isDefaultWorkspace && effectiveCwd) {
      config.systemPromptOverride =
        (config.systemPromptOverride ?? "") + `\n\n${defaultWorkspacePrompt(effectiveCwd)}`;
    }
    const projectGoal =
      effectiveCwd && !isDefaultWorkspace
        ? this.settings.get("projectGoals")?.[effectiveCwd]?.trim()
        : undefined;
    if (projectGoal) {
      config.systemPromptOverride =
        (config.systemPromptOverride ?? "") +
        `\n\n<project_goal>\nStanding goal for this project — keep working toward it ` +
        `unless the user says otherwise:\n${projectGoal}\n</project_goal>`;
    }
    // No native session to resume (folderless/in-memory chats, or a chat written
    // by a different adapter): the fresh session would start with no memory of
    // the conversation even though we still show its transcript. Replay the
    // neutral chat log into the system prompt so the model keeps context.
    if (!resumeSession && chatId) {
      const history = transcriptContext(new ChatLog(chatId).items);
      if (history) {
        config.systemPromptOverride =
          (config.systemPromptOverride ?? "") +
          `\n\n<conversation_history>\nThis chat continues an earlier conversation from ` +
          `before the app restarted. The messages below are that prior context — treat them ` +
          `as already said and continue naturally.\n\n${history}\n</conversation_history>`;
      }
    }
    if (resumeSession && !isDefaultWorkspace) {
      config.resumeSession = resumeSession;
      config.inMemory = false;
    }
    const session = await this.adapter.createSession(config);
    // Apply the saved default reasoning effort (home/Settings picker) to brand-
    // new sessions; resumed chats keep their own saved level. Adapters clamp to
    // what the model supports.
    if (!resumeSession) {
      const defaultThinking = this.settings.get("defaultThinking");
      if (defaultThinking && session.setThinkingLevel) {
        await session.setThinkingLevel(defaultThinking).catch(() => {});
      }
    }
    const id = chatId ?? randomUUID();
    const workspace: Workspace = {
      session,
      mode,
      cwd: effectiveCwd,
      defaultWorkspace: isDefaultWorkspace,
      policy: new PermissionPolicyEngine(
        config.permissionPolicy ?? defaultPolicy,
        () => this.settings.get("readOnlyAllowedTools") ?? this.defaultReadOnlyAllowedTools(),
      ),
      unsubscribe: () => {},
      streaming: false,
      lastActiveAt: Date.now(),
      interrupted: false,
      chatId: id,
      model: defaultModel,
      goal,
      disabledTools,
      log: new ChatLog(id),
      toolLogIndex: new Map(),
    };
    workspace.unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") {
        workspace.streaming = true;
        workspace.lastActiveAt = Date.now();
      }
      if (event.type === "agent_end") {
        workspace.streaming = false;
        workspace.interrupted = Boolean(event.aborted || event.errorMessage);
      }
      // Mirror the conversation into the neutral chat log (§7.1): this is what
      // makes transcripts survive restarts and harness switches.
      if (event.type === "message_end" && event.role === "assistant" && event.text.trim()) {
        workspace.log.append({ role: "assistant", text: event.text, usage: event.usage });
      }
      if (event.type === "tool_execution_start") {
        workspace.toolLogIndex.set(
          event.toolCallId,
          workspace.log.append({
            role: "tool",
            text: "",
            toolName: event.toolName,
            args: event.args,
          }),
        );
      }
      if (event.type === "tool_execution_end") {
        const index = workspace.toolLogIndex.get(event.toolCallId);
        if (index !== undefined) {
          workspace.log.update(index, {
            text: toolResultText(event.result),
            isError: event.isError,
          });
        }
      }
      this.broadcast({ kind: "event", sessionId: session.id, event });
      if (event.type === "agent_start" || event.type === "agent_end") this.pushWorkspaces();
    });
    this.workspaces.set(session.id, workspace);
    this.pushWorkspaces();
    return {
      sessionId: session.id,
      chatId: id,
      cwd: effectiveCwd,
      defaultWorkspace: isDefaultWorkspace,
      mode,
      isStreaming: false,
      interrupted: false,
    };
  }

  private async promptWorkspace(workspace: Workspace, text: string): Promise<void> {
    const vendor = workspace.model ? this.cliVendorForProvider(workspace.model.provider) : undefined;
    if (vendor && this.cliEnabled(vendor)) {
      await this.promptOfficialCli(workspace, vendor, this.withGoal(workspace, text));
      return;
    }
    await workspace.session.prompt(this.withToolDirectives(this.withGoal(workspace, text)));
  }

  private async promptOfficialCli(
    workspace: Workspace,
    vendor: "anthropic" | "openai",
    task: string,
  ): Promise<void> {
    const cwd = workspace.cwd ?? defaultWorkspaceDir();
    const readOnly = workspace.defaultWorkspace === true;
    const cliTask =
      readOnly ? `${defaultWorkspacePrompt(cwd)}\n\nUser request:\n${task}` : task;
    const toolName = vendor === "anthropic" ? "claude_code" : "codex";
    const tool = this.toolDefinitions.get(toolName);
    if (!tool) throw new Error(`${toolName} tool is not available`);

    const sessionId = workspace.session.id;
    workspace.streaming = true;
    workspace.interrupted = false;
    workspace.lastActiveAt = Date.now();
    this.broadcast({ kind: "event", sessionId, event: { type: "agent_start" } });
    this.broadcast({ kind: "event", sessionId, event: { type: "message_start", role: "assistant" } });
    this.pushWorkspaces();

    try {
      const result = await tool.execute(
        {
          task: cliTask,
          readOnly,
          modelId: workspace.model?.modelId,
          ...(vendor === "anthropic" ? { continueSession: true } : {}),
        },
        undefined,
        (partial) => {
          const delta = partial.content.map((c) => c.text).join("\n").trim();
          if (!delta) return;
          this.broadcast({
            kind: "event",
            sessionId,
            event: { type: "message_update", delta: { kind: "text", delta } },
          });
        },
        { cwd, sessionId },
      );
      const output = result.content.map((c) => c.text).join("\n").trim();
      if (result.isError) throw new Error(output || `${toolName} failed`);
      workspace.log.append({ role: "assistant", text: output });
      this.broadcast({
        kind: "event",
        sessionId,
        event: { type: "message_end", role: "assistant", text: output },
      });
      workspace.streaming = false;
      workspace.interrupted = false;
      this.broadcast({ kind: "event", sessionId, event: { type: "agent_end" } });
    } catch (err) {
      workspace.streaming = false;
      workspace.interrupted = true;
      this.broadcast({
        kind: "event",
        sessionId,
        event: { type: "agent_end", errorMessage: (err as Error).message },
      });
      throw err;
    } finally {
      this.pushWorkspaces();
    }
  }

  /** Replace a workspace's session (mode switch or folder link), keeping its name. */
  private async replaceWorkspace(
    sessionId: string,
    mode: ModeId | undefined,
    cwd: string | undefined,
  ): Promise<WorkspaceInfo> {
    const old = this.workspace(sessionId);
    const oldPath = old.session.path;
    // Keep the chat id so the neutral transcript follows the chat.
    const info = await this.openWorkspace(
      cwd ?? old.cwd,
      mode ?? old.mode,
      undefined,
      old.chatId,
      old.policy.policy,
      old.goal,
      old.disabledTools,
      cwd === undefined ? old.defaultWorkspace : false,
    );
    const replacement = this.workspace(info.sessionId);
    replacement.name = old.name;
    replacement.interrupted = old.interrupted;
    replacement.contextWindow = old.contextWindow;
    if (old.contextWindow && replacement.session.setContextWindow) {
      await replacement.session.setContextWindow(old.contextWindow).catch(() => {});
    }
    old.unsubscribe();
    await old.session.dispose();
    this.workspaces.delete(sessionId);
    // The replaced session is unreachable from the UI — remove its file too.
    if (oldPath) {
      await this.adapter.deleteSession?.(oldPath).catch(() => {});
    }
    this.broadcast({
      kind: "event",
      sessionId,
      event: { type: "session_replaced", newSessionId: info.sessionId },
    });
    this.pushWorkspaces();
    return { ...info, name: old.name, interrupted: old.interrupted };
  }

  /** Recreate open chats so MCP tool additions/removals are reflected in the
   *  model's tool context immediately instead of waiting for a new chat. */
  private async refreshMcpToolsInWorkspaces(): Promise<void> {
    for (const sessionId of [...this.workspaces.keys()]) {
      // The workspace may already have been replaced or closed by an earlier
      // iteration / client action.
      if (!this.workspaces.has(sessionId)) continue;
      await this.replaceWorkspace(sessionId, undefined, undefined);
    }
  }

  private async execute(command: ClientCommand): Promise<unknown> {
    switch (command.type) {
      case "get_capabilities":
        return this.capabilities;
      case "list_workspaces":
        return this.workspaceList();
      case "open_workspace":
        return this.openWorkspace(command.cwd, command.mode);
      case "open_session":
        // Resume a persisted session (§7.1) as a new workspace.
        return this.openWorkspace(command.cwd, command.mode ?? "code", command.path);
      case "compact": {
        const { session } = this.workspace(command.sessionId);
        if (!session.compact) throw new Error("Adapter does not support compaction");
        await session.compact();
        return null;
      }
      case "list_dir": {
        // Lazy file-tree support (§7.5). Local trusted app: no path jail.
        const entries: DirEntry[] = readdirSync(command.path, { withFileTypes: true })
          .filter((e) => e.name !== ".git" && e.name !== "node_modules")
          .map((e) => ({ name: e.name, dir: e.isDirectory() }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
        return entries;
      }
      case "search_files":
        // Recursive @-mention lookup: finds README.md however deep it lives.
        return searchFiles(command.cwd, command.query, 10);
      case "save_attachment": {
        // Pasted/dropped data without a path (e.g. clipboard screenshots):
        // persist it so the session's read tool can reference it.
        mkdirSync(ATTACHMENTS_DIR, { recursive: true });
        const safe = command.name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
        const path = join(ATTACHMENTS_DIR, `${Date.now()}-${safe}`);
        writeFileSync(path, Buffer.from(command.dataBase64, "base64"));
        return path;
      }
      case "read_file_base64": {
        // Small reads for attachment previews (image thumbnails).
        if (statSync(command.path).size > 8_000_000) {
          throw new Error("File too large to preview");
        }
        return readFileSync(command.path).toString("base64");
      }
      case "open_path":
        await openWithDefaultApp(command.path);
        return null;
      case "read_project_prompt": {
        // Project system prompt = AGENTS.md in the project root (pi-native;
        // the harness picks it up automatically for sessions in that cwd).
        const path = join(command.cwd, "AGENTS.md");
        return existsSync(path) ? readFileSync(path, "utf8") : "";
      }
      case "write_project_prompt": {
        writeFileSync(join(command.cwd, "AGENTS.md"), command.content, "utf8");
        return null;
      }
      case "set_project_goal": {
        // Standing goal for a project folder — injected into the system prompt
        // of chats opened in that folder (see openWorkspace).
        const goals = { ...(this.settings.get("projectGoals") ?? {}) };
        const goal = command.goal?.trim();
        if (goal) goals[command.cwd] = goal;
        else delete goals[command.cwd];
        this.settings.set("projectGoals", Object.keys(goals).length > 0 ? goals : undefined);
        return null;
      }
      case "pause_streaming":
        return this.pauseStreamingWorkspaces();
      case "close_workspace": {
        const workspace = this.workspace(command.sessionId);
        const sessionPath = workspace.session.path;
        workspace.unsubscribe();
        await workspace.session.dispose();
        this.workspaces.delete(command.sessionId);
        // Deleting a chat deletes its transcript, managed attachments, and session file too.
        await this.deleteWorkspaceArtifacts(workspace, sessionPath);
        this.pushWorkspaces();
        return null;
      }
      case "prompt": {
        const workspace = this.workspace(command.sessionId);
        workspace.log.append({ role: "user", text: command.text });
        await this.promptWorkspace(workspace, command.text);
        return null;
      }
      case "edit_prompt": {
        // An edited message replaces itself and everything after it. Trim the
        // neutral chat log to the edit point so a reopened chat doesn't show the
        // discarded messages alongside the new ones (the log is what a fresh
        // in-memory session restores from).
        const workspace = this.workspace(command.sessionId);
        const attachmentsBefore = new Set(managedAttachmentPaths(workspace.log.items));
        workspace.log.truncateToUserMessage(command.keepUserMessages);
        workspace.log.append({ role: "user", text: command.text });
        const attachmentsAfter = new Set(managedAttachmentPaths(workspace.log.items));
        deleteManagedAttachments([...attachmentsBefore].filter((path) => !attachmentsAfter.has(path)));
        await this.promptWorkspace(workspace, command.text);
        return null;
      }
      case "list_tools": {
        // Subagent tools lead the list (and thus the @ autocomplete);
        // everything else follows alphabetically. CLI tools disabled in
        // Settings are hidden entirely.
        const featured = ["plan", "deepsearch", "claude_code", "codex"];
        const rank = (name: string) => {
          const index = featured.indexOf(name);
          return index === -1 ? featured.length : index;
        };
        return this.tools
          .filter(
            (t) =>
              (t.name !== "claude_code" || this.cliEnabled("anthropic")) &&
              (t.name !== "codex" || this.cliEnabled("openai")),
          )
          .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
      }
      case "abort":
        await this.workspace(command.sessionId).session.abort();
        return null;
      case "set_mode":
        // Mode switch = session replacement (§7.2), not live mutation.
        return this.replaceWorkspace(command.sessionId, command.mode, undefined);
      case "rename_workspace": {
        this.workspace(command.sessionId).name = command.name.trim() || undefined;
        this.pushWorkspaces();
        return null;
      }
      case "link_workspace":
        // Bind an existing chat to a folder = session replacement with a cwd.
        return this.replaceWorkspace(command.sessionId, undefined, command.cwd);
      case "set_model": {
        const workspace = this.workspace(command.sessionId);
        const { session } = workspace;
        const model = this.currentOfficialCliModel({
          provider: command.provider,
          modelId: command.modelId,
        })!;
        workspace.model = model;
        if (this.usesOfficialCli(model)) {
          this.pushWorkspaces();
          return null;
        }
        if (!session.setModel) throw new Error("Adapter does not support model switching");
        await session.setModel(command.provider, command.modelId);
        // A model switch replaces the model object — re-apply the chat's
        // context override so it sticks across switches.
        if (workspace.contextWindow && session.setContextWindow) {
          await session.setContextWindow(workspace.contextWindow);
        }
        return null;
      }
      case "set_context_window": {
        const workspace = this.workspace(command.sessionId);
        if (!workspace.session.setContextWindow) {
          throw new Error("Adapter does not support per-chat context windows");
        }
        await workspace.session.setContextWindow(command.tokens);
        workspace.contextWindow = command.tokens;
        this.pushWorkspaces();
        return null;
      }
      case "set_goal": {
        const workspace = this.workspace(command.sessionId);
        workspace.goal = command.goal?.trim() || undefined;
        // Re-announce on the next prompt (even if the text is unchanged, the
        // model should hear a cleared/updated goal).
        workspace.goalAnnounced = undefined;
        this.pushWorkspaces();
        return null;
      }
      case "set_disabled_tools": {
        // Rebuild the session so the new tool set takes effect immediately;
        // persistent chats resume from their file, so context is preserved.
        const workspace = this.workspace(command.sessionId);
        workspace.disabledTools = command.tools.length > 0 ? [...command.tools] : undefined;
        return this.replaceWorkspace(command.sessionId, undefined, undefined);
      }
      case "set_thinking_level": {
        const { session } = this.workspace(command.sessionId);
        if (!session.setThinkingLevel) {
          throw new Error("Adapter does not support thinking levels");
        }
        await session.setThinkingLevel(command.level);
        // Return the effective state — adapters clamp unsupported levels.
        return session.getThinking ? session.getThinking() : null;
      }
      case "get_thinking": {
        const { session } = this.workspace(command.sessionId);
        return session.getThinking ? session.getThinking() : null;
      }
      case "get_history": {
        const workspace = this.workspace(command.sessionId);
        // Native history has the most fidelity; the neutral chat log covers
        // in-memory chats and sessions from a different harness. Merge them so
        // a mid-response app close cannot reopen with the first user prompt
        // missing just because the adapter restored a partial assistant state.
        const native = workspace.session.history ? await workspace.session.history() : [];
        return mergeNativeAndNeutralHistory(native, workspace.log.items);
      }
      case "get_permission_policy":
        return this.workspace(command.sessionId).policy.policy;
      case "set_permission_policy":
        this.workspace(command.sessionId).policy.policy = command.policy;
        return null;
      case "deepsearch_query": {
        const workspace = this.workspace(command.sessionId);
        workspace.log.append({ role: "user", text: command.query });
        await workspace.session.prompt(deepsearchPromptTemplate(command.query));
        return null;
      }
      case "list_providers":
        return this.requireProviders().listProviders();
      case "list_oauth_providers": {
        const providers = this.requireProviders();
        return providers.listOAuthProviders ? providers.listOAuthProviders() : [];
      }
      case "test_provider":
        return this.testProvider(command.providerId);
      case "subscription_usage": {
        const providers = this.requireProviders();
        return providers.getSubscriptionUsage
          ? providers.getSubscriptionUsage(command.providerId).catch(() => null)
          : null;
      }
      case "oauth_login": {
        const providers = this.requireProviders();
        if (!providers.oauthLogin) {
          throw new Error("Adapter does not support subscription login");
        }
        await providers.oauthLogin(command.providerId);
        return null;
      }
      case "add_provider":
        return this.requireProviders().addProvider(command.providerId, command.apiKey, command.config);
      case "remove_provider":
        return this.requireProviders().removeProvider(command.providerId);
      case "list_models":
        return this.requireProviders().getAvailableModels();
      case "add_model": {
        const providers = this.requireProviders();
        if (!providers.addModel) throw new Error("Adapter does not support adding custom models");
        // Custom models added without a context window get the global default.
        const fallback = this.settings.get("defaultContextWindow");
        const def =
          command.def.contextWindow || !fallback
            ? command.def
            : { ...command.def, contextWindow: fallback };
        return providers.addModel(def);
      }
      case "update_model": {
        const providers = this.requireProviders();
        if (!providers.updateModel) throw new Error("Adapter does not support editing models");
        return providers.updateModel(command.provider, command.modelId, command.patch);
      }
      case "list_skills":
        return this.requireSkills().list(command.cwd);
      case "install_skill":
        return this.requireSkills().install(command.source, command.scope, command.cwd);
      case "remove_skill":
        return this.requireSkills().remove(command.path, command.cwd);
      case "list_skill_sources":
        return this.requireSkills().listSources();
      case "add_skill_source":
        return this.requireSkills().addSource(command.path);
      case "remove_skill_source":
        return this.requireSkills().removeSource(command.path);
      case "remove_model": {
        const providers = this.requireProviders();
        if (!providers.removeModel) {
          throw new Error("Adapter does not support removing custom models");
        }
        return providers.removeModel(command.provider, command.modelId);
      }
      case "list_sessions":
        return this.adapter.listSessions(command.cwd);
      case "list_mcp_servers":
      case "mcp_server_status":
        return this.mcp.list();
      case "add_mcp_server":
        await this.mcp.add(command.config);
        await this.refreshMcpToolsInWorkspaces();
        return null;
      case "remove_mcp_server":
        await this.mcp.remove(command.name);
        await this.refreshMcpToolsInWorkspaces();
        return null;
      case "set_mcp_server_enabled":
        await this.mcp.setEnabled(command.name, command.enabled);
        await this.refreshMcpToolsInWorkspaces();
        return null;
      case "plugin_list":
        return this.requirePlugins().list();
      case "plugin_install":
        return this.requirePlugins().install(command.source);
      case "plugin_remove":
        return this.requirePlugins().remove(command.source);
      case "plugin_update":
        return this.requirePlugins().update(command.source);
      case "get_settings":
        return this.settings.all;
      case "set_setting": {
        this.settings.set(command.key, command.value);
        if (command.key === "searxngUrl" && typeof command.value === "string") {
          return testSearxng(command.value);
        }
        return null;
      }
      default:
        throw new Error(`Unknown command: ${(command as { type: string }).type}`);
    }
  }

  private requireProviders() {
    if (!this.adapter.providers) throw new Error("Adapter does not support provider management");
    return this.adapter.providers;
  }

  private requirePlugins() {
    if (!this.adapter.plugins) throw new Error("Adapter does not support plugins");
    return this.adapter.plugins;
  }

  private requireSkills() {
    if (!this.adapter.skills) throw new Error("Adapter does not support skills");
    return this.adapter.skills;
  }
}

const port = Number(process.env.PI_DESKTOP_PORT ?? DEFAULT_HOST_PORT);
const server = new HostServer();
server.start(port).catch((err) => {
  console.error("[pi-host] fatal:", err);
  process.exit(1);
});
