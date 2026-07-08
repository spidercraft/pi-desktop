/**
 * PiAdapter — the ONLY pi-aware code in the app (§1).
 *
 * Implements the neutral HarnessAdapter against pi's in-process SDK
 * (createAgentSession, DefaultResourceLoader, SessionManager, AuthStorage,
 * ModelRegistry) and translates pi's native event/tool shapes into the
 * neutral vocabulary from @pi-desktop/harness-sdk.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  VERSION,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AdapterInitOptions,
  CustomModelDef,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  HarnessSession,
  HistoryItem,
  ModelInfo,
  ModelPatch,
  NeutralToolDefinition,
  NeutralToolResult,
  OAuthProviderInfo,
  ProviderConfig,
  ProviderInfo,
  ProviderManager,
  SessionConfig,
  SessionSummary,
  SubscriptionStatus,
  SubscriptionUsage,
  ThinkingInfo,
  ThinkingLevel,
  ToolCallInterceptor,
  ToolExecutionContext,
  UiBridge,
} from "@pi-desktop/harness-sdk";
import { PiPluginManager } from "./cli-bridge.js";
import { createPermissionBridge } from "./extensions/permission-bridge.js";
import { PiSkillManager } from "./skills.js";

export interface PiAdapterOptions {
  /** Override pi's global config dir (~/.pi/agent). Used by tests. */
  agentDir?: string;
}

/* ----------------------------- event translation -------------------------- */

function extractText(message: unknown): { role: string; text: string } {
  const m = message as { role?: string; content?: unknown };
  const role = typeof m?.role === "string" ? m.role : "assistant";
  let text = "";
  if (typeof m?.content === "string") {
    text = m.content;
  } else if (Array.isArray(m?.content)) {
    text = m.content
      .filter((c: { type?: string }) => c?.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("");
  }
  return { role, text };
}

function translateEvent(event: AgentSessionEvent): HarnessEvent | undefined {
  switch (event.type) {
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end": {
      // pi encodes failures in the final assistant message (stopReason
      // "error"/"aborted" + errorMessage) — surface them, don't drop them.
      const last = [...(event.messages ?? [])]
        .reverse()
        .find((m) => (m as { role?: string }).role === "assistant") as
        | { stopReason?: string; errorMessage?: string }
        | undefined;
      return {
        type: "agent_end",
        ...(last?.stopReason === "aborted" ? { aborted: true } : {}),
        ...(last?.stopReason === "error" && !event.willRetry
          ? { errorMessage: last.errorMessage ?? "Unknown provider error" }
          : {}),
      };
    }
    case "message_start":
      return { type: "message_start", role: extractText(event.message).role };
    case "message_update": {
      const e = event.assistantMessageEvent;
      switch (e.type) {
        case "text_delta":
          return { type: "message_update", delta: { kind: "text", delta: e.delta } };
        case "thinking_delta":
          return { type: "message_update", delta: { kind: "thinking", delta: e.delta } };
        case "toolcall_delta":
          return { type: "message_update", delta: { kind: "toolcall", delta: e.delta } };
        default:
          return undefined;
      }
    }
    case "message_end": {
      const { role, text } = extractText(event.message);
      const usage = (
        event.message as { usage?: { input?: number; output?: number; totalTokens?: number } }
      ).usage;
      return {
        type: "message_end",
        role,
        text,
        ...(usage
          ? {
              usage: {
                inputTokens: usage.input ?? 0,
                outputTokens: usage.output ?? 0,
                totalTokens: usage.totalTokens,
              },
            }
          : {}),
      };
    }
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    case "queue_update":
      return { type: "queue_update", steering: event.steering, followUp: event.followUp };
    case "compaction_start":
      return { type: "compaction_start" };
    case "compaction_end": {
      const result = event.result as
        | { tokensBefore?: number; estimatedTokensAfter?: number }
        | undefined;
      return {
        type: "compaction_end",
        errorMessage: event.errorMessage,
        tokensBefore: result?.tokensBefore,
        tokensAfter: result?.estimatedTokensAfter,
      };
    }
    default:
      return undefined;
  }
}

/* ------------------------------ tool translation --------------------------- */

