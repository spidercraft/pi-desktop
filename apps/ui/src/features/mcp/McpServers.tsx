/** MCP server management pane (§7.7). Hidden unless supportsMcpBridge. */
import { useCallback, useEffect, useState } from "react";
import type { McpServerConfig, McpServerStatus } from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import { Toggle } from "../../components/Toggle.js";

const STATE_LABEL: Record<McpServerStatus["state"], string> = {
  connected: "connected",
  connecting: "connecting…",
  error: "offline",
  disabled: "disabled",
};

export function McpServers({ client }: { client: HostClient }) {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setServers(await client.send({ type: "list_mcp_servers" }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const add = async () => {
    if (!name.trim() || !target.trim()) return;
    setBusy(true);
    setError(undefined);
    // "npx foo --bar" → stdio server; "https://…" → HTTP/SSE server.
    const trimmed = target.trim();
    const config: McpServerConfig = /^https?:\/\//i.test(trimmed)
      ? { name: name.trim(), url: trimmed }
      : (() => {
          const [command, ...args] = trimmed.split(/\s+/);
          return { name: name.trim(), command, args };
        })();
    try {
      await client.send({ type: "add_mcp_server", config });
      setName("");
      setTarget("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div className="pane">
      <h2>MCP Servers</h2>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <input
          style={{ flex: "0 0 140px" }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
        />
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="command (npx -y @scope/server) or URL (https://…)"
        />
        <button className="primary" disabled={busy || !name.trim() || !target.trim()} onClick={add}>
          Add
        </button>
      </div>
      <div className="dim">
        Tools from newly added servers become available in workspaces opened afterwards.
      </div>
      <ul className="list">
        {servers.map((s) => (
          <li key={s.name}>
            <span>{s.name}</span>
            <span className={s.state === "connected" ? "ok" : s.state === "error" ? "error" : "dim"} style={{ margin: 0 }}>
              {s.state === "error"
                ? s.timedOut
                  ? "timed out"
                  : s.retrying
                    ? "reconnecting…"
                    : STATE_LABEL.error
                : STATE_LABEL[s.state]}
            </span>
            {s.state === "error" && s.retrying && <span className="spinner" />}
            {s.state === "error" ? (
              <span
                className="dim"
                style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={s.lastError ?? "This MCP server is currently offline — its tools are unavailable."}
              >
                {s.timedOut
                  ? "timed out — retrying every minute"
                  : s.retrying
                    ? "offline — retrying automatically"
                    : "currently offline"}
                {s.lastError ? ` — ${s.lastError}` : ""}
              </span>
            ) : s.state === "disabled" ? (
              <span className="dim">tools paused</span>
            ) : (
              <span className="dim">{s.toolCount} tools</span>
            )}
            <Toggle
              checked={s.state !== "disabled"}
              disabled={busy}
              title={
                s.state === "disabled"
                  ? "Turn this server on and connect it"
                  : "Turn this server off (keeps it in the list)"
              }
              onChange={async (next) => {
                setBusy(true);
                await client
                  .send({ type: "set_mcp_server_enabled", name: s.name, enabled: next })
                  .catch((err) => setError((err as Error).message));
                setBusy(false);
                await refresh();
              }}
            />
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                await client.send({ type: "remove_mcp_server", name: s.name }).catch(() => {});
                await refresh();
              }}
            >
              remove
            </button>
          </li>
        ))}
        {servers.length === 0 && <li className="dim">No MCP servers configured.</li>}
      </ul>
    </div>
  );
}
