/** Plugin/package management pane (§2). Hidden unless supportsPluginInstall. */
import { useCallback, useEffect, useState } from "react";
import type { PluginInfo } from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";

export function Plugins({ client }: { client: HostClient }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setPlugins(await client.send({ type: "plugin_list" }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <h2>Plugins</h2>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="npm:@scope/pkg · git:host/repo@ref · /local/path"
        />
        <button
          className="primary"
          disabled={busy || !source}
          onClick={() => run(() => client.send({ type: "plugin_install", source }))}
        >
          Install
        </button>
        <button disabled={busy} onClick={() => run(() => client.send({ type: "plugin_update" }))}>
          Update all
        </button>
      </div>
      <ul className="list">
        {plugins.map((p) => (
          <li key={`${p.scope}:${p.source}`}>
            <span>{p.name}</span>
            <span className="dim">{p.source}</span>
            <span className="dim">{p.scope}</span>
            <button
              className="danger"
              disabled={busy}
              onClick={() => run(() => client.send({ type: "plugin_remove", source: p.source }))}
            >
              remove
            </button>
          </li>
        ))}
        {plugins.length === 0 && <li className="dim">No packages installed.</li>}
      </ul>
    </div>
  );
}
