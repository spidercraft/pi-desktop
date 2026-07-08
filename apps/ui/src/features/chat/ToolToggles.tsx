/**
 * A checklist of every tool the model can use, with an on/off toggle each.
 * Reused for the per-chat tool access dialog and the Settings default. The
 * caller owns the "disabled" list; this component just renders and toggles it.
 */
import { useEffect, useState } from "react";
import type { ToolInfo } from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import { Toggle } from "../../components/Toggle.js";

export function ToolToggles({
  client,
  disabled,
  onChange,
}: {
  client: HostClient;
  /** Tool names currently disabled. */
  disabled: string[];
  onChange: (disabled: string[]) => void;
}) {
  const [tools, setTools] = useState<ToolInfo[]>([]);

  useEffect(() => {
    client
      .send<ToolInfo[]>({ type: "list_tools" })
      .then((list) => setTools(list ?? []))
      .catch(() => {});
  }, [client]);

  const disabledSet = new Set(disabled);
  const setEnabled = (name: string, enabled: boolean) => {
    const next = new Set(disabled);
    if (enabled) next.delete(name);
    else next.add(name);
    onChange([...next]);
  };

  if (tools.length === 0) return <div className="dim">No tools available.</div>;

  return (
    <div className="tool-toggles">
      {tools.map((t) => (
        <Toggle
          key={t.name}
          checked={!disabledSet.has(t.name)}
          onChange={(enabled) => setEnabled(t.name, enabled)}
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
  );
}
