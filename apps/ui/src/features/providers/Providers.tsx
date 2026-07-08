/** Provider & model management pane (§7.8). Hidden unless the adapter supports it. */
import { useCallback, useEffect, useState } from "react";
import type {
  HostSettings,
  ModelInfo,
  OAuthProviderInfo,
  ProviderConfig,
  ProviderInfo,
  SubscriptionUsage,
} from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import { Dropdown } from "../../components/Dropdown.js";
import { Toggle } from "../../components/Toggle.js";
import {
  cliVendorForProvider,
  currentOfficialCliModels,
  isLocalProvider,
  localFirst,
  modelRouteForProvider,
  usesOfficialCliForProvider,
} from "../../models.js";
import { API_DIALECTS } from "../../provider-presets.js";

/** Well-known provider ids, shown even before the adapter reports them. */
const COMMON_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "mistral",
  "groq",
  "xai",
  "deepseek",
  "ollama",
];

interface NewProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
}

const EMPTY_NEW: NewProvider = {
  id: "",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
};

function usageWindowLabel(label: string): string {
  const normalized = label.toLowerCase().replace(/[_-]/g, " ");
  if (/\bprimary\b/.test(normalized)) return "5h";
  if (/\bsecondary\b/.test(normalized)) return "week";
  return label;
}

