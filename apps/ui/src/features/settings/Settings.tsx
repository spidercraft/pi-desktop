/**
 * Settings modal (§7.4): appears over the main UI like the question dialogs,
 * with a category sidebar — General, Appearance, Providers, Plugins, MCP.
 */
import { useEffect, useState } from "react";
import {
  DEFAULT_SYSTEM_PROMPT,
  type HarnessCapabilities,
  type HostSettings,
  type ToolInfo,
} from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import { notify } from "../../notifications.js";
import { ToolToggles } from "../chat/ToolToggles.js";
import { McpServers } from "../mcp/McpServers.js";
import { Plugins } from "../plugins/Plugins.js";
import { Providers } from "../providers/Providers.js";
import { Skills } from "../skills/Skills.js";
import { Dropdown } from "../../components/Dropdown.js";
import { Toggle } from "../../components/Toggle.js";
import { autoExpandThinking, setAutoExpandThinking } from "../../prefs.js";
import {
  COLOR_KEYS,
  PRESETS,
  currentColor,
  loadTheme,
  saveTheme,
  type ColorKey,
  type ThemeSettings,
} from "../../theme.js";

type Category =
  | "general"
  | "prompts"
  | "tools"
  | "skills"
  | "appearance"
  | "providers"
  | "plugins"
  | "mcp";

/** Settings → Tools: default set of tools available to new chats. Each chat can
 *  override this from its ⋯ menu → "Tools…". */
function defaultReadOnlyAllowed(tools: ToolInfo[]): string[] {
  return tools.filter((tool) => tool.readOnlyAllowedByDefault).map((tool) => tool.name);
}

function ReadOnlyToolDefaults({ client }: { client: HostClient }) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [allowed, setAllowed] = useState<string[]>();

  useEffect(() => {
    void Promise.all([
      client.send<HostSettings>({ type: "get_settings" }),
      client.send<ToolInfo[]>({ type: "list_tools" }),
    ])
      .then(([settings, list]) => {
        const tools = list ?? [];
        setTools(tools);
        setAllowed(settings.readOnlyAllowedTools ?? defaultReadOnlyAllowed(tools));
      })
      .catch(() => {
        setAllowed([]);
        setTools([]);
      });
  }, [client]);

  if (!allowed) return null;

  const defaults = defaultReadOnlyAllowed(tools);
  const allowedSet = new Set(allowed);
  const setToolAllowed = (name: string, enabled: boolean) => {
    const next = new Set(allowed);
    if (enabled) next.add(name);
    else next.delete(name);
    const value = [...next];
    setAllowed(value);
    void client
      .send({ type: "set_setting", key: "readOnlyAllowedTools", value })
      .catch((err) => notify.error((err as Error).message));
  };
  const resetToDefault = () => {
    setAllowed(defaults);
    void client
      .send({ type: "set_setting", key: "readOnlyAllowedTools", value: undefined })
      .catch((err) => notify.error((err as Error).message));
  };

  return (
    <div className="setting">
      <label>Tools allowed in Read-only mode</label>
      <div className="dim">
        When a chat’s permission policy is Read-only, only these tools are allowed. By
        default this includes inspection tools like read, grep, find, and ls.
      </div>
      <div className="tool-toggles">
        {tools.map((t) => (
          <Toggle
            key={t.name}
            checked={allowedSet.has(t.name)}
            onChange={(enabled) => setToolAllowed(t.name, enabled)}
            label={
              <span className="tool-toggle-text">
                <span className="tool-toggle-name">{t.name}</span>
                {t.description && (
                  <span className="tool-toggle-desc" title={t.fullDescription ?? t.description}>
                    {t.description}
                  </span>
                )}
              </span>
            }
          />
        ))}
      </div>
      <button style={{ marginTop: 8 }} onClick={resetToDefault}>
        Reset to default
      </button>
    </div>
  );
}

function ToolDefaults({ client }: { client: HostClient }) {
  const [disabled, setDisabled] = useState<string[]>();

  useEffect(() => {
    client
      .send<HostSettings>({ type: "get_settings" })
      .then((s) => setDisabled(s.disabledTools ?? []))
      .catch(() => setDisabled([]));
  }, [client]);

  if (!disabled) return null;

  const update = (next: string[]) => {
    setDisabled(next);
    void client
      .send({ type: "set_setting", key: "disabledTools", value: next.length > 0 ? next : undefined })
      .catch((err) => notify.error((err as Error).message));
  };

  return (
    <>
      <div className="setting">
        <label>Tools available to the model</label>
        <div className="dim">
          Turn a tool off to keep the model from using it. This is the default for new chats —
          each chat can override it from its ⋯ menu → “Tools…”. MCP tools are always available.
        </div>
        <ToolToggles client={client} disabled={disabled} onChange={update} />
      </div>
      <ReadOnlyToolDefaults client={client} />
    </>
  );
}

