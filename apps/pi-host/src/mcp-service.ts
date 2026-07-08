/**
 * MCP bridge (§7.7), implemented in the HOST CORE rather than inside an
 * adapter: it only needs the neutral `registerTool()` capability, so keeping
 * it here makes MCP work for ANY adapter that reports supportsCustomTools —
 * strictly more harness-neutral than the plan's original adapter-internal
 * placement. The server exposes it behind the same neutral McpManager
 * surface (`list`/`add`/`remove`) the protocol already speaks.
 *
 * Config: ~/.pi-desktop/mcp-servers.json — same {command,args,env} /
 * {url,headers} vocabulary as Claude Desktop's config for familiarity.
 *
 * Limitation: the neutral registerTool() has no unregister, so proxy tool
 * definitions remain registered internally. The host rebuilds open chat sessions
 * after add/remove/toggle so the model only sees configured, enabled servers.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type {
  McpManager,
  McpServerConfig,
  McpServerState,
  McpServerStatus,
  NeutralToolResult,
} from "@pi-desktop/harness-sdk";

const CONFIG_PATH =
  process.env.PI_DESKTOP_MCP_CONFIG ?? join(homedir(), ".pi-desktop", "mcp-servers.json");

/** How long to wait for a server to connect and list its tools before giving up
 *  and marking it errored (so one slow server can't hang forever). */
const CONNECT_TIMEOUT_MS = Number(process.env.PI_DESKTOP_MCP_TIMEOUT_MS) || 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

interface ServerRuntime {
  config: McpServerConfig;
  state: McpServerState;
  client?: Client;
  toolCount: number;
  /** Proxy tool names this server registered (mcp__<server>__<tool>). Used to
   *  hide a disabled server's tools from new sessions. */
  toolNames: Set<string>;
  lastError?: string;
  /** Auto-reconnect bookkeeping for errored servers. */
  retrying?: boolean;
  nextRetryAt?: number;
  retryDelay?: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  /** Last failure was a timeout (waiting to connect / list tools). */
  timedOut?: boolean;
}

/** Reconnect backoff for hard errors: start short, double up to a cap. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** Timeouts (e.g. a proxy not yet attached) retry on a steady 1-minute cadence. */
const RETRY_TIMEOUT_MS = 60_000;

type RegisterTool = (tool: {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<NeutralToolResult>;
}) => void;

/**
 * Build the model-facing proxy tool name. Providers (e.g. Anthropic) require
 * tool names to match ^[a-zA-Z0-9_-]{1,128}$, so replace any other character
 * (spaces, dots, colons in a server or tool name) with "_" and cap the length.
 * The original remote name is still used for the actual MCP call.
 */
function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

function toolResultFrom(raw: unknown): NeutralToolResult {
  const r = raw as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const content = Array.isArray(r?.content)
    ? r.content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => ({ type: "text" as const, text: c.text as string }))
    : [];
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(raw ?? null, null, 2) });
  }
  return { content, ...(r?.isError ? { isError: true } : {}) };
}

export class McpService implements McpManager {
  private readonly servers = new Map<string, ServerRuntime>();
  /** Tool names already registered with the adapter (registerTool is add-only). */
  private readonly registered = new Set<string>();

  constructor(
    private readonly registerTool: RegisterTool,
    private readonly configPath: string = CONFIG_PATH,
  ) {}

  /** Load persisted config and connect to every enabled server. */
  async start(): Promise<void> {
    for (const config of this.loadConfigs()) {
      this.servers.set(config.name, {
        config,
        state: config.enabled === false ? "disabled" : "connecting",
        toolCount: 0,
        toolNames: new Set(),
      });
    }
    await Promise.allSettled(
      [...this.servers.values()]
        .filter((s) => s.state !== "disabled")
        .map((s) => this.connect(s)),
    );
  }

  /** Proxy tool names belonging to currently configured, enabled servers. The
   *  host rebuilds chat sessions with this list so toggling/removing a server
   *  updates the model's tool context immediately. */
  activeToolNames(): Set<string> {
    const active = new Set<string>();
    for (const server of this.servers.values()) {
      if (server.config.enabled !== false) {
        for (const name of server.toolNames) active.add(name);
      }
    }
    return active;
  }

  async list(): Promise<McpServerStatus[]> {
    return [...this.servers.values()].map((s) => ({
      name: s.config.name,
      state: s.state,
      toolCount: s.toolCount,
      lastError: s.lastError,
      ...(s.retrying ? { retrying: true } : {}),
      ...(s.nextRetryAt ? { nextRetryAt: s.nextRetryAt } : {}),
      ...(s.timedOut ? { timedOut: true } : {}),
    }));
  }

  async add(config: McpServerConfig): Promise<void> {
    if (!config.name) throw new Error("Server name is required");
    if (!config.command && !config.url) throw new Error("Either command or url is required");
    // Replacing an existing entry → stop its pending retry first.
    const prev = this.servers.get(config.name);
    if (prev?.retryTimer) clearTimeout(prev.retryTimer);
    const runtime: ServerRuntime = {
      config,
      state: config.enabled === false ? "disabled" : "connecting",
      toolCount: 0,
      toolNames: prev?.toolNames ?? new Set(),
    };
    this.servers.set(config.name, runtime);
    this.persist();
    if (runtime.state !== "disabled") await this.connect(runtime);
    if (runtime.state === "error") {
      // It's now retrying in the background, but tell the user the first try failed.
      throw new Error(`Saved, but connection failed (retrying): ${runtime.lastError}`);
    }
  }