function toPiTool(tool: NeutralToolDefinition, context: ToolExecutionContext): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    // Neutral tools carry plain JSON Schema; pi expects a TypeBox TSchema,
    // which is JSON Schema at runtime — safe structural cast.
    parameters: tool.parameters as never,
    async execute(_toolCallId, params, signal, onUpdate) {
      const partialForward = onUpdate
        ? (partial: NeutralToolResult) =>
            onUpdate({ content: partial.content, details: partial.details })
        : undefined;
      const result = await tool.execute(
        params as Record<string, unknown>,
        signal,
        partialForward,
        context,
      );
      // pi only marks a tool call as errored when execute() THROWS — an
      // isError field on a returned result is ignored (agent-core's
      // agent-loop hardcodes isError: false for returned results). Convert
      // neutral error results into throws so failures show as failures in
      // the UI, the session file, and to the model.
      if (result.isError) {
        throw new Error(
          result.content.map((c) => c.text).join("\n").trim() || `${tool.name} failed`,
        );
      }
      return {
        content: result.content,
        details: result.details,
      } as never;
    },
  } as ToolDefinition;
}

/* --------------------------------- session -------------------------------- */

class PiSession implements HarnessSession {
  readonly id = randomUUID();

  constructor(
    readonly config: SessionConfig,
    private readonly session: AgentSession,
  ) {}

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  /** Persistent session file (undefined for in-memory sessions). */
  get path(): string | undefined {
    return this.session.sessionManager.getSessionFile();
  }

  async prompt(text: string): Promise<void> {
    if (this.session.isStreaming) {
      await this.session.prompt(text, { streamingBehavior: "followUp" });
    } else {
      await this.session.prompt(text);
    }
  }

  async steer(text: string): Promise<void> {
    await this.session.steer(text);
  }

  async followUp(text: string): Promise<void> {
    await this.session.followUp(text);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  subscribe(listener: (event: HarnessEvent) => void): () => void {
    return this.session.subscribe((event) => {
      const translated = translateEvent(event);
      if (!translated) return;
      // Stamp the current model's context window onto usage-bearing events so
      // the UI can show context fill.
      if (translated.type === "message_end" && translated.usage) {
        const model = this.session.model as { contextWindow?: number } | undefined;
        translated.usage.contextWindow = model?.contextWindow;
      }
      listener(translated);
    });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.session.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
    await this.session.setModel(model);
  }

  /**
   * Per-chat context window override: swaps in a clone of the active model
   * with the given contextWindow. pi records model changes in the session
   * file, so the override survives resume. undefined restores the registry
   * definition (including any models.json override).
   */
  async setContextWindow(tokens?: number): Promise<void> {
    const model = this.session.model as
      | ({ provider: string; id: string } & Record<string, unknown>)
      | undefined;
    if (!model) throw new Error("No active model — pick a model first");
    const next = tokens
      ? { ...model, contextWindow: tokens }
      : this.session.modelRegistry.find(model.provider, model.id);
    if (!next) throw new Error(`Unknown model: ${model.provider}/${model.id}`);
    await this.session.setModel(next as never);
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    // pi clamps to the active model's supported levels internally.
    this.session.setThinkingLevel(level);
  }

  async getThinking(): Promise<ThinkingInfo> {
    return {
      level: this.session.thinkingLevel,
      available: this.session.getAvailableThinkingLevels(),
    };
  }

  async compact(): Promise<void> {
    await this.session.compact();
  }

  /** Past transcript (resumed sessions replay these): user/assistant text,
   *  completed tool calls, and token usage so context fill survives restarts. */
  async history(): Promise<HistoryItem[]> {
    const model = this.session.model as { contextWindow?: number } | undefined;
    const items: HistoryItem[] = [];
    /** toolCallId → index in items, to attach results to their calls. */
    const toolIndex = new Map<string, number>();

    for (const message of this.session.messages) {
      const m = message as {
        role?: string;
        content?: unknown;
        toolCallId?: string;
        isError?: boolean;
        usage?: { input?: number; output?: number; totalTokens?: number };
      };

      if (m.role === "toolResult") {
        const index = toolIndex.get(String(m.toolCallId));
        if (index !== undefined) {
          items[index] = {
            ...items[index],
            text: extractText(message).text,
            isError: m.isError === true,
          };
        }
        continue;
      }

      const { role, text } = extractText(message);
      if (role !== "user" && role !== "assistant") continue;

      if (text.trim().length > 0) {
        items.push({
          role,
          text,
          ...(role === "assistant" && m.usage
            ? {
                usage: {
                  inputTokens: m.usage.input ?? 0,
                  outputTokens: m.usage.output ?? 0,
                  totalTokens: m.usage.totalTokens,
                  contextWindow: model?.contextWindow,
                },
              }
            : {}),
        });
      }

      // Tool calls live as content blocks on assistant messages.
      if (role === "assistant" && Array.isArray(m.content)) {
        for (const block of m.content as Array<{
          type?: string;
          id?: string;
          name?: string;
          arguments?: unknown;
        }>) {
          if (block?.type === "toolCall") {
            toolIndex.set(String(block.id), items.length);
            items.push({ role: "tool", text: "", toolName: block.name, args: block.arguments });
          }
        }
      }
    }
    return items;
  }

  async dispose(): Promise<void> {
    this.session.dispose();
  }
}

/* -------------------------------- providers -------------------------------- */

/** Shape of pi's models.json (subset we write; see ModelsConfigSchema in pi). */
interface PiModelsJson {
  providers: Record<
    string,
    {
      name?: string;
      baseUrl?: string;
      api?: string;
      models?: Array<Record<string, unknown> & { id?: string }>;
      /** Per-model patches merged onto BUILT-IN models (pi's ModelOverrideSchema). */
      modelOverrides?: Record<string, Record<string, unknown>>;
      [key: string]: unknown;
    }
  >;
}

/** Vendor-only display name for subscription providers ("Anthropic", "OpenAI"). */
function subscriptionDisplayName(id: string, name: string): string {
  if (id === "anthropic") return "Anthropic";
  if (id === "openai-codex") return "OpenAI";
  return name.replace(/\s*\([^)]*\)\s*$/, "");
}