function Appearance() {
  const [theme, setTheme] = useState<ThemeSettings>(loadTheme);
  // Bump to re-read computed colors after preset changes / resets.
  const [, setTick] = useState(0);
  const [expandThinking, setExpandThinking] = useState(autoExpandThinking);

  const update = (next: ThemeSettings) => {
    saveTheme(next);
    setTheme(next);
    setTick((t) => t + 1);
  };

  const setColor = (key: ColorKey, value: string) =>
    update({ ...theme, overrides: { ...theme.overrides, [key]: value } });
  const hasOverrides = Object.keys(theme.overrides).length > 0;

  return (
    <div className="setting">
      <label>Appearance</label>
      <div className="theme-presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className={`theme-preset ${theme.preset === p.id ? "active" : ""}`}
            onClick={() => update({ preset: p.id, overrides: {} })}
          >
            <span
              className="theme-swatch"
              style={{ background: p.swatch[0], ["--swatch-accent" as string]: p.swatch[1] }}
            />
            {p.label}
          </button>
        ))}
      </div>
      <label style={{ marginTop: 10 }}>Custom colors</label>
      <div className="color-grid">
        {COLOR_KEYS.map(({ key, cssVar, label }) => (
          <div key={key} className="color-field">
            <span>{label}</span>
            <input
              type="color"
              value={theme.overrides[key] ?? currentColor(cssVar)}
              onChange={(e) => setColor(key, e.target.value)}
            />
          </div>
        ))}
      </div>
      {hasOverrides && (
        <div className="row">
          <button onClick={() => update({ ...theme, overrides: {} })}>
            Reset to preset colors
          </button>
        </div>
      )}
      <div className="dim">
        Borders, hover states and dimmed text are derived from these colors automatically.
      </div>
      <label style={{ marginTop: 10 }}>Chat</label>
      <Toggle
        checked={expandThinking}
        onChange={(checked) => {
          setAutoExpandThinking(checked);
          setExpandThinking(checked);
        }}
        label="Auto-expand thinking blocks"
        title="New thinking blocks start expanded instead of collapsed"
      />
    </div>
  );
}

function General({ client }: { client: HostClient }) {
  const [engine, setEngine] = useState<NonNullable<HostSettings["searchEngine"]>>("duckduckgo");
  const [braveKey, setBraveKey] = useState("");
  const [url, setUrl] = useState("");
  const [contextSize, setContextSize] = useState("");

  useEffect(() => {
    client
      .send<HostSettings>({ type: "get_settings" })
      .then((s) => {
        setEngine(s.searchEngine ?? "duckduckgo");
        setBraveKey(s.braveApiKey ?? "");
        setUrl(s.searxngUrl ?? "");
        setContextSize(s.defaultContextWindow ? String(s.defaultContextWindow) : "");
      })
      .catch((err) => notify.error(err.message));
  }, [client]);

  /** Persist the engine choice — it's used for every search from then on. */
  const pickEngine = async (next: string) => {
    const value = next as NonNullable<HostSettings["searchEngine"]>;
    setEngine(value);
    try {
      await client.send({ type: "set_setting", key: "searchEngine", value });
      notify.success("Search engine saved — used for all searches.");
    } catch (err) {
      notify.error((err as Error).message);
    }
  };

  const saveBraveKey = async () => {
    try {
      await client.send({
        type: "set_setting",
        key: "braveApiKey",
        value: braveKey.trim() || undefined,
      });
      notify.success("Brave API key saved.");
    } catch (err) {
      notify.error((err as Error).message);
    }
  };

  const saveContextSize = async () => {
    try {
      const value = contextSize ? Number(contextSize) : undefined;
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        notify.error("Enter a positive number (or leave empty to disable).");
        return;
      }
      await client.send({ type: "set_setting", key: "defaultContextWindow", value });
      notify.success("Default context size saved.");
    } catch (err) {
      notify.error((err as Error).message);
    }
  };

  const save = async () => {
    try {
      const result = await client.send<{ ok: boolean; error?: string } | null>({
        type: "set_setting",
        key: "searxngUrl",
        value: url,
      });
      if (result && !result.ok) {
        notify.error(`Saved, but connection test failed: ${result.error}`);
      } else {
        notify.success("SearXNG saved — connection OK.");
      }
    } catch (err) {
      notify.error((err as Error).message);
    }
  };

  return (
    <>
      <div className="setting">
        <label>Web search engine</label>
        <Dropdown
          value={engine}
          onChange={(v) => void pickEngine(v)}
          options={[
            { value: "duckduckgo", label: "DuckDuckGo", hint: "no setup" },
            { value: "brave", label: "Brave Search", hint: "API key" },
            { value: "searxng", label: "SearXNG", hint: "self-hosted" },
          ]}
        />
        {engine === "duckduckgo" && (
          <div className="dim">No configuration needed — works out of the box.</div>
        )}
        {engine === "brave" && (
          <>
            <div className="row">
              <input
                type="password"
                value={braveKey}
                onChange={(e) => setBraveKey(e.target.value)}
                placeholder="Brave Search API key"
              />
              <button className="primary" onClick={() => void saveBraveKey()}>
                Save
              </button>
            </div>
            <div className="dim">
              Free tier available at api-dashboard.search.brave.com.
            </div>
          </>
        )}
        {engine === "searxng" && (
          <>
            <div className="row">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://localhost:8888"
              />
              <button className="primary" onClick={save}>
                Save &amp; test
              </button>
            </div>
            <div className="dim">
              The instance must enable <code>search.formats: [json]</code> in its settings.yml.
            </div>
          </>
        )}
      </div>
      <div className="setting">
        <label>Default context size (new custom models)</label>
        <div className="row">
          <input
            type="number"
            value={contextSize}
            onChange={(e) => setContextSize(e.target.value)}
            onBlur={() => void saveContextSize()}
            placeholder="e.g. 32768 (empty = harness default)"
          />
        </div>
        <div className="dim">
          Used when a model is added without a context window. Existing models can be edited
          individually in the models dialog.
        </div>
      </div>
    </>
  );
}

