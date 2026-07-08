/**
 * Model switcher for the active workspace (§7.8). Always visible.
 * Lists only models whose provider is usable (credentials configured, routed
 * through an official CLI, or local). Local models sort first. The chosen model is persisted in
 * host settings (defaultModel) and applied to new workspaces by the host.
 */
import { useEffect, useState } from "react";
import type { HostSettings, ModelInfo, ProviderInfo } from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import { Dropdown } from "../../components/Dropdown.js";
import {
  formatTokens,
  currentOfficialCliModels,
  isLocalProvider,
  localFirst,
  modelRouteForProvider,
  usesOfficialCliForProvider,
} from "../../models.js";

export function ModelPicker({
  client,
  sessionId,
  version = 0,
  onModelChange,
}: {
  client: HostClient;
  /** Omitted on the home screen (no session yet): picking a model then only
   *  saves it as the default, which the host applies to new workspaces. */
  sessionId?: string;
  /** Bump to force a re-fetch (e.g. after adding a model). */
  version?: number;
  /** Called after the model was switched (e.g. to refresh thinking levels). */
  onModelChange?: () => void;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  /** Per-session pick, overriding the saved default within this session. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  /** Saved default from host settings ("provider/modelId"). */
  const [defaultKey, setDefaultKey] = useState("");
  /** Per-vendor "use official CLI" preference. */
  const [cliPrefs, setCliPrefs] = useState<NonNullable<HostSettings["useOfficialCli"]>>({});
  /** True while the initial model list is still being fetched. */
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [all, providers, settings] = await Promise.all([
          client.send<ModelInfo[]>({ type: "list_models" }),
          client.send<ProviderInfo[]>({ type: "list_providers" }).catch(() => [] as ProviderInfo[]),
          client.send<HostSettings>({ type: "get_settings" }).catch(() => undefined),
        ]);
        const configured = new Set(providers.filter((p) => p.hasCredentials).map((p) => p.id));
        const cliPrefs = settings?.useOfficialCli ?? {};
        const usable = all.filter(
          (m) =>
            usesOfficialCliForProvider(m.provider, cliPrefs) ||
            (m.available && (configured.has(m.provider) || isLocalProvider(m.provider))),
        );
        if (cancelled) return;
        setModels(localFirst(currentOfficialCliModels(usable, cliPrefs)));
        setCliPrefs(cliPrefs);
        if (settings?.defaultModel) {
          setDefaultKey(`${settings.defaultModel.provider}/${settings.defaultModel.modelId}`);
        }
      } catch {
        if (!cancelled) setModels([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, version]);

  const keys = new Set(models.map((m) => `${m.provider}/${m.modelId}`));
  const wanted = picked[sessionId ?? "~home"] ?? defaultKey;
  const value = keys.has(wanted) ? wanted : undefined;

  const apply = async (key: string) => {
    const [provider, ...rest] = key.split("/");
    const modelId = rest.join("/");
    if (sessionId) {
      await client.send({ type: "set_model", sessionId, provider, modelId });
      onModelChange?.();
    }
    setPicked((p) => ({ ...p, [sessionId ?? "~home"]: key }));
    // Persist as the default for future workspaces and restarts.
    setDefaultKey(key);
    void client
      .send({ type: "set_setting", key: "defaultModel", value: { provider, modelId } })
      .catch(() => {});
  };

  return (
    <Dropdown
      className={`model-picker ${loading ? "loading" : ""}`}
      up
      searchable
      disabled={loading || models.length === 0}
      placeholder={loading ? "loading" : models.length === 0 ? "no models" : "model…"}
      title={
        loading
          ? "Loading models…"
          : models.length === 0
            ? "No usable models — add one with “+ model” or configure a provider"
            : "Switch model for this workspace (saved as default)"
      }
      value={value}
      onChange={(key) => void apply(key)}
      options={models.map((m) => {
        const route = modelRouteForProvider(m.provider, cliPrefs);
        const name = m.displayName ?? m.modelId;
        return {
          value: `${m.provider}/${m.modelId}`,
          label: (
            <span className="model-option-label">
              <span className="model-option-name">{name}</span>
              <span className={`pill route-pill ${route.kind}`} title={route.title}>
                {route.label}
              </span>
            </span>
          ),
          searchText: `${name} ${m.modelId} ${m.provider} ${route.label}`,
          hint: m.contextWindow ? `${m.provider} · ${formatTokens(m.contextWindow)}` : m.provider,
          group: isLocalProvider(m.provider) ? "Local" : "Cloud",
        };
      })}
    />
  );
}
