/**
 * "models" button + dialog (§7.8): lists the models you have (trash bin next
 * to removable custom ones) with an "Add model" form behind a button at the
 * bottom. Pre-made provider presets fill in base URL / API dialect so those
 * fields stay hidden unless "advanced" (or Custom…) is chosen.
 */
import { useEffect, useState } from "react";
import type {
  CustomModelDef,
  HostSettings,
  ModelInfo,
  ModelPatch,
  ProviderInfo,
} from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import { notify } from "../../notifications.js";
import { Dropdown } from "../../components/Dropdown.js";
import { SearchBar } from "../../components/SearchBar.js";
import { Toggle } from "../../components/Toggle.js";
import {
  formatTokens,
  currentOfficialCliModels,
  isLocalProvider,
  localFirst,
  modelRouteForProvider,
  usesOfficialCliForProvider,
} from "../../models.js";
import { API_DIALECTS, CUSTOM_PRESET, MODEL_PRESETS } from "../../provider-presets.js";

const EMPTY: CustomModelDef = {
  provider: "ollama",
  modelId: "",
  baseUrl: "http://localhost:11434/v1",
  api: "openai-completions",
};

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <path
        fill="currentColor"
        d="M6 1.5A1.5 1.5 0 0 1 7.5 0h1A1.5 1.5 0 0 1 10 1.5V2h3.5a.75.75 0 0 1 0 1.5h-.56l-.63 10.09A2 2 0 0 1 10.31 15.5H5.69a2 2 0 0 1-2-1.91L3.06 3.5H2.5a.75.75 0 0 1 0-1.5H6v-.5zm1.5 0V2h1v-.5h-1zM4.56 3.5l.62 10a.5.5 0 0 0 .5.48h4.63a.5.5 0 0 0 .5-.48l.62-10H4.56zM6.75 5.5c.41 0 .75.34.75.75v5.5a.75.75 0 0 1-1.5 0v-5.5c0-.41.34-.75.75-.75zm2.5 0c.41 0 .75.34.75.75v5.5a.75.75 0 0 1-1.5 0v-5.5c0-.41.34-.75.75-.75z"
      />
    </svg>
  );
}