function Prompts({ client }: { client: HostClient }) {
  const [globalPrompt, setGlobalPrompt] = useState("");

  useEffect(() => {
    client
      .send<HostSettings>({ type: "get_settings" })
      .then((s) => setGlobalPrompt(s.globalSystemPrompt ?? ""))
      .catch((err) => notify.error(err.message));
  }, [client]);

  const saveGlobal = async () => {
    try {
      await client.send({
        type: "set_setting",
        key: "globalSystemPrompt",
        value: globalPrompt.trim() || undefined,
      });
      notify.success("Global system prompt saved — applies to new chats.");
    } catch (err) {
      notify.error((err as Error).message);
    }
  };

  return (
    <>
      <div className="setting">
        <label>Global system prompt</label>
        <textarea
          className="prompt-editor"
          value={globalPrompt}
          onChange={(e) => setGlobalPrompt(e.target.value)}
          placeholder={DEFAULT_SYSTEM_PROMPT}
          rows={12}
        />
        <div className="dim">
          Used for all new chats. Plan and Deepsearch mode prompts still take precedence.
          Leave empty to use the default shown above.
        </div>
        <div className="row">
          <button className="primary" onClick={() => void saveGlobal()}>
            Save
          </button>
        </div>
      </div>
    </>
  );
}

export function SettingsModal({
  client,
  capabilities,
  cwd,
  onClose,
}: {
  client: HostClient;
  capabilities?: HarnessCapabilities;
  /** Active workspace folder — preselected in project-scoped editors. */
  cwd?: string;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<Category>("general");

  const categories: { id: Category; label: string }[] = [
    { id: "general", label: "General" },
    { id: "prompts", label: "Prompts" },
    { id: "tools", label: "Tools" },
    ...(capabilities?.supportsSkills ? [{ id: "skills" as const, label: "Skills" }] : []),
    { id: "appearance", label: "Appearance" },
    ...(capabilities?.supportsDynamicProviderRegistration
      ? [{ id: "providers" as const, label: "Providers" }]
      : []),
    ...(capabilities?.supportsPluginInstall
      ? [{ id: "plugins" as const, label: "Plugins" }]
      : []),
    ...(capabilities?.supportsMcpBridge ? [{ id: "mcp" as const, label: "MCP" }] : []),
  ];

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">Settings</div>
        <div className="settings-body">
          <aside className="settings-nav">
            {categories.map((c) => (
              <button
                key={c.id}
                className={category === c.id ? "active" : ""}
                onClick={() => setCategory(c.id)}
              >
                {c.label}
              </button>
            ))}
          </aside>
          <div className="settings-content">
            {category === "general" && <General client={client} />}
            {category === "prompts" && <Prompts client={client} />}
            {category === "tools" && <ToolDefaults client={client} />}
            {category === "skills" && <Skills client={client} cwd={cwd} />}
            {category === "appearance" && <Appearance />}
            {category === "providers" && <Providers client={client} />}
            {category === "plugins" && <Plugins client={client} />}
            {category === "mcp" && <McpServers client={client} />}
          </div>
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
