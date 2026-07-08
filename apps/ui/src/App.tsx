import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type {
  HarnessCapabilities,
  HistoryItem,
  HostSettings,
  ModeId,
  PermissionPolicyConfig,
  WorkspaceInfo,
} from "@pi-desktop/protocol";
import { HostClient, type UiRequestEnvelope } from "./client.js";
import { dismiss, notify, Notifications } from "./notifications.js";
import { TooltipLayer } from "./components/Tooltip.js";
import { applyEvent, type ChatItem } from "./chat-model.js";
import { AddModel } from "./features/chat/AddModel.js";
import { Chat } from "./features/chat/Chat.js";
import { ModelPicker } from "./features/chat/ModelPicker.js";
import { ThinkingPicker } from "./features/chat/ThinkingPicker.js";
import { ToolsDialog } from "./features/chat/ToolsDialog.js";
import { PermissionDialog } from "./features/permissions/PermissionDialog.js";
import { PolicyControl } from "./features/permissions/PolicyControl.js";
import { SettingsModal } from "./features/settings/Settings.js";
import { todoList } from "./features/chat/ToolCard.js";
import { SidePanel } from "./features/panel/SidePanel.js";
import type { ViewerContent } from "./features/viewer/CodeViewer.js";
import { FileTree } from "./features/workspaces/FileTree.js";
import { OpenWorkspaceModal } from "./features/workspaces/OpenWorkspaceModal.js";