function AddProviderDialog({
  client,
  onDone,
  onCancel,
}: {
  client: HostClient;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [p, setP] = useState<NewProvider>(EMPTY_NEW);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const patch = (delta: Partial<NewProvider>) => setP((prev) => ({ ...prev, ...delta }));

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const config: ProviderConfig = {};
      if (p.name.trim()) config.name = p.name.trim();
      if (p.baseUrl.trim()) config.baseUrl = p.baseUrl.trim();
      if (p.api) config.api = p.api;
      await client.send({
        type: "add_provider",
        providerId: p.id.trim(),
        apiKey: p.apiKey,
        config,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">Add provider</div>
        {error && <div className="error">{error}</div>}

        <div className="field-grid">
          <label>Provider id</label>
          <input
            autoFocus
            value={p.id}
            placeholder="my-server, together, fireworks…"
            onChange={(e) => patch({ id: e.target.value })}
          />
          <label>Display name</label>
          <input
            value={p.name}
            placeholder="(optional)"
            onChange={(e) => patch({ name: e.target.value })}
          />
          <label>Base URL</label>
          <input
            value={p.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => patch({ baseUrl: e.target.value })}
          />
          <label>API</label>
          <Dropdown
            value={p.api}
            onChange={(api) => patch({ api })}
            options={API_DIALECTS.map((a) => ({ value: a.id, label: a.label }))}
          />
          <label>API key</label>
          <input
            type="password"
            value={p.apiKey}
            placeholder="(optional — local servers usually need none)"
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
        </div>

        <div className="dialog-actions">
          <button className="primary" disabled={busy || !p.id.trim()} onClick={save}>
            {busy ? "Saving…" : "Add provider"}
          </button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function Providers({ client }: { client: HostClient }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderInfo[]>([]);
  const [loggingIn, setLoggingIn] = useState<string>();
  /** Per-vendor "use official CLI" preference (default true). */
  const [cliPrefs, setCliPrefs] = useState<NonNullable<HostSettings["useOfficialCli"]>>({});
  /** Plan usage per subscription provider (when queryable). */
  const [usages, setUsages] = useState<Record<string, SubscriptionUsage>>({});
  const [providerId, setProviderId] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProviders(await client.send({ type: "list_providers" }));
      setModels(await client.send({ type: "list_models" }));
      setOauthProviders(
        await client
          .send<OAuthProviderInfo[]>({ type: "list_oauth_providers" })
          .catch(() => [] as OAuthProviderInfo[]),
      );
      const settings = await client
        .send<HostSettings>({ type: "get_settings" })
        .catch(() => undefined);
      setCliPrefs(settings?.useOfficialCli ?? {});
      // Plan usage, best-effort per subscription (non-blocking). Some providers
      // (Codex) can be read from the official CLI login even when pi is not
      // logged in directly, so ask for every OAuth subscription row.
      for (const p of await client
        .send<OAuthProviderInfo[]>({ type: "list_oauth_providers" })
        .catch(() => [] as OAuthProviderInfo[])) {
        void client
          .send<SubscriptionUsage | null>({ type: "subscription_usage", providerId: p.id })
          .then((usage) => {
            if (usage) setUsages((u) => ({ ...u, [p.id]: usage }));
          })
          .catch(() => {});
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client]);

  /** Flip a vendor's "official CLI" preference (persisted in host settings). */
  const setCliPref = async (vendor: "anthropic" | "openai", value: boolean) => {
    const next = { ...cliPrefs, [vendor]: value };
    setCliPrefs(next);
    await client
      .send({ type: "set_setting", key: "useOfficialCli", value: next })
      .catch((err) => setError((err as Error).message));
  };

  /** Interactive subscription login — dialogs pop up as pi's flow needs them. */
  const oauthLogin = async (id: string) => {
    setError(undefined);
    setLoggingIn(id);
    try {
      await client.send({ type: "oauth_login", providerId: id });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoggingIn(undefined);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = async () => {
    if (!providerId || !apiKey) return;
    try {
      await client.send({ type: "add_provider", providerId, apiKey });
      setApiKey("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // All pickable providers: known to the adapter ∪ common ids.
  const knownIds = new Set(providers.map((p) => p.id));
  const configured = new Set(providers.filter((p) => p.hasCredentials).map((p) => p.id));
  const pickable = [...new Set([...knownIds, ...COMMON_PROVIDERS])].sort();
  const providerOptions = pickable.map((id) => ({
    value: id,
    label: id,
    hint: configured.has(id) ? "configured" : isLocalProvider(id) ? "local" : undefined,
  }));
  const visibleModels = currentOfficialCliModels(
    models.filter((m) => m.available || usesOfficialCliForProvider(m.provider, cliPrefs)),
    cliPrefs,
  );

  return (
    <div className="pane">
      <h2>Providers</h2>
      {error && <div className="error">{error}</div>}

      {oauthProviders.length > 0 && (
        <>
          <h3>Subscriptions</h3>
          <ul className="list subscription-list">
            {oauthProviders.map((p) => {
              const info = providers.find((x) => x.id === p.id);
              const connected = info?.authType === "oauth";
              const vendor = cliVendorForProvider(p.id);
              // Defaults: Claude → official CLI on, Codex → off.
              const useCli =
                vendor !== undefined && (cliPrefs[vendor] ?? vendor === "anthropic");
              const cliName = vendor === "anthropic" ? "Claude Code CLI" : "Codex CLI";
              return (
                <li key={p.id}>
                  <span className="sub-id">
                    <span>{p.name}</span>
                    {vendor && (
                      <span
                        className="pill"
                        title={
                          useCli
                            ? `Work is delegated to the official ${cliName} — plan billing, login shared with the CLI.`
                            : "pi calls the API with its own login — subscription usage bills as extra usage."
                        }
                      >
                        {useCli ? cliName : "Pi CLI"}
                      </span>
                    )}
                  </span>
                  {usages[p.id] && (
                    <span className="sub-usage">
                      {usages[p.id].windows.map((w) => {
                        const label = usageWindowLabel(w.label);
                        return (
                          <span
                            key={w.label}
                            className={`usage-pill ${w.usedPercent > 90 ? "hot" : w.usedPercent > 70 ? "warm" : ""}`}
                            title={
                              `${w.usedPercent}% of the ${label} limit used` +
                              (w.resetsAt ? ` — resets ${new Date(w.resetsAt).toLocaleString()}` : "")
                            }
                          >
                            {label} {w.usedPercent}%
                          </span>
                        );
                      })}
                    </span>
                  )}
                  <span className="sub-actions">
                    {vendor && (
                      <Toggle
                        checked={useCli}
                        onChange={(checked) => void setCliPref(vendor, checked)}
                        title={`On: delegate to the ${cliName} (plan billing). Off: pi logs in directly (extra-usage billing).`}
                      />
                    )}
                    {!useCli &&
                      (connected ? (
                        <button
                          className="danger"
                          onClick={async () => {
                            await client.send({ type: "remove_provider", providerId: p.id });
                            await refresh();
                          }}
                        >
                          log out
                        </button>
                      ) : (
                        <button
                          className="primary"
                          disabled={loggingIn !== undefined}
                          title="Opens your browser to sign in — tokens are stored locally and auto-refresh"
                          onClick={() => void oauthLogin(p.id)}
                        >
                          {loggingIn === p.id ? "waiting for login…" : "log in"}
                        </button>
                      ))}
                  </span>
                </li>
              );
            })}
          </ul>
          <h3>API keys</h3>
        </>
      )}
      <div className="row">
        <Dropdown
          value={providerId}
          options={providerOptions}
          onChange={setProviderId}
          title="Pick a provider"
        />
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API key" type="password" />
        <button className="primary" disabled={!providerId || !apiKey} onClick={saveKey}>
          Save key
        </button>
        <button title="Add a new provider with its own endpoint and API dialect" onClick={() => setShowAdd(true)}>
          + Add provider
        </button>
      </div>
      <ul className="list">
        {providers.map((p) => {
          return (
            <li key={p.id}>
              <span>{p.id}</span>
              <span className={p.hasCredentials ? "ok" : "dim"}>
                {p.hasCredentials
                  ? p.authType === "oauth"
                    ? "subscription"
                    : "credentials set"
                  : "no credentials"}
              </span>
              {p.hasCredentials && (
                <button
                  className="danger"
                  onClick={async () => {
                    await client.send({ type: "remove_provider", providerId: p.id });
                    await refresh();
                  }}
                >
                  remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <h3>Models ({visibleModels.length} available)</h3>
      <ul className="list models">
        {localFirst(visibleModels).map((m) => {
          const route = modelRouteForProvider(m.provider, cliPrefs);
          return (
            <li key={`${m.provider}/${m.modelId}`}>
              <span>{m.displayName ?? m.modelId}</span>
              {isLocalProvider(m.provider) && <span className="pill">local</span>}
              <span className={`pill route-pill ${route.kind}`} title={route.title}>
                {route.label}
              </span>
              <span className="dim">{m.provider}</span>
            </li>
          );
        })}
      </ul>

      {showAdd && (
        <AddProviderDialog
          client={client}
          onCancel={() => setShowAdd(false)}
          onDone={() => {
            setShowAdd(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