  async remove(name: string): Promise<void> {
    const runtime = this.servers.get(name);
    if (!runtime) return;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    await runtime.client?.close().catch(() => {});
    this.servers.delete(name);
    this.persist();
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const runtime = this.servers.get(name);
    if (!runtime) throw new Error(`Unknown MCP server: ${name}`);
    runtime.config = { ...runtime.config, enabled };
    this.persist();
    if (enabled) {
      // Re-connect if it isn't already up. Its proxy tools (registered on a
      // prior connect) start answering again once state is "connected".
      if (runtime.state !== "connected") {
        await this.connect(runtime);
        if (runtime.state === "error") {
          throw new Error(`Enabled, but connection failed (retrying): ${runtime.lastError}`);
        }
      }
    } else {
      // Disable: stop reconnect attempts and disconnect. Proxy tools remain
      // registered (registerTool is add-only) but answer with an error while
      // the server isn't "connected".
      if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
      runtime.retryTimer = undefined;
      runtime.retrying = false;
      runtime.nextRetryAt = undefined;
      runtime.timedOut = false;
      await runtime.client?.close().catch(() => {});
      runtime.client = undefined;
      runtime.state = "disabled";
      runtime.toolCount = 0;
      runtime.lastError = undefined;
    }
  }

  /* -------------------------------- internals ------------------------------ */

  private async connect(runtime: ServerRuntime): Promise<void> {
    const { config } = runtime;
    runtime.state = "connecting";
    runtime.lastError = undefined;
    try {
      const client = await withTimeout(
        this.connectClient(config),
        CONNECT_TIMEOUT_MS,
        `MCP "${config.name}" connect`,
      );
      runtime.client = client;

      const { tools } = await withTimeout(
        client.listTools(),
        CONNECT_TIMEOUT_MS,
        `MCP "${config.name}" listTools`,
      );
      runtime.toolCount = tools.length;
      for (const tool of tools) {
        const proxyName = mcpToolName(config.name, tool.name);
        runtime.toolNames.add(proxyName); // record ownership even if already registered
        if (this.registered.has(proxyName)) continue;
        this.registered.add(proxyName);
        const serverName = config.name;
        const remoteName = tool.name;
        this.registerTool({
          name: proxyName,
          label: `${serverName}: ${remoteName}`,
          description: tool.description ?? `MCP tool ${remoteName} from ${serverName}`,
          parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object" },
          execute: async (args) => {
            const live = this.servers.get(serverName);
            if (!live?.client || live.state !== "connected") {
              return {
                content: [{ type: "text", text: `MCP server "${serverName}" is not connected.` }],
                isError: true,
              };
            }
            try {
              const result = await live.client.callTool({ name: remoteName, arguments: args });
              return toolResultFrom(result);
            } catch (err) {
              return {
                content: [{ type: "text", text: `MCP call failed: ${(err as Error).message}` }],
                isError: true,
              };
            }
          },
        });
      }
      runtime.state = "connected";
      // Success: clear any retry backoff.
      runtime.retrying = false;
      runtime.nextRetryAt = undefined;
      runtime.retryDelay = undefined;
      runtime.timedOut = false;
    } catch (err) {
      const message = (err as Error).message;
      runtime.state = "error";
      runtime.lastError = message;
      runtime.timedOut = /timed out/i.test(message);
      runtime.client = undefined;
      // Keep trying in the background until it comes up (e.g. Studio attaches).
      this.scheduleRetry(runtime);
    }
  }

  /** Schedule the next reconnect for an errored server. Timeouts retry on a
   *  steady 1-minute cadence; hard errors use capped exponential backoff. */
  private scheduleRetry(runtime: ServerRuntime): void {
    if (runtime.config.enabled === false) return;
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    const delay = runtime.timedOut
      ? RETRY_TIMEOUT_MS
      : Math.min(runtime.retryDelay ? runtime.retryDelay * 2 : RETRY_MIN_MS, RETRY_MAX_MS);
    runtime.retryDelay = delay;
    runtime.retrying = true;
    runtime.nextRetryAt = Date.now() + delay;
    runtime.retryTimer = setTimeout(() => {
      runtime.retryTimer = undefined;
      // Still errored and not removed → try again.
      if (this.servers.get(runtime.config.name) === runtime && runtime.state === "error") {
        void this.connect(runtime);
      }
    }, delay);
    // Don't keep the process alive just for a retry timer.
    runtime.retryTimer.unref?.();
  }

  /** Connect a fresh Client, falling back from streamable HTTP to SSE for URL servers. */
  private async connectClient(config: McpServerConfig): Promise<Client> {
    const newClient = () => new Client({ name: "pi-desktop", version: "0.1.0" });

    if (config.command) {
      const client = newClient();
      await client.connect(
        new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
        }),
      );
      return client;
    }

    const url = new URL(config.url!);
    const requestInit = { headers: config.headers ?? {} };
    try {
      const client = newClient();
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
      return client;
    } catch {
      // Older servers only speak the SSE transport.
      const client = newClient();
      await client.connect(new SSEClientTransport(url, { requestInit }));
      return client;
    }
  }

  private loadConfigs(): McpServerConfig[] {
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(
      this.configPath,
      JSON.stringify([...this.servers.values()].map((s) => s.config), null, 2),
    );
  }

  async dispose(): Promise<void> {
    for (const runtime of this.servers.values()) {
      if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
      await runtime.client?.close().catch(() => {});
    }
  }
}