/** Last fenced code block in a message, for auto-opening the viewer. */
function lastCodeBlock(text: string): ViewerContent | undefined {
  const blocks = [...text.matchAll(/```([\w-]*)[^\S\n]*\n([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1];
  if (!last || !last[2].trim()) return undefined;
  return { lang: last[1] || undefined, code: last[2] };
}

/** Map a persisted transcript (from get_history) into renderable chat items.
 *  Shared by the resume-restore path and the post-compaction rebuild. */
function historyToItems(history: HistoryItem[]): ChatItem[] {
  return history.map((m, i): ChatItem => {
    if (m.role === "user") return { kind: "user", text: m.text };
    if (m.role === "tool") {
      return {
        kind: "tool",
        toolCallId: `history-${i}`,
        toolName: m.toolName ?? "tool",
        args: m.args,
        result: m.text || undefined,
        isError: m.isError,
        done: true,
      };
    }
    return {
      kind: "assistant",
      text: m.text,
      streaming: false,
      outputTokens: m.usage?.outputTokens,
      contextTokens:
        m.usage?.totalTokens ??
        (m.usage ? m.usage.inputTokens + m.usage.outputTokens : undefined),
      contextWindow: m.usage?.contextWindow,
    };
  });
}

/** Recency bucket for the sidebar chat list. */
function timeBucket(ts?: number): string {
  if (!ts) return "Older";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startToday) return "Today";
  if (ts >= startToday - 86_400_000) return "Yesterday";
  if (ts >= startToday - 6 * 86_400_000) return "This week";
  return "Older";
}

/** Project display name: the folder's basename. */
function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

const COLLAPSED_KEY = "pi-desktop.collapsed-projects";
const SIDEBAR_W_KEY = "pi-desktop.sidebar-width";
const PANEL_W_KEY = "pi-desktop.panel-width";
const SIDEBAR_HIDDEN_KEY = "pi-desktop.sidebar-hidden";
const CHAT_COLUMN_WIDTH = 780;
const CHAT_HORIZONTAL_PADDING = 24;
const MIN_CHAT_MAIN_WIDTH = 360;
const MIN_PANEL_WIDTH = 280;

function loadWidth(key: string, fallback: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function loadCollapsed(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

function FolderIcon() {
  return (
    <svg className="project-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <path
        fill="currentColor"
        d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.2c.4 0 .78.16 1.06.44l.86.86H13A1.5 1.5 0 0 1 14.5 5.3v7.2A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5V4z"
      />
    </svg>
  );
}

/** Chat name derived from the first message: cleaned and word-truncated. */
function chatNameFrom(text: string): string {
  const clean = text
    .replace(/@file:"[^"]*"|@"[^"]*"/g, "")
    .replace(/@[\w.\-/:\\]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= 32) return clean;
  const cut = clean.slice(0, 32);
  const space = cut.lastIndexOf(" ");
  return (space > 16 ? cut.slice(0, space) : cut) + "…";
}

interface CtxMenu {
  x: number;
  y: number;
  /** Set when the menu targets a chat. */
  sessionId?: string;
  /** Set when the menu targets a project (folder). */
  cwd?: string;
}

interface TextPrompt {
  title: string;
  placeholder?: string;
  initial?: string;
  /** Render a textarea instead of a single-line input (e.g. prompt editing). */
  multiline?: boolean;
  onSubmit: (value: string) => void;
}

function TextPromptDialog({ prompt, onClose }: { prompt: TextPrompt; onClose: () => void }) {
  const [value, setValue] = useState(prompt.initial ?? "");
  const submit = () => {
    onClose();
    prompt.onSubmit(value.trim());
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{prompt.title}</div>
        {prompt.multiline ? (
          <textarea
            autoFocus
            className="prompt-editor"
            value={value}
            placeholder={prompt.placeholder}
            rows={12}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <input
            autoFocus
            value={value}
            placeholder={prompt.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        )}
        <div className="dialog-actions">
          <button className="primary" onClick={submit}>
            OK
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [connected, setConnected] = useState(false);
  /** Splash screen: shown until the host is connected and models are loaded. */
  const [booting, setBooting] = useState(true);
  const [capabilities, setCapabilities] = useState<HarnessCapabilities>();
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [activeSession, setActiveSession] = useState<string>();
  const [transcripts, setTranscripts] = useState<Record<string, ChatItem[]>>({});
  const [uiRequests, setUiRequests] = useState<UiRequestEnvelope[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatDir, setNewChatDir] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [filesOpen, setFilesOpen] = useState<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(() => loadWidth(SIDEBAR_W_KEY, 240));
  const [panelWidth, setPanelWidth] = useState(() => loadWidth(PANEL_W_KEY, 480));
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1",
  );
  const [panelHidden, setPanelHidden] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const toggleSidebar = () =>
    setSidebarHidden((h) => {
      try {
        localStorage.setItem(SIDEBAR_HIDDEN_KEY, h ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !h;
    });

  const maxPanelWidthFor = (leftRailWidth: number) =>
    Math.max(
      MIN_PANEL_WIDTH,
      Math.min(900, viewportWidth - leftRailWidth - MIN_CHAT_MAIN_WIDTH),
    );

  /** Drag a divider to resize the left sidebar or right panel. */
  const startResize = (e: ReactMouseEvent, side: "left" | "right") => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = side === "left" ? sidebarWidth : panelWidth;
    const onMove = (ev: globalThis.MouseEvent) => {
      const dx = ev.clientX - startX;
      if (side === "left") {
        const w = Math.min(420, Math.max(160, startWidth + dx));
        setSidebarWidth(w);
        try {
          localStorage.setItem(SIDEBAR_W_KEY, String(w));
        } catch { /* ignore */ }
      } else {
        const maxPanelWidth = maxPanelWidthFor(sidebarHidden ? 0 : sidebarWidth);
        const w = Math.min(maxPanelWidth, Math.max(MIN_PANEL_WIDTH, startWidth - dx));
        setPanelWidth(w);
        try {
          localStorage.setItem(PANEL_W_KEY, String(w));
        } catch { /* ignore */ }
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const toggleFiles = (cwd: string) =>
    setFilesOpen((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  const toggleProject = (cwd: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const [modelsVersion, setModelsVersion] = useState(0);
  /** Bumped after a model switch so the thinking picker refetches its levels
   *  (available levels depend on the active model). */
  const [thinkingVersion, setThinkingVersion] = useState(0);

  // Re-fetch model lists whenever the host connection is (re)established.
  // The home composer mounts its ModelPicker before the socket opens, so the
  // first fetch fails ("Not connected to host") and would stay "no models".
  useEffect(() => {
    if (connected) setModelsVersion((v) => v + 1);
  }, [connected]);

  // Boot splash: dismissed once the host answered the first model-list fetch
  // (i.e. the app is actually usable), or after a 15s safety timeout so a
  // broken host never wedges the UI behind the splash.
  useEffect(() => {
    if (!connected || !booting) return;
    let cancelled = false;
    void client
      .send({ type: "list_models" })
      .catch(() => {})
      .then(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, booting]);
  useEffect(() => {
    const timer = window.setTimeout(() => setBooting(false), 15_000);
    return () => clearTimeout(timer);
  }, []);
  const [viewer, setViewer] = useState<ViewerContent>();
  const [selectedFilePath, setSelectedFilePath] = useState<string>();
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>();
  const [textPrompt, setTextPrompt] = useState<TextPrompt>();
  /** Chat whose per-chat tool access dialog is open. */
  const [toolsChat, setToolsChat] = useState<WorkspaceInfo>();

  /* ------------------------------ boot splash ------------------------------ */

  /** loading → fading (0.5s opacity transition) → done (unmounted). */
  const [boot, setBoot] = useState<"loading" | "fading" | "done">("loading");
  const [bootMsg, setBootMsg] = useState("Connecting to host…");
  const bootStart = useRef(Date.now());

  useEffect(() => {
    if (boot !== "loading" || !connected) return;
    setBootMsg("Loading models…");
    let cancelled = false;
    void (async () => {
      // Ready = the model list answered (empty is fine — the app is usable).
      try {
        await client.send({ type: "list_models" });
      } catch {
        /* adapter without providers — proceed */
      }
      // Keep the splash up briefly so it eases out instead of flashing.
      const elapsed = Date.now() - bootStart.current;
      if (elapsed < 900) await new Promise((r) => setTimeout(r, 900 - elapsed));
      if (cancelled) return;
      setBoot("fading");
      setTimeout(() => setBoot("done"), 550);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, boot]);

  // Gentle nudge if the host never shows up.
  useEffect(() => {
    if (boot !== "loading" || connected) return;
    const timer = setTimeout(
      () => setBootMsg("Still connecting — make sure the host is running…"),
      8000,
    );
    return () => clearTimeout(timer);
  }, [boot, connected]);

  // Switching chats closes the side panel and drops the previous chat's code
  // viewer — its content belongs to the chat it came from. Opening code (or
  // the topbar "panel" button) reopens it.
  useEffect(() => {
    setPanelHidden(true);
    setViewer(undefined);
    setSelectedFilePath(undefined);
  }, [activeSession]);

  /** Error feedback → the app-wide notification stack. */
  const showToast = (message: string) => notify.error(message);
  const disconnectedNotification = useRef<number>();

  const activeRef = useRef<string>();
  activeRef.current = activeSession;
  const workspacesRef = useRef<WorkspaceInfo[]>([]);
  workspacesRef.current = workspaces;

  const openNotificationChat = (sessionId?: string): void => {
    if (!sessionId || !workspacesRef.current.some((w) => w.sessionId === sessionId)) return;
    setSettingsOpen(false);
    setShowNewChat(false);
    setActiveSession(sessionId);
  };

  /** Sessions we've already auto-named, so we never rename on later messages —
   *  tracked by id so it works even before the workspace shows up in state. */
  const namedSessions = useRef<Set<string>>(new Set());
  /** Messages queued while the agent is busy, per session. Held OUT of the
   *  transcript (shown only in the queue preview) and dropped into the
   *  conversation when their turn starts — i.e. right after the current
   *  response finishes. */
  const [queuedMsgs, setQueuedMsgs] = useState<Record<string, string[]>>({});
  const queuedRef = useRef<Record<string, string[]>>({});
  const setQueuedFor = (sessionId: string, list: string[]) => {
    const next = { ...queuedRef.current, [sessionId]: list };
    queuedRef.current = next;
    setQueuedMsgs(next);
  };
  const transcriptsRef = useRef<Record<string, ChatItem[]>>({});

  const setTranscript = (sessionId: string, items: ChatItem[]) => {
    transcriptsRef.current = { ...transcriptsRef.current, [sessionId]: items };
    setTranscripts(transcriptsRef.current);
  };

  const appendLocal = (sessionId: string, item: ChatItem) => {
    setTranscript(sessionId, [...(transcriptsRef.current[sessionId] ?? []), item]);
  };

  const lastUserMessage = (sessionId: string): string | undefined => {
    const items = transcriptsRef.current[sessionId] ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "user" && !item.queued) return item.text;
    }
    return undefined;
  };

  const notifyMessageError = (sessionId: string, errorMessage: string): void => {
    const retryText = lastUserMessage(sessionId);
    if (!retryText) {
      notify.error(`Message error: ${errorMessage}`);
      return;
    }
    void notify
      .confirm(`Message error: ${errorMessage}\nRetry?`, {
        kind: "error",
        confirmLabel: "Retry",
        cancelLabel: "Dismiss",
      })
      .then((retry) => {
        if (retry) sendPromptTo(sessionId, retryText);
      });
  };

  const notificationLabel = (sessionId?: string): string => {
    const workspace = sessionId
      ? workspacesRef.current.find((w) => w.sessionId === sessionId)
      : undefined;
    const items = sessionId ? transcriptsRef.current[sessionId] ?? [] : [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "user" && !item.queued) return chatNameFrom(item.text) || "this task";
    }
    if (workspace?.name) return workspace.name;
    if (workspace?.cwd && !workspace.defaultWorkspace) return folderName(workspace.cwd);
    return "this task";
  };

  const inputNotificationLabel = (envelope: UiRequestEnvelope): string => {
    const task = notificationLabel(envelope.sessionId);
    const title = envelope.request.title.trim();
    return title ? `${task} — ${chatNameFrom(title)}` : task;
  };

  const client = useMemo(
    () =>
      new HostClient({
        onConnectionChange: (isConnected) => {
          setConnected(isConnected);
          if (isConnected) {
            if (disconnectedNotification.current !== undefined) {
              dismiss(disconnectedNotification.current);
              disconnectedNotification.current = undefined;
            }
            return;
          }
          if (disconnectedNotification.current === undefined) {
            disconnectedNotification.current = notify.error("Pi agent harness is not connected.", {
              durationMs: 0,
            });
          }
        },
        onHello: (caps, ws) => {
          setCapabilities(caps);
          setWorkspaces(ws);
        },
        onWorkspaces: setWorkspaces,
        onEvent: (sessionId, event) => {
          if (event.type === "session_replaced") {
            const moved = {
              ...transcriptsRef.current,
              [event.newSessionId]: transcriptsRef.current[sessionId] ?? [],
            };
            delete moved[sessionId];
            transcriptsRef.current = moved;
            setTranscripts(moved);
            // The host carries the name onto the new session; carry the
            // "already named" flag too so we don't rename over it.
            if (namedSessions.current.has(sessionId)) {
              namedSessions.current.add(event.newSessionId);
              namedSessions.current.delete(sessionId);
            }
            // Carry any queued messages onto the replacement session.
            if (queuedRef.current[sessionId]) {
              const q = { ...queuedRef.current, [event.newSessionId]: queuedRef.current[sessionId] };
              delete q[sessionId];
              queuedRef.current = q;
              setQueuedMsgs(q);
            }
            if (activeRef.current === sessionId) setActiveSession(event.newSessionId);
            return;
          }
          // Compaction succeeded: rebuild the transcript from the compacted
          // session so the visible chat matches what's actually in context
          // (summary + kept recent turns), and drop the context-fill donut to
          // the post-compaction size right away instead of waiting for the next
          // reply. On failure we fall through to applyEvent, which surfaces the
          // error line.
          if (event.type === "compaction_end" && !event.errorMessage) {
            const tokensAfter = event.tokensAfter;
            // Anything already in the transcript beyond the compaction marker is
            // fresh post-compaction streaming — preserve it across the async
            // history fetch so we don't clobber a reply that started meanwhile.
            const baseLen = (transcriptsRef.current[sessionId] ?? []).length;
            void client
              .send<HistoryItem[]>({ type: "get_history", sessionId })
              .then((history) => {
                const items = historyToItems(history);
                if (tokensAfter != null) {
                  for (let i = items.length - 1; i >= 0; i--) {
                    const it = items[i];
                    if (it.kind === "assistant") {
                      items[i] = { ...it, contextTokens: tokensAfter };
                      break;
                    }
                  }
                }
                items.push({ kind: "system", text: "Conversation compacted." });
                const tail = (transcriptsRef.current[sessionId] ?? []).slice(baseLen);
                setTranscript(sessionId, [...items, ...tail]);
              })
              .catch(() => {
                // History fetch failed — fall back to the plain marker so the
                // user still sees that compaction happened.
                setTranscript(
                  sessionId,
                  applyEvent(transcriptsRef.current[sessionId] ?? [], event),
                );
              });
            return;
          }
          // The host's queue is authoritative: when a message leaves it, it's
          // being answered → drop it into the transcript (after the reply that
          // just finished) and out of the preview. Messages leave FIFO (from the
          // front), so any leading buffered entries no longer in the queue were
          // delivered. (Follow-ups don't always emit a fresh agent_start, so we
          // key off queue_update, not agent_start.)
          if (event.type === "queue_update") {
            const queue = [...event.steering, ...event.followUp];
            const prev = queuedRef.current[sessionId] ?? [];
            let k = 0;
            while (k < prev.length && !prev.slice(k).every((t, i) => queue[i] === t)) k++;
            for (const text of prev.slice(0, k)) appendLocal(sessionId, { kind: "user", text });
            setQueuedFor(sessionId, queue);
          }
          setTranscript(sessionId, applyEvent(transcriptsRef.current[sessionId] ?? [], event));
          // Auto-open the viewer when the assistant delivers a code block.
          if (
            event.type === "message_end" &&
            event.role === "assistant" &&
            sessionId === activeRef.current
          ) {
            const block = lastCodeBlock(event.text);
            if (block) {
              setViewer(block);
              setPanelHidden(false); // new artifact → make sure the panel shows
            }
          }
          // New task-list update → auto-open the panel.
          if (
            event.type === "tool_execution_start" &&
            event.toolName === "set_todos" &&
            sessionId === activeRef.current
          ) {
            setPanelHidden(false);
          }
          if (event.type === "agent_end") {
            if (event.errorMessage) {
              notifyMessageError(sessionId, event.errorMessage);
            }
            // Finished task the user should return to.
            if (!event.aborted && !event.errorMessage) {
              notify.success(`Done: ${notificationLabel(sessionId)}`, {
                systemOnClick: () => openNotificationChat(sessionId),
              });
            }
          }
        },
        onUiRequest: (envelope) => {
          if (envelope.request.method === "notify") {
            const level = envelope.request.level;
            const message = envelope.request.message
              ? `${envelope.request.title}: ${envelope.request.message}`
              : envelope.request.title;
            notify(message, level === "error" ? "error" : "info", {
              systemOnClick: () => openNotificationChat(envelope.sessionId),
            });
            return;
          }
          notify.info(`Input needed: ${inputNotificationLabel(envelope)}`, {
            systemMessage: "is waiting for your input",
            systemOnClick: () => openNotificationChat(envelope.sessionId),
          });
          setUiRequests((q) => [...q, envelope]);
        },
      }),
    [],
  );
  useEffect(() => () => client.dispose(), [client]);

  const closeAllowedRef = useRef(false);
  const closingRef = useRef(false);

  const pauseStreamingBeforeClose = async () => {
    if (!workspacesRef.current.some((w) => w.isStreaming)) return;
    await Promise.race([
      client.send({ type: "pause_streaming" }),
      new Promise((resolve) => setTimeout(resolve, 5_500)),
    ]).catch(() => {});
  };

  const closeApp = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    await pauseStreamingBeforeClose();

    // Ask the shell to terminate both the webview and its supervised pi-host
    // process. Closing only the window can leave the sidecar alive, which keeps
    // the app running until the dev terminal is killed.
    if (window.__TAURI__?.core?.invoke) {
      try {
        await window.__TAURI__.core.invoke("close_app");
        return;
      } catch (err) {
        console.error("Native close failed; falling back to window close", err);
      }
    }

    closeAllowedRef.current = true;
    await window.__TAURI__?.window?.getCurrentWindow().close();
  };

  useEffect(() => {
    const appWindow = window.__TAURI__?.window?.getCurrentWindow();
    if (!appWindow?.onCloseRequested) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void appWindow
      .onCloseRequested((event) => {
        if (closeAllowedRef.current) return;
        event.preventDefault();
        void closeApp();
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  /** Give an unnamed chat a title from its first message. Reliable for project
   *  chats: it renames by sessionId and does NOT depend on the workspace already
   *  being in `workspaces` state (that arrives asynchronously from the host, so
   *  gating on it made the first-message rename silently no-op). */
  const nameChatIfUnnamed = (sessionId: string, text: string) => {
    if (namedSessions.current.has(sessionId)) return;
    // Respect an existing name (e.g. a manual rename) when we already know it.
    if (workspacesRef.current.find((w) => w.sessionId === sessionId)?.name) {
      namedSessions.current.add(sessionId);
      return;
    }
    const name = chatNameFrom(text);
    if (!name) return;
    namedSessions.current.add(sessionId);
    void client.send({ type: "rename_workspace", sessionId, name }).catch(() => {
      namedSessions.current.delete(sessionId); // let a later message retry
    });
  };

  // Restored/resumed chats: fetch the persisted transcript on first view.
  useEffect(() => {
    const sessionId = activeSession;
    if (!sessionId || transcriptsRef.current[sessionId]) return;
    let cancelled = false;
    void client
      .send<HistoryItem[]>({ type: "get_history", sessionId })
      .then((history) => {
        if (cancelled || transcriptsRef.current[sessionId]?.length) return;
        setTranscript(sessionId, historyToItems(history));
        // Restored chat that never got a name: derive one from its first message.
        const firstUser = history.find((m) => m.role === "user");
        if (firstUser) nameChatIfUnnamed(sessionId, firstUser.text);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession, client]);

  // Name restored chats on startup without waiting for a click: for any
  // workspace with no name yet, derive one from its first message. Each chat is
  // attempted once (nameChatIfUnnamed still guards against overwriting a name).
  const namingAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const w of workspaces) {
      if (w.name || namedSessions.current.has(w.sessionId)) continue;
      if (namingAttempted.current.has(w.sessionId)) continue;
      namingAttempted.current.add(w.sessionId);
      void client
        .send<HistoryItem[]>({ type: "get_history", sessionId: w.sessionId })
        .then((history) => {
          const firstUser = history.find((m) => m.role === "user");
          if (firstUser) nameChatIfUnnamed(w.sessionId, firstUser.text);
        })
        .catch(() => namingAttempted.current.delete(w.sessionId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, client]);

  const active = workspaces.find((w) => w.sessionId === activeSession);

  // Latest task list the agent published in a chat (set_todos tool).
  const latestTodosFor = (sessionId: string) => {
    const items = transcripts[sessionId] ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "tool" && item.toolName === "set_todos") return todoList(item.args);
    }
    return undefined;
  };

  const taskProgressForChats = (chats: WorkspaceInfo[]) => {
    let done = 0;
    let total = 0;
    for (const chat of chats) {
      const todos = latestTodosFor(chat.sessionId);
      if (!todos) continue;
      done += todos.filter((t) => t.status === "completed").length;
      total += todos.length;
    }
    return { done, total };
  };

  // Latest task list the agent published in the active chat (set_todos tool).
  const activeTodos = active ? latestTodosFor(active.sessionId) : undefined;
  const activeTodoCount = activeTodos?.length ?? 0;

  // When entering/restoring a chat that already has tasks, reveal the panel so
  // the task list is immediately visible. This also covers history loading after
  // the chat switch; manual hides stay respected until the active chat/count changes.
  useEffect(() => {
    if (activeSession && activeTodoCount > 0) setPanelHidden(false);
  }, [activeSession, activeTodoCount]);

  const panelHasContent = Boolean(viewer || activeTodoCount > 0);
  const panelVisible = Boolean(!panelHidden && panelHasContent);
  const leftRailWidth = sidebarHidden ? 0 : sidebarWidth;
  const effectivePanelWidth = panelVisible
    ? Math.min(panelWidth, maxPanelWidthFor(leftRailWidth))
    : 0;
  const rightRailWidth = effectivePanelWidth;
  const mainWidth = Math.max(0, viewportWidth - leftRailWidth - rightRailWidth);
  const targetCenterOffset = (rightRailWidth - leftRailWidth) / 2;
  // Keep the chat column centered in the full window when there is enough slack,
  // but clamp back into the chat pane as the window/panels get narrow.
  const maxResponsiveOffset = Math.max(
    0,
    (mainWidth - CHAT_HORIZONTAL_PADDING * 2 - CHAT_COLUMN_WIDTH) / 2,
  );
  const chatCenterOffset = Math.max(
    -maxResponsiveOffset,
    Math.min(maxResponsiveOffset, targetCenterOffset),
  );
  const chatMainStyle = {
    "--chat-center-offset": `${chatCenterOffset}px`,
  } as CSSProperties;

  const openWorkspace = async (mode: ModeId, cwd?: string, resumeSession?: string) => {
    const info = resumeSession
      ? await client.send<WorkspaceInfo>({ type: "open_session", path: resumeSession, cwd, mode })
      : await client.send<WorkspaceInfo>({ type: "open_workspace", mode, cwd });
    setActiveSession(info.sessionId);
    setShowNewChat(false);
  };

  const closeWorkspace = async (sessionId: string) => {
    // Remove locally immediately so project task progress/counts update as soon
    // as a chat is deleted, without waiting for the host workspace refresh.
    setWorkspaces((current) => {
      const next = current.filter((w) => w.sessionId !== sessionId);
      workspacesRef.current = next;
      return next;
    });
    const next = { ...transcriptsRef.current };
    delete next[sessionId];
    transcriptsRef.current = next;
    setTranscripts(next);
    if (queuedRef.current[sessionId]) {
      const q = { ...queuedRef.current };
      delete q[sessionId];
      queuedRef.current = q;
      setQueuedMsgs(q);
    }
    namedSessions.current.delete(sessionId);
    if (activeRef.current === sessionId) setActiveSession(undefined);
    await client.send({ type: "close_workspace", sessionId }).catch(() => {});
  };

  const sendPromptTo = (sessionId: string, text: string) => {
    // Unnamed chat (new or restored, any mode): name it after this message.
    nameChatIfUnnamed(sessionId, text);

    // Sent while the agent is busy → the host queues it as a follow-up. Don't
    // put it in the transcript now; the authoritative queue_update surfaces it in
    // the preview and moves it into the conversation when the current reply
    // finishes. Only messages sent while idle go straight into the transcript.
    const workspace = workspacesRef.current.find((w) => w.sessionId === sessionId);
    if (!workspace?.isStreaming) {
      appendLocal(sessionId, { kind: "user", text });
    }

    // @tool mentions ride along as text — the host turns them into a
    // "you MUST use these tools" directive for the model.
    client
      .send({ type: "prompt", sessionId, text })
      .catch((err) => notifyMessageError(sessionId, (err as Error).message));
  };

  const sendPrompt = (text: string) => {
    if (activeSession) sendPromptTo(activeSession, text);
  };

  /** Policy picked in the home composer, applied once the session exists. */
  const homePolicyRef = useRef<PermissionPolicyConfig>();

  /** Home composer (no chat selected): open a fresh chat-mode session,
   *  name it after the message, and send it as the first prompt. */
  const startHomeChat = async (text: string) => {
    try {
      const info = await client.send<WorkspaceInfo>({ type: "open_workspace", mode: "chat" });
      setActiveSession(info.sessionId);
      if (homePolicyRef.current) {
        void client
          .send({
            type: "set_permission_policy",
            sessionId: info.sessionId,
            policy: homePolicyRef.current,
          })
          .catch(() => {});
        homePolicyRef.current = undefined;
      }
      nameChatIfUnnamed(info.sessionId, text);
      sendPromptTo(info.sessionId, text);
    } catch (err) {
      showToast((err as Error).message);
    }
  };

  /** @goal from the home composer: open a fresh chat and set its goal, ready for
   *  the user's first message. */
  const startHomeGoal = async (goal?: string) => {
    if (!goal) return; // nothing to set (e.g. "@goal" with no text)
    try {
      const info = await client.send<WorkspaceInfo>({ type: "open_workspace", mode: "chat" });
      setActiveSession(info.sessionId);
      if (homePolicyRef.current) {
        void client
          .send({
            type: "set_permission_policy",
            sessionId: info.sessionId,
            policy: homePolicyRef.current,
          })
          .catch(() => {});
        homePolicyRef.current = undefined;
      }
      void client
        .send({ type: "set_goal", sessionId: info.sessionId, goal })
        .catch((err) => showToast((err as Error).message));
    } catch (err) {
      showToast((err as Error).message);
    }
  };

  /** Edited message resent: drop it and everything after it, then resend. The
   *  host trims its chat log to the same point so a reopened chat doesn't show
   *  the discarded messages next to the new ones. */
  const editPrompt = (index: number, text: string) => {
    if (!activeSession) return;
    const sessionId = activeSession;
    const items = transcriptsRef.current[sessionId] ?? [];
    // How many user messages precede the edited one — the host keeps these.
    const keepUserMessages = items.slice(0, index).filter((it) => it.kind === "user").length;
    setTranscript(sessionId, items.slice(0, index));
    appendLocal(sessionId, { kind: "user", text });
    void client
      .send({ type: "edit_prompt", sessionId, keepUserMessages, text })
      .catch((err) => showToast((err as Error).message));
  };

  const stopActive = () => {
    if (!activeSession) return;
    void client.send({ type: "abort", sessionId: activeSession }).catch(() => {});
  };

  const answerUi = (requestId: string, value: unknown) => {
    client.respondUi(requestId, value);
    setUiRequests((q) => q.filter((r) => r.requestId !== requestId));
  };

  /* ------------------------- chat context-menu actions ------------------------ */

  const menuWorkspace = workspaces.find((w) => w.sessionId === ctxMenu?.sessionId);

  const renameChat = () => {
    if (!ctxMenu?.sessionId) return;
    const sessionId = ctxMenu.sessionId;
    setCtxMenu(undefined);
    setTextPrompt({
      title: "Rename chat",
      placeholder: "Chat name",
      initial: menuWorkspace?.name ?? "",
      onSubmit: (name) =>
        void client.send({ type: "rename_workspace", sessionId, name }).catch((err) =>
          showToast((err as Error).message),
        ),
    });
  };

  const deleteChat = () => {
    if (!ctxMenu?.sessionId) return;
    const sessionId = ctxMenu.sessionId;
    setCtxMenu(undefined);
    void closeWorkspace(sessionId);
  };

  /** Edit a project's AGENTS.md (its per-project system prompt). */
  const editProjectPrompt = () => {
    if (!ctxMenu?.cwd) return;
    const cwd = ctxMenu.cwd;
    setCtxMenu(undefined);
    client
      .send<string>({ type: "read_project_prompt", cwd })
      .then((content) =>
        setTextPrompt({
          title: `Project prompt — ${folderName(cwd)} (AGENTS.md)`,
          placeholder: "Project-specific instructions, conventions, context…",
          initial: content ?? "",
          multiline: true,
          onSubmit: (value) =>
            void client
              .send({ type: "write_project_prompt", cwd, content: value })
              .catch((err) => showToast((err as Error).message)),
        }),
      )
      .catch((err) => showToast((err as Error).message));
  };

  /** Set a standing goal for a project (applies to chats opened in its folder). */
  const editProjectGoal = () => {
    if (!ctxMenu?.cwd) return;
    const cwd = ctxMenu.cwd;
    setCtxMenu(undefined);
    client
      .send<HostSettings>({ type: "get_settings" })
      .then((s) =>
        setTextPrompt({
          title: `Project goal — ${folderName(cwd)}`,
          placeholder: "e.g. Migrate the app to TypeScript. Empty clears it.",
          initial: s.projectGoals?.[cwd] ?? "",
          multiline: true,
          onSubmit: (value) =>
            void client
              .send({ type: "set_project_goal", cwd, goal: value.trim() || undefined })
              .catch((err) => showToast((err as Error).message)),
        }),
      )
      .catch((err) => showToast((err as Error).message));
  };

  /** Delete a project: closes every chat bound to its folder. */
  const deleteProject = () => {
    if (!ctxMenu?.cwd) return;
    const cwd = ctxMenu.cwd;
    setCtxMenu(undefined);
    for (const w of workspacesRef.current.filter((w) => w.cwd === cwd)) {
      void closeWorkspace(w.sessionId);
    }
  };

  const openBasicContextMenu = (e: ReactMouseEvent) => {
    // Replace the browser's right-click menu with our own everywhere.
    // A chat/project row that already handled this has called
    // preventDefault → leave its menu. Editable fields keep the native
    // menu so copy/paste still works.
    if (e.defaultPrevented) return;
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, [contenteditable]")) return;
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const handleContextMenuOverlay = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.target as HTMLElement;
    if (el.closest(".ctx-menu")) return;

    // The overlay is above the app while a menu is open. Temporarily make it
    // transparent to hit-testing, then re-dispatch the right-click to whatever
    // is actually under the pointer (chat row, project row, editor, etc.).
    const overlay = e.currentTarget;
    const previousPointerEvents = overlay.style.pointerEvents;
    overlay.style.pointerEvents = "none";
    const target = document.elementFromPoint(e.clientX, e.clientY);
    overlay.style.pointerEvents = previousPointerEvents;

    if (target) {
      const handled = !target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          button: 2,
          buttons: 2,
        }),
      );
      if (!handled) {
        if (target.closest("input, textarea, [contenteditable]")) setCtxMenu(undefined);
        else setCtxMenu({ x: e.clientX, y: e.clientY });
      }
    } else {
      setCtxMenu({ x: e.clientX, y: e.clientY });
    }
  };

  return (
    <div
      className="app"
      onContextMenu={openBasicContextMenu}
    >
      <header className="topbar" data-tauri-drag-region>
        <button
          className="side-toggle"
          title={sidebarHidden ? "Show sidebar" : "Hide sidebar"}
          onClick={toggleSidebar}
        >
          ☰
        </button>
        <span className="brand" data-tauri-drag-region>Pi Desktop</span>
        <span className={connected ? "dot ok" : "dot bad"} title={connected ? "connected" : "host offline"} />
        <nav>
          {panelHasContent && (
            <button
              className={panelHidden ? "" : "active"}
              title={panelHidden ? "Show side panel" : "Hide side panel"}
              onClick={() => setPanelHidden((h) => !h)}
            >
              panel
            </button>
          )}
          <button
            className={settingsOpen ? "active" : ""}
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </button>
        </nav>
        {window.__TAURI__?.window && (
          <div className="win-controls">
            <button
              className="win-btn"
              aria-label="Minimize"
              onClick={() => void window.__TAURI__!.window!.getCurrentWindow().minimize()}
            >
              <svg viewBox="0 0 10 10" width="13" height="13" aria-hidden>
                <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              className="win-btn"
              aria-label="Maximize / restore"
              onClick={() => void window.__TAURI__!.window!.getCurrentWindow().toggleMaximize()}
            >
              <svg viewBox="0 0 10 10" width="13" height="13" aria-hidden>
                <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <button
              className="win-btn close"
              aria-label="Close"
              onClick={() => void closeApp()}
            >
              <svg viewBox="0 0 10 10" width="13" height="13" aria-hidden>
                <path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
      </header>

      <div className="chat-layout">
          {!sidebarHidden && (
          <aside className="sidebar" style={{ width: sidebarWidth }}>
            <button
              className="new-chat-btn"
              onClick={() => {
                setNewChatDir(undefined);
                setShowNewChat(true);
              }}
            >
              <span className="new-chat-plus">+</span> Chat
            </button>

            {(() => {
              const projects = new Map<string, WorkspaceInfo[]>();
              const loose: WorkspaceInfo[] = [];
              for (const w of workspaces) {
                if (w.cwd && !w.defaultWorkspace) {
                  const group = projects.get(w.cwd) ?? [];
                  group.push(w);
                  projects.set(w.cwd, group);
                } else {
                  loose.push(w);
                }
              }
              const chatRow = (w: WorkspaceInfo) => (
                <button
                  key={w.sessionId}
                  className={`ws ${w.sessionId === activeSession ? "active" : ""}`}
                  onClick={() =>
                    setActiveSession((current) =>
                      current === w.sessionId ? undefined : w.sessionId,
                    )
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, sessionId: w.sessionId });
                  }}
                >
                  <span
                    className={`mode-dot ${w.mode} ${w.isStreaming ? "streaming" : ""} ${w.interrupted ? "interrupted" : ""}`}
                    title={
                      w.interrupted
                        ? w.isStreaming
                          ? "Interrupted — working to finish…"
                          : "Interrupted — needs finishing"
                        : w.isStreaming
                          ? "Working…"
                          : w.mode
                    }
                  />
                  <span className="ws-mode">{w.name ?? w.mode}</span>
                  <span
                    className="ws-menu-btn"
                    title="Chat options"
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setCtxMenu({ x: rect.left, y: rect.bottom + 4, sessionId: w.sessionId });
                    }}
                  >
                    ⋯
                  </span>
                </button>
              );
              const projectBlock = (cwd: string, chats: WorkspaceInfo[]) => {
                const isCollapsed = collapsed.has(cwd);
                const taskProgress = taskProgressForChats(chats);
                return (
                  <div key={`p:${cwd}`} className="project">
                    <div
                      className="project-head"
                      title={cwd}
                      onClick={() => toggleProject(cwd)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu({ x: e.clientX, y: e.clientY, cwd });
                      }}
                    >
                      <span className={`project-chevron ${isCollapsed ? "" : "open"}`}>▸</span>
                      <FolderIcon />
                      <span className="project-name">{folderName(cwd)}</span>
                      <span
                        className="project-count"
                        title={`${taskProgress.done}/${taskProgress.total} tasks completed`}
                      >
                        {taskProgress.done}/{taskProgress.total}
                      </span>
                      <button
                        className="project-add"
                        title={`New chat in ${folderName(cwd)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          // Adding from a project → make it a project chat
                          // (code mode, bound to the folder) straight away.
                          void openWorkspace("code", cwd);
                        }}
                      >
                        +
                      </button>
                    </div>
                    {!isCollapsed && (
                      <>
                        <div className="project-chats">{chats.map(chatRow)}</div>
                        <div className="project-files-head" onClick={() => toggleFiles(cwd)}>
                          <span className={`project-chevron ${filesOpen.has(cwd) ? "open" : ""}`}>
                            ▸
                          </span>
                          Files
                        </div>
                        {filesOpen.has(cwd) && (
                          <div className="project-files">
                            <FileTree
                              client={client}
                              cwd={cwd}
                              selectedPath={selectedFilePath}
                              onSelectPath={setSelectedFilePath}
                              onPreview={(content) => {
                                setViewer(content);
                                setPanelHidden(false);
                              }}
                              onClosePreview={() => {
                                setViewer(undefined);
                                setPanelHidden(true);
                              }}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              };

              // Group a list into recency buckets (Today / Yesterday / …).
              const bucketize = <T,>(items: T[], dateOf: (t: T) => number) => {
                const sorted = [...items].sort((a, b) => dateOf(b) - dateOf(a));
                const groups: { label: string; items: T[] }[] = [];
                for (const it of sorted) {
                  const label = timeBucket(dateOf(it));
                  const last = groups[groups.length - 1];
                  if (last && last.label === label) last.items.push(it);
                  else groups.push({ label, items: [it] });
                }
                return groups;
              };

              // Projects stay their own section, bucketed by their most recently
              // active chat; folderless chats form a second, separate section.
              const projectGroups = bucketize(
                [...projects.entries()],
                ([, chats]) => Math.max(0, ...chats.map((c) => c.lastActiveAt ?? 0)),
              );
              const looseGroups = bucketize(loose, (w) => w.lastActiveAt ?? 0);

              return (
                <>
                  {projects.size > 0 && <div className="sidebar-title">Projects</div>}
                  {projectGroups.map((g) => (
                    <div key={`pg:${g.label}`}>
                      {g.label !== "Today" && <div className="sidebar-subtitle">{g.label}</div>}
                      {g.items.map(([cwd, chats]) => projectBlock(cwd, chats))}
                    </div>
                  ))}
                  {looseGroups.map((g) => (
                    <div key={`cg:${g.label}`}>
                      <div className="sidebar-title">{g.label}</div>
                      {g.items.map(chatRow)}
                    </div>
                  ))}
                </>
              );
            })()}

          </aside>
          )}
          {!sidebarHidden && (
            <div className="resize-handle" onMouseDown={(e) => startResize(e, "left")} />
          )}
          <main className="chat-main" style={chatMainStyle}>
            {active ? (
              <>
                <div className="mode-bar">
                  <span className="chat-title">
                    {active.name ?? active.mode}
                    {active.cwd && !active.defaultWorkspace && (
                      <span className="dim"> — {folderName(active.cwd)}</span>
                    )}
                  </span>
                  <div className="mode-bar-right">
                    {capabilities?.supportsCompaction && (
                      <button
                        onClick={() =>
                          void client
                            .send({ type: "compact", sessionId: active.sessionId })
                            .catch((err) => showToast((err as Error).message))
                        }
                      >
                        compact
                      </button>
                    )}
                  </div>
                </div>
                <Chat
                  items={transcripts[active.sessionId] ?? []}
                  queued={queuedMsgs[active.sessionId] ?? []}
                  streaming={active.isStreaming}
                  onSend={sendPrompt}
                  onEdit={editPrompt}
                  onStop={stopActive}
                  client={client}
                  cwd={active.defaultWorkspace ? undefined : active.cwd}
                  toolsVersion={modelsVersion}
                  goal={active.goal}
                  contextWindow={active.contextWindow}
                  onSetGoal={(goal) =>
                    void client
                      .send({ type: "set_goal", sessionId: active.sessionId, goal })
                      .catch((err) => showToast((err as Error).message))
                  }
                  onOpenCode={(code, lang) => {
                    setViewer({ code, lang });
                    setPanelHidden(false);
                  }}
                  controls={
                    <>
                      <PolicyControl client={client} sessionId={active.sessionId} />
                      <ModelPicker
                        client={client}
                        sessionId={active.sessionId}
                        version={modelsVersion}
                        onModelChange={() => setThinkingVersion((v) => v + 1)}
                      />
                      {capabilities?.supportsThinkingLevels && (
                        <ThinkingPicker
                          client={client}
                          sessionId={active.sessionId}
                          version={thinkingVersion}
                        />
                      )}
                      {capabilities?.supportsDynamicProviderRegistration && (
                        <AddModel client={client} onAdded={() => setModelsVersion((v) => v + 1)} />
                      )}
                    </>
                  }
                />
              </>
            ) : (
              <div className="home">
                <div className="home-greeting">What can I help with?</div>
                <div className="home-hint">
                  Sending starts a new chat — type @ to mention files or force tools
                  (@plan, @deepsearch, …).
                </div>
                <Chat
                  items={[]}
                  streaming={false}
                  onSend={(text) => void startHomeChat(text)}
                  onSetGoal={(goal) => void startHomeGoal(goal)}
                  onStop={() => {}}
                  client={client}
                  toolsVersion={modelsVersion}
                  controls={
                    <>
                      <PolicyControl
                        client={client}
                        onPick={(policy) => (homePolicyRef.current = policy)}
                      />
                      <ModelPicker client={client} version={modelsVersion} />
                      {capabilities?.supportsThinkingLevels && (
                        <ThinkingPicker client={client} version={modelsVersion} />
                      )}
                      {capabilities?.supportsDynamicProviderRegistration && (
                        <AddModel client={client} onAdded={() => setModelsVersion((v) => v + 1)} />
                      )}
                    </>
                  }
                />
              </div>
            )}
          </main>
          {panelVisible && (
            <>
              <div className="resize-handle" onMouseDown={(e) => startResize(e, "right")} />
              <SidePanel
                todos={activeTodos}
                viewer={viewer}
                width={effectivePanelWidth}
                onCloseViewer={() => {
                  setViewer(undefined);
                  setSelectedFilePath(undefined);
                }}
              />
            </>
          )}
        </div>

      {settingsOpen && (
        <SettingsModal
          client={client}
          capabilities={capabilities}
          cwd={active?.defaultWorkspace ? undefined : active?.cwd}
          onClose={() => {
            setSettingsOpen(false);
            // Providers/models may have changed in Settings (subscription
            // login, API keys, custom models) — refresh the model pickers.
            setModelsVersion((v) => v + 1);
          }}
        />
      )}

      {showNewChat && (
        <OpenWorkspaceModal
          initialDir={newChatDir}
          onOpen={(mode, cwd) => void openWorkspace(mode, cwd)}
          onCancel={() => setShowNewChat(false)}
        />
      )}

      {ctxMenu && (
        <div
          className="ctx-overlay"
          onClick={() => setCtxMenu(undefined)}
          onContextMenu={handleContextMenuOverlay}
        >
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {ctxMenu.sessionId ? (
              <>
                <button onClick={renameChat}>Rename chat</button>
                <button
                  onClick={() => {
                    const ws = menuWorkspace;
                    setCtxMenu(undefined);
                    if (ws) setToolsChat(ws);
                  }}
                >
                  Tools
                  {menuWorkspace?.disabledTools?.length
                    ? ` (${menuWorkspace.disabledTools.length} off)`
                    : ""}
                </button>
                <div className="plus-menu-sep" />
                <button className="danger" onClick={deleteChat}>
                  Delete chat
                </button>
              </>
            ) : ctxMenu.cwd ? (
              <>
                <button
                  onClick={() => {
                    const cwd = ctxMenu.cwd;
                    setCtxMenu(undefined);
                    if (cwd) void openWorkspace("code", cwd);
                  }}
                >
                  New chat in project
                </button>
                <button onClick={editProjectGoal}>Set project goal…</button>
                <button onClick={editProjectPrompt}>Edit project prompt (AGENTS.md)</button>
                <div className="plus-menu-sep" />
                <button className="danger" onClick={deleteProject}>
                  Delete project & its chats
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => {
                    setCtxMenu(undefined);
                    setShowNewChat(true);
                  }}
                >
                  New chat
                </button>
                <button
                  onClick={() => {
                    setCtxMenu(undefined);
                    setSettingsOpen(true);
                  }}
                >
                  Settings
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {textPrompt && (
        <TextPromptDialog prompt={textPrompt} onClose={() => setTextPrompt(undefined)} />
      )}
      {toolsChat && (
        <ToolsDialog
          client={client}
          workspace={toolsChat}
          onClose={() => setToolsChat(undefined)}
          onError={showToast}
        />
      )}
      {uiRequests[0] && <PermissionDialog envelope={uiRequests[0]} onAnswer={answerUi} />}
      <Notifications />
      <TooltipLayer />
      {boot !== "done" && (
        <div className={`boot ${boot === "fading" ? "fade" : ""}`} data-tauri-drag-region>
          <div className="boot-logo">
            <span className="boot-pi">π</span>
            <span className="boot-ring" />
            <span className="boot-glow" />
          </div>
          <div className="boot-status" key={bootMsg}>
            {bootMsg}
          </div>
        </div>
      )}
    </div>
  );
}