function modelDisplayName(model: { id: string; name?: string }): string {
  return (model.name ?? model.id).replace(/\s*\(latest\)\s*$/i, "");
}

function canonicalAnthropicAliasId(id: string): string {
  return id.replace(/-\d{8}$/, "").replace(/-0$/, "");
}

function isDatedAnthropicAliasDuplicate(
  model: { provider: string; id: string; name?: string },
  aliasKeys: Set<string>,
): boolean {
  if (model.provider !== "anthropic") return false;
  const aliasId = canonicalAnthropicAliasId(model.id);
  if (aliasId === model.id) return false;
  return aliasKeys.has(`${aliasId}:${modelDisplayName(model)}`);
}

/** Open a URL in the user's default browser without shell quoting pitfalls. */
function openExternal(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true }).unref();
    }
  } catch {
    /* best-effort — the URL is also shown in the dialog */
  }
}

type CodexAuthToken = { accessToken: string; accountId?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCodexCliAuthToken(): CodexAuthToken | undefined {
  const authPath = join(homedir(), ".codex", "auth.json");
  if (!existsSync(authPath)) return undefined;
  const data = asRecord(JSON.parse(readFileSync(authPath, "utf8")));
  const tokens = asRecord(data?.tokens) ?? data;
  const accessToken =
    typeof tokens?.access_token === "string"
      ? tokens.access_token
      : typeof tokens?.accessToken === "string"
        ? tokens.accessToken
        : undefined;
  if (!accessToken) return undefined;
  const accountId =
    typeof tokens?.account_id === "string"
      ? tokens.account_id
      : typeof tokens?.accountId === "string"
        ? tokens.accountId
        : undefined;
  return { accessToken, ...(accountId ? { accountId } : {}) };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function pct(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const percent = value <= 1 ? value * 100 : value;
  return clampPercent(percent);
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const n = pct(obj[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function rawNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function labelForUsageWindow(key: string, obj: Record<string, unknown>): string {
  const named = firstString(obj, ["label", "window", "window_label", "name", "type"]);
  const label = named ?? key;
  const normalized = label.toLowerCase().replace(/[_-]/g, " ");
  if (/\bprimary\b/.test(normalized)) return "5h";
  if (/\bsecondary\b/.test(normalized)) return "week";
  return label
    .replace(/rolling[_ -]?/, "")
    .replace(/five[_ -]?hour|5[_ -]?hour/i, "5h")
    .replace(/seven[_ -]?day|weekly|week/i, "week")
    .replace(/_/g, " ");
}

function parseCodexUsage(data: unknown): SubscriptionUsage | null {
  const windows: SubscriptionUsage["windows"] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, key = "usage"): void => {
    const obj = asRecord(value);
    if (!obj) return;

    let percent = firstNumber(obj, [
      "used_percent",
      "usedPercent",
      "usage_percent",
      "usagePercent",
      "percent_used",
      "percentUsed",
      "utilization",
    ]);
    if (percent === undefined) {
      const remainingPercent = firstNumber(obj, [
        "remaining_percent",
        "remainingPercent",
        "percent_remaining",
        "percentRemaining",
        "remaining_percentage",
        "remainingPercentage",
        "available_percent",
        "availablePercent",
        "percent_available",
        "percentAvailable",
        "free_percent",
        "freePercent",
        "percent_free",
        "percentFree",
        // Codex's WHAM endpoint uses a generic "percentage" field for quota
        // remaining/free in some windows, not for quota consumed.
        "percentage",
      ]);
      if (remainingPercent !== undefined) percent = clampPercent(100 - remainingPercent);
    }
    if (percent === undefined) {
      const used = rawNumber(obj, ["used", "current", "num_messages", "count"]);
      const remaining = rawNumber(obj, ["remaining", "available", "free"]);
      const limit = rawNumber(obj, ["limit", "quota", "max", "max_messages"]);
      if (used !== undefined && limit !== undefined && limit > 0) {
        percent = clampPercent((used / limit) * 100);
      } else if (remaining !== undefined && limit !== undefined && limit > 0) {
        percent = clampPercent((1 - remaining / limit) * 100);
      }
    }
    if (percent !== undefined) {
      const label = labelForUsageWindow(key, obj);
      const resetsAt = firstString(obj, [
        "resets_at",
        "resetsAt",
        "reset_at",
        "resetAt",
        "reset_time",
        "resetTime",
        "window_reset",
      ]);
      const id = `${label}:${resetsAt ?? ""}`;
      if (!seen.has(id)) {
        seen.add(id);
        windows.push({ label, usedPercent: percent, ...(resetsAt ? { resetsAt } : {}) });
      }
    }

    for (const [childKey, child] of Object.entries(obj)) {
      if (typeof child === "object" && child !== null) visit(child, childKey);
    }
  };
  visit(data);
  return windows.length > 0 ? { windows } : null;
}

async function fetchCodexUsage(token: CodexAuthToken): Promise<SubscriptionUsage | null> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token.accessToken}` };
  if (token.accountId) headers["ChatGPT-Account-ID"] = token.accountId;
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (!res.ok) return null;
  return parseCodexUsage(await res.json());
}

class PiProviderManager implements ProviderManager {
  constructor(
    private readonly auth: AuthStorage,
    private readonly registry: ModelRegistry,
    private readonly modelsPath: string,
    private readonly getUi: () => UiBridge | undefined,
  ) {}

  async listProviders(): Promise<ProviderInfo[]> {
    const withCredentials = new Set(this.auth.list());
    const known = new Set<string>(withCredentials);
    for (const model of this.registry.getAll()) {
      known.add((model as { provider: string }).provider);
    }
    // User-configured providers (models.json) show up even before they have
    // credentials or models.
    for (const id of Object.keys(this.readModelsJson()?.providers ?? {})) known.add(id);
    return [...known].sort().map((id) => {
      const credential = this.auth.get(id);
      return {
        id,
        hasCredentials: withCredentials.has(id),
        ...(credential ? { authType: credential.type } : {}),
      };
    });
  }

  /** Subscription providers pi ships. GitHub Copilot is deliberately
   *  excluded — this app doesn't offer it. pi's names carry plan suffixes
   *  ("Anthropic (Claude Pro/Max)") — show just the vendor. */
  async listOAuthProviders(): Promise<OAuthProviderInfo[]> {
    return this.auth
      .getOAuthProviders()
      .filter((p) => p.id !== "github-copilot")
      .map((p) => ({ id: p.id, name: subscriptionDisplayName(p.id, p.name) }));
  }

  /**
   * Plan usage. Anthropic exposes the endpoint Claude Code's /status uses.
   * Codex exposes similar ChatGPT subscription windows; prefer pi's refreshed
   * OAuth token, then fall back to the official Codex CLI login in ~/.codex.
   */
  async getSubscriptionUsage(providerId: string): Promise<SubscriptionUsage | null> {
    if (providerId === "openai-codex" || providerId === "openai") {
      const piToken =
        this.auth.get(providerId)?.type === "oauth"
          ? await this.auth.getApiKey(providerId).catch(() => undefined)
          : undefined;
      if (piToken) {
        const usage = await fetchCodexUsage({ accessToken: piToken }).catch(() => null);
        if (usage) return usage;
      }
      const cliToken = readCodexCliAuthToken();
      return cliToken ? fetchCodexUsage(cliToken).catch(() => null) : null;
    }

    if (providerId !== "anthropic") return null;
    if (this.auth.get("anthropic")?.type !== "oauth") return null;
    const token = await this.auth.getApiKey("anthropic").catch(() => undefined);
    if (!token) return null;

    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<
      string,
      { utilization?: number; resets_at?: string } | undefined
    >;

    const windowKeys: Array<[string, string]> = [
      ["five_hour", "5h"],
      ["seven_day", "week"],
      ["seven_day_opus", "week (Opus)"],
      ["seven_day_sonnet", "week (Sonnet)"],
    ];
    const windows = [];
    for (const [key, label] of windowKeys) {
      const w = data[key];
      if (w && typeof w.utilization === "number") {
        // Some responses report a fraction, some a percentage — normalize.
        const percent = w.utilization <= 1 ? w.utilization * 100 : w.utilization;
        windows.push({
          label,
          usedPercent: Math.min(100, Math.round(percent)),
          ...(w.resets_at ? { resetsAt: w.resets_at } : {}),
        });
      }
    }
    return windows.length > 0 ? { windows } : null;
  }

  /**
   * Validate stored subscription logins. getApiKey() transparently refreshes
   * an expired access token; when even the refresh fails (revoked/expired
   * refresh token), the login is dead and needs a fresh sign-in.
   */
  async checkSubscriptions(): Promise<SubscriptionStatus[]> {
    const names = new Map(
      this.auth
        .getOAuthProviders()
        .map((p) => [p.id, subscriptionDisplayName(p.id, p.name)] as const),
    );
    const results: SubscriptionStatus[] = [];
    for (const id of this.auth.list()) {
      if (this.auth.get(id)?.type !== "oauth") continue;
      let expired = false;
      try {
        expired = !(await this.auth.getApiKey(id));
      } catch {
        expired = true;
      }
      results.push({ id, name: names.get(id) ?? id, expired });
    }
    return results;
  }

  /**
   * Interactive subscription login. pi drives the flow; we surface each step
   * through the UiBridge: the auth URL opens in the browser (and shows in a
   * dialog as fallback), codes/prompts become input dialogs, account choices
   * become select dialogs. Tokens land in pi's auth.json and auto-refresh.
   */
  async oauthLogin(providerId: string): Promise<void> {
    const ui = this.getUi();
    if (!ui) throw new Error("No UI connected for interactive login");
    const provider = this.auth.getOAuthProviders().find((p) => p.id === providerId);
    await this.auth.login(providerId, {
      onAuth: (info) => {
        openExternal(info.url);
        // Provider instructions often reference pasting a code — only relevant
        // when there is no local callback server to finish the login.
        const instructions =
          !provider?.usesCallbackServer && info.instructions ? `${info.instructions}\n\n` : "";
        void ui.confirm(
          "Continue login in your browser",
          `${instructions}Login completes automatically once you finish in the browser.\n` +
            `If the browser did not open, visit:\n${info.url}`,
        );
      },
      onDeviceCode: (info) => {
        openExternal(info.verificationUri);
        void ui.confirm(
          "Device login",
          `Open ${info.verificationUri} and enter this code: ${info.userCode}`,
        );
      },
      onPrompt: async (prompt) => {
        const value = await ui.input(prompt.message, prompt.placeholder);
        if (value === undefined || (!value && !prompt.allowEmpty)) {
          throw new Error("Login cancelled");
        }
        return value;
      },
      onProgress: (message) => ui.notify(message, "info"),
      // Manual code paste races the provider's local callback server: when the
      // browser is on this machine the redirect completes the login by itself,
      // so offering a paste dialog would be noise — and cancelling it aborts
      // the whole race. Only providers WITHOUT a callback server get one.
      ...(provider?.usesCallbackServer
        ? {}
        : {
            onManualCodeInput: async () => {
              const value = await ui.input(
                "Paste the code from your browser",
                "authorization code",
              );
              if (!value) throw new Error("Login cancelled");
              return value;
            },
          }),
      onSelect: async (prompt) => {
        const label = await ui.select(prompt.message, prompt.options.map((o) => o.label));
        return prompt.options.find((o) => o.label === label)?.id;
      },
    });
    // New credentials can unlock models (e.g. subscription-only baseUrls).
    this.registry.refresh();
  }

  async addProvider(id: string, apiKey: string, config?: ProviderConfig): Promise<void> {
    if (config && (config.name || config.baseUrl || config.api)) {
      const backup = existsSync(this.modelsPath)
        ? readFileSync(this.modelsPath, "utf8")
        : undefined;
      const json = this.readModelsJson() ?? { providers: {} };
      const providerConfig = (json.providers[id] ??= {});
      if (config.name) providerConfig.name = config.name;
      if (config.baseUrl) providerConfig.baseUrl = config.baseUrl;
      if (config.api) providerConfig.api = config.api;

      mkdirSync(dirname(this.modelsPath), { recursive: true });
      writeFileSync(this.modelsPath, JSON.stringify(json, null, 2));
      this.registry.refresh();

      const error = this.registry.getError();
      if (error) {
        // pi rejected the config — restore the previous file and surface why.
        if (backup !== undefined) writeFileSync(this.modelsPath, backup);
        else writeFileSync(this.modelsPath, JSON.stringify({ providers: {} }, null, 2));
        this.registry.refresh();
        throw new Error(`pi rejected the provider config: ${error}`);
      }
    }
    // Local servers usually need no key — only store one when given.
    if (apiKey) this.auth.set(id, { type: "api_key", key: apiKey });
  }

  async removeProvider(id: string): Promise<void> {
    this.auth.remove(id);
  }

  /**
   * Register a custom model by merging it into pi's models.json and
   * refreshing the registry. Rolls back the file if pi rejects the config.
   */
  async addModel(def: CustomModelDef): Promise<void> {
    const provider = def.provider.trim();
    const modelId = def.modelId.trim();
    if (!provider) throw new Error("Provider is required");
    if (!modelId) throw new Error("Model id is required");

    const backup = existsSync(this.modelsPath)
      ? readFileSync(this.modelsPath, "utf8")
      : undefined;

    let config: PiModelsJson = { providers: {} };
    if (backup) {
      try {
        const parsed = JSON.parse(backup) as PiModelsJson;
        if (parsed && typeof parsed === "object" && parsed.providers) config = parsed;
      } catch {
        throw new Error(`${this.modelsPath} exists but is not valid JSON — fix it first`);
      }
    }

    const providerConfig = (config.providers[provider] ??= {});
    if (def.baseUrl) providerConfig.baseUrl = def.baseUrl;
    if (def.api && !providerConfig.api) providerConfig.api = def.api;

    const models = (providerConfig.models ??= []);
    const entry: Record<string, unknown> = { id: modelId };
    if (def.displayName) entry.name = def.displayName;
    if (def.contextWindow) entry.contextWindow = def.contextWindow;
    if (def.maxTokens) entry.maxTokens = def.maxTokens;
    if (def.reasoning !== undefined) entry.reasoning = def.reasoning;
    const existing = models.findIndex((m) => m?.id === modelId);
    if (existing >= 0) models[existing] = { ...models[existing], ...entry };
    else models.push(entry);

    mkdirSync(dirname(this.modelsPath), { recursive: true });
    writeFileSync(this.modelsPath, JSON.stringify(config, null, 2));
    this.registry.refresh();

    const error = this.registry.getError();
    if (error) {
      // pi rejected the config — restore the previous file and surface why.
      if (backup !== undefined) writeFileSync(this.modelsPath, backup);
      else writeFileSync(this.modelsPath, JSON.stringify({ providers: {} }, null, 2));
      this.registry.refresh();
      throw new Error(`pi rejected the model config: ${error}`);
    }

    if (def.apiKey) {
      this.auth.set(provider, { type: "api_key", key: def.apiKey });
    }
  }

  /** Read models.json, or undefined if absent/invalid. */
  private readModelsJson(): PiModelsJson | undefined {
    if (!existsSync(this.modelsPath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.modelsPath, "utf8")) as PiModelsJson;
      return parsed && typeof parsed === "object" && parsed.providers ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** "provider/modelId" keys of user-added custom models. */
  private customModelKeys(): Set<string> {
    const keys = new Set<string>();
    const config = this.readModelsJson();
    if (!config) return keys;
    for (const [provider, providerConfig] of Object.entries(config.providers)) {
      for (const model of providerConfig.models ?? []) {
        if (model?.id) keys.add(`${provider}/${model.id}`);
      }
    }
    return keys;
  }

  /**
   * Edit model metadata. Custom models get the patch merged into their own
   * models.json entry; built-in models get a providers.<id>.modelOverrides
   * patch, which pi merges onto the built-in definition at load time.
   */
  async updateModel(provider: string, modelId: string, patch: ModelPatch): Promise<void> {
    if (!this.registry.find(provider, modelId)) {
      throw new Error(`Unknown model: ${provider}/${modelId}`);
    }
    const entryPatch: Record<string, unknown> = {};
    if (patch.displayName !== undefined) entryPatch.name = patch.displayName;
    if (patch.contextWindow !== undefined) entryPatch.contextWindow = patch.contextWindow;
    if (patch.maxTokens !== undefined) entryPatch.maxTokens = patch.maxTokens;
    if (patch.reasoning !== undefined) entryPatch.reasoning = patch.reasoning;
    if (Object.keys(entryPatch).length === 0) return;

    const backup = existsSync(this.modelsPath)
      ? readFileSync(this.modelsPath, "utf8")
      : undefined;
    const config = this.readModelsJson() ?? { providers: {} };
    const providerConfig = (config.providers[provider] ??= {});
    const models = providerConfig.models ?? [];
    const existing = models.findIndex((m) => m?.id === modelId);
    if (existing >= 0) {
      models[existing] = { ...models[existing], ...entryPatch };
    } else {
      const overrides = (providerConfig.modelOverrides ??= {});
      overrides[modelId] = { ...overrides[modelId], ...entryPatch };
    }

    mkdirSync(dirname(this.modelsPath), { recursive: true });
    writeFileSync(this.modelsPath, JSON.stringify(config, null, 2));
    this.registry.refresh();
    const error = this.registry.getError();
    if (error) {
      // pi rejected the config — restore the previous file and surface why.
      if (backup !== undefined) writeFileSync(this.modelsPath, backup);
      else writeFileSync(this.modelsPath, JSON.stringify({ providers: {} }, null, 2));
      this.registry.refresh();
      throw new Error(`pi rejected the model config: ${error}`);
    }
  }

  /** Remove a custom model from models.json. Built-in models cannot be removed. */
  async removeModel(provider: string, modelId: string): Promise<void> {
    const config = this.readModelsJson();
    const providerConfig = config?.providers[provider];
    const models = providerConfig?.models;
    const index = models?.findIndex((m) => m?.id === modelId) ?? -1;
    if (!config || !providerConfig || !models || index < 0) {
      throw new Error(
        `${provider}/${modelId} is not a custom model — only user-added models can be removed`,
      );
    }
    models.splice(index, 1);
    // Prune a provider entry that only existed to host this model.
    if (models.length === 0) {
      delete providerConfig.models;
      if (Object.keys(providerConfig).length === 0) delete config.providers[provider];
    }
    writeFileSync(this.modelsPath, JSON.stringify(config, null, 2));
    this.registry.refresh();
    const error = this.registry.getError();
    if (error) throw new Error(`pi rejected the model config: ${error}`);
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    const custom = this.customModelKeys();
    const available = new Set(
      this.registry.getAvailable().map((m) => {
        const model = m as { provider: string; id: string };
        return `${model.provider}/${model.id}`;
      }),
    );
    const all = this.registry.getAll().map((m) => {
      const model = m as {
        provider: string;
        id: string;
        name?: string;
        contextWindow?: number;
        maxTokens?: number;
        reasoning?: boolean;
      };
      return model;
    });
    const aliasKeys = new Set(
      all
        .filter((model) => model.provider === "anthropic" && !/-\d{8}$/.test(model.id))
        .map((model) => `${canonicalAnthropicAliasId(model.id)}:${modelDisplayName(model)}`),
    );
    return all.filter((model) => !isDatedAnthropicAliasDuplicate(model, aliasKeys)).map((model) => {
      const key = `${model.provider}/${model.id}`;
      return {
        provider: model.provider,
        modelId: model.id,
        // pi suffixes alias ids (e.g. claude-opus-4-5) with "(latest)",
        // meaning "newest snapshot of this line" — confusing, drop it.
        displayName: modelDisplayName(model),
        available: available.has(key),
        ...(custom.has(key) ? { custom: true } : {}),
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      };
    });
  }
}

/* --------------------------------- adapter --------------------------------- */

export class PiAdapter implements HarnessAdapter {
  readonly capabilities: HarnessCapabilities = {
    id: "pi",
    displayName: "pi agent harness",
    harnessVersion: VERSION,
    supportsSessionTree: true,
    supportsToolCallInterception: true,
    supportsMcpBridge: false, // MVP: MCP bridge lands later; UI hides the pane.
    supportsPluginInstall: true,
    supportsDynamicProviderRegistration: true,
    supportsCustomTools: true,
    supportsCompaction: true,
    supportsSteering: true,
    supportsThinkingLevels: true,
    supportsSkills: true,
  };

  readonly providers: PiProviderManager;
  readonly plugins: PiPluginManager;
  readonly skills: PiSkillManager;

  private readonly agentDir: string;
  private readonly auth: AuthStorage;
  private readonly registry: ModelRegistry;
  private ui: UiBridge | undefined;
  private interceptor: ToolCallInterceptor | undefined;
  private readonly customTools: NeutralToolDefinition[] = [];
  private readonly sessions = new Set<PiSession>();

  constructor(options: PiAdapterOptions = {}) {
    this.agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
    this.auth = AuthStorage.create(join(this.agentDir, "auth.json"));
    const modelsPath = join(this.agentDir, "models.json");
    this.registry = ModelRegistry.create(this.auth, modelsPath);
    this.providers = new PiProviderManager(this.auth, this.registry, modelsPath, () => this.ui);
    this.plugins = new PiPluginManager(this.agentDir);
    this.skills = new PiSkillManager(this.agentDir);
  }

  async initialize(options: AdapterInitOptions): Promise<void> {
    this.ui = options.ui;
  }

  registerToolCallInterceptor(handler: ToolCallInterceptor): void {
    this.interceptor = handler;
  }

  registerTool(tool: NeutralToolDefinition): void {
    this.customTools.push(tool);
  }

  async createSession(config: SessionConfig): Promise<HarnessSession> {
    // Folderless chats live in the user's home directory, not wherever the
    // host process happened to be launched from.
    const cwd = config.cwd ?? homedir();
    const sessionManager =
      config.inMemory || config.cwd === undefined
        ? SessionManager.inMemory(cwd)
        : config.resumeSession
          ? SessionManager.open(config.resumeSession)
          : SessionManager.create(config.cwd);

    const settingsManager = SettingsManager.create(cwd, this.agentDir);

    // Session id is fixed before creation so the permission bridge can carry it.
    const sessionId = randomUUID();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      ...(config.systemPromptOverride ? { systemPrompt: config.systemPromptOverride } : {}),
      extensionFactories: [
        createPermissionBridge(
          sessionId,
          () => this.interceptor,
          () => this.ui,
        ),
      ],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      authStorage: this.auth,
      modelRegistry: this.registry,
      ...(config.tools ? { tools: config.tools } : {}),
      // Session context lets neutral file/shell tools act on this session's
      // cwd. Same-name custom tools shadow pi built-ins in pi's tool registry,
      // so the neutral read/write/edit/bash/... replace pi's own.
      customTools: this.customTools.map((tool) =>
        toPiTool(tool, { cwd: config.cwd, sessionId }),
      ),
      resourceLoader,
      sessionManager,
      settingsManager,
      ...(config.model
        ? { model: this.registry.find(config.model.provider, config.model.modelId) }
        : {}),
    });

    const wrapped = new PiSession(config, session);
    // Keep the pre-allocated id used by the permission bridge.
    Object.defineProperty(wrapped, "id", { value: sessionId });
    this.sessions.add(wrapped);
    return wrapped;
  }

  async deleteSession(path: string): Promise<void> {
    rmSync(path, { force: true });
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    const infos = await SessionManager.list(cwd ?? homedir());
    return infos.map((info) => {
      const record = info as unknown as Record<string, unknown>;
      return {
        id: String(record.path ?? record.id ?? randomUUID()),
        name: typeof record.name === "string" ? record.name : undefined,
        path: typeof record.path === "string" ? record.path : undefined,
        cwd: typeof record.cwd === "string" ? record.cwd : undefined,
        createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
        parentPath: typeof record.parentPath === "string" ? record.parentPath : undefined,
      };
    });
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions) {
      await session.dispose().catch(() => {});
    }
    this.sessions.clear();
  }
}