export function AddModel({ client, onAdded }: { client: HostClient; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"list" | "add" | "edit">("list");
  /** Model being edited (view === "edit") and its editable fields. */
  const [editing, setEditing] = useState<ModelInfo>();
  const [editName, setEditName] = useState("");
  const [editContext, setEditContext] = useState("");
  const [editMaxTokens, setEditMaxTokens] = useState("");
  const [editReasoning, setEditReasoning] = useState(false);
  const [presetId, setPresetId] = useState<string>("ollama");
  const [advanced, setAdvanced] = useState(false);
  const [def, setDef] = useState<CustomModelDef>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  /** Per-vendor "use official CLI" preference. */
  const [cliPrefs, setCliPrefs] = useState<NonNullable<HostSettings["useOfficialCli"]>>({});
  /** "provider/modelId" currently being removed. */
  const [removing, setRemoving] = useState<string>();
  /** Filter for the models list (name, id, provider). */
  const [query, setQuery] = useState("");

  const patch = (p: Partial<CustomModelDef>) => setDef((d) => ({ ...d, ...p }));

  /** Case-insensitive match against display name, model id, and provider. */
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? models.filter((m) =>
        [m.displayName ?? "", m.modelId, m.provider].some((s) =>
          s.toLowerCase().includes(needle),
        ),
      )
    : models;

  const preset = MODEL_PRESETS.find((p) => p.id === presetId);
  const isCustom = presetId === CUSTOM_PRESET;
  /** Provider id / base URL / API dialect: hidden unless advanced or custom. */
  const showScary = isCustom || advanced;
  const showApiKey = showScary || (preset?.needsApiKey ?? false);

  const pickPreset = (id: string) => {
    setPresetId(id);
    const p = MODEL_PRESETS.find((x) => x.id === id);
    if (p) patch({ provider: p.id, baseUrl: p.baseUrl, api: p.api });
  };

  const refreshModels = async () => {
    try {
      const [all, providers, settings] = await Promise.all([
        client.send<ModelInfo[]>({ type: "list_models" }),
        client.send<ProviderInfo[]>({ type: "list_providers" }).catch(() => [] as ProviderInfo[]),
        client.send<HostSettings>({ type: "get_settings" }).catch(() => undefined),
      ]);
      const configured = new Set(providers.filter((p) => p.hasCredentials).map((p) => p.id));
      const cliPrefs = settings?.useOfficialCli ?? {};
      // Same set the model picker offers, plus custom models even when their
      // server is currently unreachable (so they can still be removed).
      const mine = all.filter(
        (m) =>
          m.custom ||
          usesOfficialCliForProvider(m.provider, cliPrefs) ||
          (m.available && (configured.has(m.provider) || isLocalProvider(m.provider))),
      );
      setCliPrefs(cliPrefs);
      setModels(localFirst(currentOfficialCliModels(mine, cliPrefs)));
    } catch {
      setModels([]);
    }
  };

  useEffect(() => {
    if (open) void refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    setOpen(false);
    setView("list");
    setQuery("");
  };

  const save = async () => {
    setBusy(true);
    try {
      await client.send({ type: "add_model", def });
      const name = def.displayName?.trim() || def.modelId;
      setDef(EMPTY);
      setPresetId("ollama");
      setAdvanced(false);
      setView("list");
      await refreshModels();
      onAdded();
      notify.success(`Model added — ${name}.`);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (model: ModelInfo) => {
    setEditing(model);
    setEditName(model.displayName ?? "");
    setEditContext(model.contextWindow ? String(model.contextWindow) : "");
    setEditMaxTokens(model.maxTokens ? String(model.maxTokens) : "");
    setEditReasoning(model.reasoning ?? false);
    setView("edit");
  };

  const saveEdit = async () => {
    if (!editing) return;
    const patch: ModelPatch = {};
    const name = editName.trim();
    if (name && name !== (editing.displayName ?? "")) patch.displayName = name;
    const context = Number(editContext);
    if (editContext && Number.isFinite(context) && context > 0 && context !== editing.contextWindow) {
      patch.contextWindow = context;
    }
    const maxTokens = Number(editMaxTokens);
    if (editMaxTokens && Number.isFinite(maxTokens) && maxTokens > 0 && maxTokens !== editing.maxTokens) {
      patch.maxTokens = maxTokens;
    }
    if (editReasoning !== (editing.reasoning ?? false)) patch.reasoning = editReasoning;
    if (Object.keys(patch).length === 0) {
      setView("list");
      return;
    }
    setBusy(true);
    try {
      const label = editing.displayName ?? editing.modelId;
      await client.send({
        type: "update_model",
        provider: editing.provider,
        modelId: editing.modelId,
        patch,
      });
      setView("list");
      setEditing(undefined);
      await refreshModels();
      onAdded(); // refresh the model picker
      notify.success(`Model updated — ${label}.`);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (model: ModelInfo) => {
    const key = `${model.provider}/${model.modelId}`;
    setRemoving(key);
    try {
      await client.send({ type: "remove_model", provider: model.provider, modelId: model.modelId });
      await refreshModels();
      onAdded(); // refresh the model picker
      notify.success(`Model removed — ${model.displayName ?? model.modelId}.`);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setRemoving(undefined);
    }
  };

  return (
    <>
      <button title="View, add or remove models" onClick={() => setOpen(true)}>
        models
      </button>
      {open && (
        <div className="overlay" onClick={close}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">
              {view === "list"
                ? "Models"
                : view === "edit"
                  ? `Edit ${editing?.displayName ?? editing?.modelId ?? "model"}`
                  : "Add model"}
            </div>

            {view === "list" ? (
              <>
                <SearchBar
                  value={query}
                  onChange={setQuery}
                  placeholder="Search models…"
                  autoFocus
                />
                <div className="custom-model-list">
                  {models.length === 0 && (
                    <div className="dim">No models yet — add one below.</div>
                  )}
                  {filtered.length === 0 && models.length > 0 && (
                    <div className="dim">No models match “{query}”.</div>
                  )}
                  {filtered.map((m) => {
                    const key = `${m.provider}/${m.modelId}`;
                    const route = modelRouteForProvider(m.provider, cliPrefs);
                    return (
                      <div key={key} className="custom-model-row">
                        <span className="custom-model-name">{m.displayName ?? m.modelId}</span>
                        {isLocalProvider(m.provider) && <span className="pill">local</span>}
                        <span className={`pill route-pill ${route.kind}`} title={route.title}>
                          {route.label}
                        </span>
                        <span className="dim">{m.provider}</span>
                        {m.contextWindow && (
                          <span className="dim" title="Context window">
                            {formatTokens(m.contextWindow)}
                          </span>
                        )}
                        <button
                          className="icon-btn"
                          title={`Edit ${key} (context window, thinking, …)`}
                          onClick={() => startEdit(m)}
                        >
                          ✎
                        </button>
                        {m.custom ? (
                          <button
                            className="danger icon-btn"
                            disabled={removing === key}
                            title={`Remove ${key}`}
                            onClick={() => void remove(m)}
                          >
                            {removing === key ? "…" : <TrashIcon />}
                          </button>
                        ) : (
                          <span className="icon-btn-placeholder" title="Built-in model" />
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="dialog-actions">
                  <button className="primary" onClick={() => setView("add")}>
                    + Add model
                  </button>
                  <button onClick={close}>Close</button>
                </div>
              </>
            ) : view === "edit" ? (
              <>
                <div className="field-grid">
                  <label>Display name</label>
                  <input
                    value={editName}
                    placeholder={editing?.modelId}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                  <label>Context window</label>
                  <input
                    type="number"
                    value={editContext}
                    placeholder="tokens, e.g. 128000"
                    onChange={(e) => setEditContext(e.target.value)}
                  />
                  <label>Max output tokens</label>
                  <input
                    type="number"
                    value={editMaxTokens}
                    placeholder="tokens, e.g. 16384"
                    onChange={(e) => setEditMaxTokens(e.target.value)}
                  />
                  <label>Thinking</label>
                  <Toggle
                    checked={editReasoning}
                    onChange={setEditReasoning}
                    label={<span className="dim">reasoning model</span>}
                    title="Enables the thinking-level picker for this model"
                  />
                </div>
                <div className="dim">
                  {editing?.custom
                    ? "Saved to this model's entry in models.json."
                    : "Saved as an override on the built-in model definition."}{" "}
                  Open chats pick the change up on their next model switch or restart.
                </div>
                <div className="dialog-actions">
                  <button className="primary" disabled={busy} onClick={() => void saveEdit()}>
                    {busy ? "Saving…" : "Save"}
                  </button>
                  <button onClick={() => setView("list")}>Back</button>
                </div>
              </>
            ) : (
              <>
                <div className="field-grid">
                  <label>Provider</label>
                  <Dropdown
                    value={presetId}
                    onChange={pickPreset}
                    options={[
                      ...MODEL_PRESETS.map((p) => ({
                        value: p.id,
                        label: p.label,
                        hint: p.needsApiKey ? undefined : "local",
                      })),
                      { value: CUSTOM_PRESET, label: "Custom…" },
                    ]}
                  />
                  {showScary && (
                    <>
                      <label>Provider id</label>
                      <input
                        value={def.provider}
                        placeholder="ollama, lmstudio, my-server…"
                        onChange={(e) => patch({ provider: e.target.value })}
                      />
                    </>
                  )}
                  <label>Model id</label>
                  <input
                    autoFocus
                    value={def.modelId}
                    placeholder={preset?.modelPlaceholder ?? "llama3.3:70b, qwen2.5-coder…"}
                    onChange={(e) => patch({ modelId: e.target.value })}
                  />
                  <label>Display name</label>
                  <input
                    value={def.displayName ?? ""}
                    placeholder="(optional)"
                    onChange={(e) => patch({ displayName: e.target.value || undefined })}
                  />
                  <label>Thinking</label>
                  <Toggle
                    checked={def.reasoning ?? false}
                    onChange={(checked) => patch({ reasoning: checked || undefined })}
                    label={<span className="dim">reasoning model</span>}
                    title="Enables the thinking-level picker for this model"
                  />
                  {showScary && (
                    <>
                      <label>Base URL</label>
                      <input
                        value={def.baseUrl ?? ""}
                        placeholder="http://localhost:11434/v1"
                        onChange={(e) => patch({ baseUrl: e.target.value || undefined })}
                      />
                      <label>API</label>
                      <Dropdown
                        value={def.api}
                        onChange={(api) => patch({ api })}
                        options={API_DIALECTS.map((a) => ({ value: a.id, label: a.label }))}
                      />
                    </>
                  )}
                  {showApiKey && (
                    <>
                      <label>API key</label>
                      <input
                        type="password"
                        value={def.apiKey ?? ""}
                        placeholder="(optional — local servers usually need none)"
                        onChange={(e) => patch({ apiKey: e.target.value || undefined })}
                      />
                    </>
                  )}
                  {showScary && (
                    <>
                      <label>Context window</label>
                      <input
                        type="number"
                        value={def.contextWindow ?? ""}
                        placeholder="(optional)"
                        onChange={(e) =>
                          patch({
                            contextWindow: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                      />
                    </>
                  )}
                </div>

                <div className="dialog-actions">
                  <button
                    className="primary"
                    disabled={busy || !def.provider.trim() || !def.modelId.trim()}
                    onClick={save}
                  >
                    {busy ? "Saving…" : "Add model"}
                  </button>
                  <button onClick={() => setView("list")}>Back</button>
                  {!isCustom && (
                    <button
                      className="link-btn"
                      title="Show provider id, base URL and API dialect"
                      onClick={() => setAdvanced((a) => !a)}
                    >
                      {advanced ? "hide advanced" : "advanced…"}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
