/**
 * New-chat dialog (§7.5): pick a mode, optionally bind a folder (project),
 * optionally resume a previous session of that folder. Uses Tauri's native
 * directory picker when available.
 */
import { useState } from "react";
import type { ModeId } from "@pi-desktop/protocol";

const MODES: ModeId[] = ["chat", "code"];
const NEEDS_DIR: ModeId[] = ["code"];
/** Display labels: code mode is presented as "project". */
const MODE_LABELS: Partial<Record<ModeId, string>> = { code: "project" };

declare global {
  interface Window {
    __TAURI__?: {
      dialog?: { open(options: { directory: boolean; title?: string }): Promise<string | null> };
      notification?: {
        isPermissionGranted(): Promise<boolean>;
        requestPermission(): Promise<"granted" | "denied" | "default">;
        sendNotification(options: { title: string; body?: string }): void;
      };
      core?: {
        invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
      };
      window?: {
        getCurrentWindow(): {
          minimize(): Promise<void>;
          unminimize?(): Promise<void>;
          toggleMaximize(): Promise<void>;
          setFocus?(): Promise<void>;
          close(): Promise<void>;
          onCloseRequested?(
            handler: (event: { preventDefault(): void }) => void,
          ): Promise<() => void>;
        };
      };
      webview?: {
        getCurrentWebview(): {
          onDragDropEvent(
            handler: (event: {
              payload: { type: "enter" | "over" | "leave" | "drop"; paths?: string[] };
            }) => void,
          ): Promise<() => void>;
        };
      };
    };
  }
}

export function OpenWorkspaceModal({
  onOpen,
  onCancel,
  initialDir,
}: {
  onOpen: (mode: ModeId, cwd: string | undefined) => void;
  onCancel: () => void;
  /** Prefill the project folder (e.g. "+ chat" on an open project). */
  initialDir?: string;
}) {
  const [mode, setMode] = useState<ModeId>("chat");
  const [dir, setDir] = useState(initialDir ?? "");
  const needsDir = NEEDS_DIR.includes(mode);
  const nativePicker = window.__TAURI__?.dialog?.open;

  const browse = async () => {
    const picked = await nativePicker?.({ directory: true, title: "Select project folder" });
    if (picked) setDir(picked);
  };

  const open = () => {
    // Folder binding is a code-mode concept; other modes only inherit the
    // project folder when opened from a project's "+" button.
    const cwd = (needsDir ? dir.trim() : initialDir?.trim() ?? "") || undefined;
    if (needsDir && !cwd) return;
    onOpen(mode, cwd);
  };

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">New chat</div>

        <div className="mode-select">
          {MODES.map((m) => (
            <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {MODE_LABELS[m] ?? m}
            </button>
          ))}
        </div>

        {needsDir && (
          <div className="row" style={{ margin: 0 }}>
            <input
              autoFocus
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="Project folder"
              onKeyDown={(e) => e.key === "Enter" && open()}
            />
            {nativePicker && <button onClick={browse}>Browse…</button>}
          </div>
        )}

        <div className="dialog-actions">
          <button className="primary" disabled={needsDir && !dir.trim()} onClick={() => open()}>
            Open
          </button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
