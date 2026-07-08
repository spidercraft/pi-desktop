/**
 * Per-chat tool access dialog (opened from a chat's ⋯ menu). Lets the user turn
 * individual tools on/off for this chat, overriding the Settings default. Saving
 * reloads the chat's session with the new tool set (history is preserved).
 */
import { useState } from "react";
import type { WorkspaceInfo } from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import { ToolToggles } from "./ToolToggles.js";

export function ToolsDialog({
  client,
  workspace,
  onClose,
  onError,
}: {
  client: HostClient;
  workspace: WorkspaceInfo;
  onClose: () => void;
  onError?: (message: string) => void;
}) {
  const [disabled, setDisabled] = useState<string[]>(workspace.disabledTools ?? []);

  const save = () => {
    void client
      .send({ type: "set_disabled_tools", sessionId: workspace.sessionId, tools: disabled })
      .catch((err) => onError?.((err as Error).message));
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">Tools for this chat</div>
        <div className="dim">
          Turn a tool off to stop the model using it in this chat. Saving reloads the chat with
          the new tool set — its history is kept. MCP tools are always available.
        </div>
        <ToolToggles client={client} disabled={disabled} onChange={setDisabled} />
        <div className="dialog-actions">
          <button className="primary" onClick={save}>
            Save
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
