import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
  type WheelEvent,
} from "react";
import type { FileMatch, ToolInfo } from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import type { ChatItem } from "../../chat-model.js";
import { autoExpandThinking } from "../../prefs.js";
import { Markdown } from "./Markdown.js";
import { ToolCard } from "./ToolCard.js";

interface SuggestItem {
  kind: "tool" | "dir" | "file";
  label: string;
  insert: string;
  /** Tool name for per-tool coloring (kind === "tool" only). */
  mode?: string;
  /** Short blurb shown next to the suggestion (kind === "tool" only). */
  desc?: string;
}

/** Tools offered in the @ autocomplete. Only the mode-forcing agents are
 *  mentionable; everything else the model uses on its own. (@goal is a separate
 *  synthetic entry.) */
const MENTIONABLE_TOOLS = new Set(["plan", "deepsearch"]);
const COMPOSER_MAX_HEIGHT = 220;

/** Curated one-liners for the built-in tools; other tools (e.g. MCP) fall
 *  back to the first sentence of their registered description. */
const TOOL_BLURBS: Record<string, string> = {
  web_search: "Search the web",
  ask_user: "Ask you a question",
  set_todos: "Publish a progress task list",
  read: "Read a file",
  write: "Write a file",
  edit: "Edit a file",
  ls: "List a directory",
  grep: "Search file contents",
  find: "Find files by name",
  bash: "Run a shell command",
  plan: "Spawn a read-only planning agent",
  deepsearch: "Spawn a web-research agent (cited report)",
  claude_code: "Delegate to the official Claude Code CLI (plan billing)",
  codex: "Delegate to the official Codex CLI (plan billing)",
};

interface SuggestState {
  items: SuggestItem[];
  sel: number;
  /** Range of the @token in the draft to replace on pick. */
  tokenStart: number;
  caret: number;
}

/** File mention token: @path, quoted when plain @path would be ambiguous. */
function fileToken(path: string): string {
  return /[\s:"]/.test(path) ? `@"${path.replaceAll('"', '\\"')}"` : `@${path}`;
}

/* -------------------------------- attachments ------------------------------ */

interface Attachment {
  /** Absolute path the model can read. */
  path: string;
  name: string;
  ext: string;
  /** Data URL thumbnail (images only). */
  previewUrl?: string;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

function extOf(name: string): string {
  const match = /\.(\w+)$/.exec(name);
  return (match?.[1] ?? "").toLowerCase();
}

function imageMime(ext: string): string {
  return ext === "jpg" ? "image/jpeg" : `image/${ext}`;
}

/** Short uppercase label for the file-type chip (non-images). */
function extLabel(ext: string): string {
  return (ext || "file").slice(0, 4).toUpperCase();
}

/** @tokens inside a sent message, for colored rendering. Modes listed here get
 *  their own color; add one (and optionally a --pd-mode-<name> CSS var) to extend. */
const MENTION_MODES = ["chat", "plan", "deepsearch", "code"] as const;
const MODE_ALT = MENTION_MODES.join("|");
const MENTION_RE = new RegExp(
  `@(?:${MODE_ALT})\\b|@"[^"]*"|@file:"[^"]*"|@[\\w.\\-/:\\\\]+`,
  "gi",
);
const MODE_TOKEN_RE = new RegExp(`^@(${MODE_ALT})$`, "i");
/** Inline color for a mode mention, driven by the per-mode CSS variable. */
function modeColor(mode: string): string {
  return `var(--pd-mode-${mode}, var(--pd-accent))`;
}

function filePathFromMention(token: string): string | undefined {
  const fileMatch = /^@file:"([^"]*)"$/i.exec(token);
  if (fileMatch) return fileMatch[1];
  const quotedMatch = /^@"([^"]*)"$/.exec(token);
  if (quotedMatch) return quotedMatch[1];
  return token.startsWith("@") ? token.slice(1) : undefined;
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

function readablePath(path: string, cwd?: string): string {
  if (isAbsolutePath(path) || !cwd) return path;
  return `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

function UserImageMention({
  token,
  client,
  cwd,
}: {
  token: string;
  client?: HostClient;
  cwd?: string;
}) {
  const path = filePathFromMention(token) ?? token;
  const ext = extOf(path);
  const name = path.split(/[/\\]/).pop() ?? path;
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(undefined);
    setFailed(false);
    if (!client) {
      setFailed(true);
      return;
    }

    client
      .send<string>({ type: "read_file_base64", path: readablePath(path, cwd) })
      .then((base64) => {
        if (!cancelled) setPreviewUrl(`data:${imageMime(ext)};base64,${base64}`);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [client, cwd, ext, path]);

  if (!previewUrl) {
    return <span className={`mention file image ${failed ? "failed" : "loading"}`}>{token}</span>;
  }

  return (
    <span className="mention-image" title={path}>
      <img
        src={previewUrl}
        alt={name}
        onError={() => {
          setPreviewUrl(undefined);
          setFailed(true);
        }}
      />
      <span>{name}</span>
    </span>
  );
}

/** Context-fill donut: how much of the model's window the session has used. */
function ContextCircle({ tokens, window: win }: { tokens: number; window: number }) {
  const pct = Math.min(1, tokens / win);
  const circumference = 2 * Math.PI * 7;
  const cls = pct > 0.95 ? "full" : pct > 0.8 ? "warn" : "";
  return (
    <div
      className={`ctx-usage ${cls}`}
      title={`${tokens.toLocaleString()} / ${win.toLocaleString()} tokens · ${Math.round(
        pct * 100,
      )}%`}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
        <circle cx="10" cy="10" r="7" fill="none" className="track" strokeWidth="2.5" />
        <circle
          cx="10"
          cy="10"
          r="7"
          fill="none"
          className="fill"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${pct * circumference} ${circumference}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
    </div>
  );
}

/** Collapsible thinking block. Starts expanded when the auto-expand
 *  preference is on; user toggles always win afterwards. */
function ThinkingBlock({
  className,
  summary,
  text,
}: {
  className: string;
  summary: string;
  text: string;
}) {
  const [open, setOpen] = useState(autoExpandThinking());
  return (
    <details
      className={className}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>{summary}</summary>
      {text}
    </details>
  );
}

/** "Thought for 3.2s" style duration for a finished thinking block. */
function thinkingDuration(ms?: number): string {
  if (!ms || ms < 0) return "a moment";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Render user text with colored @mentions (modes, files, folders). */

function renderUserText(text: string, client?: HostClient, cwd?: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = new RegExp(MENTION_RE.source, "gi");
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const mode = MODE_TOKEN_RE.exec(token)?.[1]?.toLowerCase();
    const path = mode ? undefined : filePathFromMention(token);

    if (path && client && IMAGE_EXTS.has(extOf(path))) {
      nodes.push(<UserImageMention key={key++} token={token} client={client} cwd={cwd} />);
    } else {
      const cls = mode
        ? `mention ${mode}`
        : token.endsWith("/")
          ? "mention dir"
          : /["./\\]/.test(token)
            ? "mention file"
            : "mention generic";
      nodes.push(
        <span
          key={key++}
          className={cls}
          style={mode ? { color: modeColor(mode) } : undefined}
        >
          {token}
        </span>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Chat({
  items,
  queued = [],
  streaming,
  onSend,
  onEdit,
  onStop,
  client,
  cwd,
  onOpenCode,
  controls,
  toolsVersion = 0,
  goal,
  onSetGoal,
  contextWindow,
}: {
  items: ChatItem[];
  /** Messages queued while the agent is busy — shown in the preview above the
   *  composer, not yet part of the transcript. */
  queued?: string[];
  streaming: boolean;
  onSend: (text: string) => void;
  /** Resend an edited message: discards this item and everything after it. */
  onEdit?: (index: number, text: string) => void;
  onStop: () => void;
  /** For @-suggestions (project files) — optional. */
  client?: HostClient;
  cwd?: string;
  /** Called when a code block is clicked — opens it in the viewer panel. */
  onOpenCode?: (code: string, lang?: string) => void;
  /** Extra controls (model picker, permission mode, …) shown in the composer. */
  controls?: ReactNode;
  /** Bump to re-fetch the @tool suggestions (e.g. after (re)connecting —
   *  the home composer mounts before the socket opens). */
  toolsVersion?: number;
  /** Current goal for this chat (shown as a banner at the top). */
  goal?: string;
  /** Set/clear the chat goal. When provided, enables the @goal mention. */
  onSetGoal?: (goal?: string) => void;
  /** Per-chat context window override (set_context_window). Overrides the value
   *  stamped on messages so the usage donut reflects it immediately. */
  contextWindow?: number;
}) {
  const [draft, setDraft] = useState("");
  /** Files attached via paste / drag-drop / picker, sent as @mentions. */
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  /** Transcript index of the user message being edited, if any. */
  const [editIndex, setEditIndex] = useState<number>();
  const [plusOpen, setPlusOpen] = useState(false);
  const [suggest, setSuggest] = useState<SuggestState>();
  /** Registered tools, for @tool suggestions & forced tool calls. */
  const [tools, setTools] = useState<ToolInfo[]>([]);
  useEffect(() => {
    if (!client) return;
    client
      .send<ToolInfo[]>({ type: "list_tools" })
      .then((list) => setTools(list ?? []))
      .catch(() => {
        /* not connected yet — keep the previous list; retried via toolsVersion */
      });
  }, [client, toolsVersion]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const suggestMenuRef = useRef<HTMLDivElement>(null);
  const suggestSeq = useRef(0);

  const resizeComposer = () => {
    const textarea = taRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const height = Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
    if (highlightRef.current) {
      highlightRef.current.style.height = `${height}px`;
      highlightRef.current.scrollTop = textarea.scrollTop;
    }
  };

  useLayoutEffect(() => {
    resizeComposer();
  }, [draft]);

  // Keep the highlighted @-suggestion scrolled into view during arrow-key nav.
  const suggestSel = suggest?.sel;
  useEffect(() => {
    if (suggestSel === undefined) return;
    const menu = suggestMenuRef.current;
    const item = menu?.children[suggestSel] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [suggestSel]);
  // Auto-scroll only while the user is pinned to the bottom. Scrolling up
  // (e.g. to re-read earlier output while the model is still answering)
  // releases the pin; returning to the bottom re-enables it.
  const stickToBottom = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Only re-pin once the user is essentially back at the bottom.
    if (distanceFromBottom < 24) stickToBottom.current = true;
  };

  // Any upward gesture releases the pin immediately — synchronously, before the
  // next streamed chunk can re-scroll — so scrolling up never fights back.
  const releaseIfScrollingUp = (deltaY: number) => {
    if (deltaY < 0) stickToBottom.current = false;
  };
  const handleWheel = (e: WheelEvent) => releaseIfScrollingUp(e.deltaY);
  const touchY = useRef(0);
  const handleTouchStart = (e: TouchEvent) => {
    touchY.current = e.touches[0]?.clientY ?? 0;
  };
  const handleTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY ?? 0;
    // Finger moving down = content scrolls up.
    releaseIfScrollingUp(touchY.current - y);
    touchY.current = y;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const submit = () => {
    const base = draft.trim();
    if (!base && attachments.length === 0) return;
    // "@goal <text>" is a local command, not a message: set (or clear, when
    // empty) the chat goal shown at the top, and don't send anything.
    if (onSetGoal) {
      const goalMatch = base.match(/^@goal\b\s*([\s\S]*)$/i);
      if (goalMatch) {
        onSetGoal(goalMatch[1].trim() || undefined);
        setDraft("");
        setAttachments([]);
        setSuggest(undefined);
        return;
      }
    }
    // Attachments ride along as @file mentions appended to the message.
    const tokens = attachments.map((a) => fileToken(a.path)).join(" ");
    const text = [base, tokens].filter(Boolean).join("\n\n");
    setDraft("");
    setAttachments([]);
    setSuggest(undefined);
    if (editIndex !== undefined && onEdit) {
      onEdit(editIndex, text);
      setEditIndex(undefined);
    } else {
      onSend(text);
    }
  };

  const cancelEdit = () => {
    setEditIndex(undefined);
    setDraft("");
  };

  /* ------------------------------ @ suggestions ----------------------------- */

  const updateSuggest = async (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const match = before.match(/@([\w.\-/\\]*)$/);
    if (!match) {
      setSuggest(undefined);
      return;
    }
    const token = match[1];
    const tokenStart = caret - token.length - 1;
    const seq = ++suggestSeq.current;

    // Only the mode-forcing mentions are offered (plus @goal below); other
    // tools are used by the model on its own and aren't @-mentionable.
    const modeItems: SuggestItem[] = tools
      .filter(
        (t) =>
          MENTIONABLE_TOOLS.has(t.name) && t.name.toLowerCase().startsWith(token.toLowerCase()),
      )
      .map((t) => ({
        kind: "tool",
        label: `@${t.name}`,
        insert: `@${t.name} `,
        mode: t.name,
        desc: TOOL_BLURBS[t.name] ?? t.description,
      }));

    // Synthetic "@goal" mention (client-only): set a goal for this chat.
    if (onSetGoal && "goal".startsWith(token.toLowerCase())) {
      modeItems.unshift({
        kind: "tool",
        label: "@goal",
        insert: "@goal ",
        mode: "goal",
        desc: "Set a goal for this chat (shown at the top)",
      });
    }

    let fileItems: SuggestItem[] = [];
    if (client && cwd) {
      try {
        // Recursive project-wide search: finds deeply nested files too.
        const matches = await client.send<FileMatch[]>({
          type: "search_files",
          cwd,
          query: token,
        });
        fileItems = matches.map((m) =>
          m.dir
            ? { kind: "dir" as const, label: `${m.path}/`, insert: `@${m.path}/` }
            : { kind: "file" as const, label: m.path, insert: `${fileToken(m.path)} ` },
        );
      } catch {
        /* folder unreadable — modes only */
      }
    }

    if (seq !== suggestSeq.current) return; // stale async result
    const all = [...modeItems, ...fileItems];
    setSuggest(all.length > 0 ? { items: all, sel: 0, tokenStart, caret } : undefined);
  };

  const pickSuggestion = (item: SuggestItem) => {
    if (!suggest) return;
    const next = draft.slice(0, suggest.tokenStart) + item.insert + draft.slice(suggest.caret);
    setDraft(next);
    setSuggest(undefined);
    taRef.current?.focus();
    // Keep drilling into folders.
    if (item.kind === "dir") {
      const caret = suggest.tokenStart + item.insert.length;
      void updateSuggest(next, caret);
    }
  };

  /* --------------------------------- helpers -------------------------------- */

  const insert = (token: string) => {
    setDraft((d) => (d ? `${d.trimEnd()} ` : "") + token + " ");
    setPlusOpen(false);
    taRef.current?.focus();
  };

  /** Attach an existing file by absolute path (picker / native drop). */
  const addPathAttachment = async (path: string) => {
    const name = path.split(/[/\\]/).pop() ?? path;
    const ext = extOf(name);
    const attachment: Attachment = { path, name, ext };
    // Image thumbnails: small host-side read (best-effort — icon otherwise).
    if (client && IMAGE_EXTS.has(ext)) {
      try {
        const base64 = await client.send<string>({ type: "read_file_base64", path });
        attachment.previewUrl = `data:${imageMime(ext)};base64,${base64}`;
      } catch {
        /* too large / unreadable — keep the icon chip */
      }
    }
    setAttachments((list) =>
      list.some((a) => a.path === path) ? list : [...list, attachment],
    );
  };

  /** Attach in-memory file data (clipboard paste, browser drop): the host
   *  persists it so the session's read tool can reference a real path. */
  const addDataAttachment = async (file: File) => {
    if (!client) return;
    const name = file.name || `pasted-${Date.now()}.png`;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("could not read file"));
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    try {
      const path = await client.send<string>({
        type: "save_attachment",
        name,
        dataBase64: base64,
      });
      const ext = extOf(name);
      setAttachments((list) => [
        ...list,
        {
          path,
          name,
          ext,
          ...(file.type.startsWith("image/") || IMAGE_EXTS.has(ext)
            ? { previewUrl: dataUrl }
            : {}),
        },
      ]);
    } catch {
      /* host unreachable — nothing to attach */
    }
  };

  const attachFile = async () => {
    setPlusOpen(false);
    const picked = await window.__TAURI__?.dialog?.open({
      directory: false,
      title: "Attach file",
    });
    if (picked) await addPathAttachment(picked);
    taRef.current?.focus();
  };

  // Native drag & drop (Tauri intercepts HTML5 drops and reports paths).
  useEffect(() => {
    const webview = window.__TAURI__?.webview?.getCurrentWebview?.();
    if (!webview?.onDragDropEvent) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void webview
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") setDragOver(true);
        else if (payload.type === "leave") setDragOver(false);
        else if (payload.type === "drop") {
          setDragOver(false);
          for (const path of payload.paths ?? []) void addPathAttachment(path);
        }
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

  /** Put a user message back into the composer; resending replaces it and
   *  removes every message that came after it. */
  const editMessage = (index: number, text: string) => {
    setDraft(text);
    setEditIndex(index);
    taRef.current?.focus();
  };

  /** Re-ask: replace this assistant reply (and everything after it) by
   *  resending the user message that produced it. */
  const rethink = (assistantIndex: number) => {
    for (let i = assistantIndex - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "user") {
        if (onEdit) onEdit(i, item.text);
        else onSend(item.text);
        return;
      }
    }
  };

  /** Click delegation: clicking a code block in any message opens the viewer. */
  const handleMessagesClick = (e: MouseEvent) => {
    if (!onOpenCode) return;
    const pre = (e.target as HTMLElement).closest?.(".md pre");
    if (!pre) return;
    const codeEl = pre.querySelector("code");
    const langMatch = (codeEl?.className ?? "").match(/language-([\w-]+)/);
    const code = (codeEl ?? pre).textContent ?? "";
    if (code.trim()) onOpenCode(code, langMatch?.[1]);
  };

  return (
    <div className="chat">
      {goal && (
        <div className="chat-goal">
          <span className="chat-goal-label">Goal</span>
          <span className="chat-goal-text">{goal}</span>
          <button
            className="chat-goal-clear"
            title="Clear the goal for this chat"
            onClick={() => onSetGoal?.(undefined)}
          >
            ✕
          </button>
        </div>
      )}
      <div
        className="messages"
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onClick={handleMessagesClick}
      >
        {items.map((item, i) => {
          switch (item.kind) {
            case "user":
              // Queued messages stay in the queue preview (below) and only join
              // the conversation once the previous turn finishes and theirs
              // starts (queued flips to false on agent_start).
              if (item.queued) return null;
              return (
                <div key={i} className={`msg-row user ${i === editIndex ? "editing" : ""}`}>
                  <div className="msg user">{renderUserText(item.text, client, cwd)}</div>
                  <div className="msg-actions">
                    <button title="Edit & resend (replaces later messages)" onClick={() => editMessage(i, item.text)}>
                      ✎
                    </button>
                  </div>
                </div>
              );
            case "assistant": {
              const secs = item.durationMs !== undefined ? item.durationMs / 1000 : undefined;
              const meta: string[] = [];
              if (secs !== undefined) meta.push(`${secs.toFixed(1)}s`);
              if (item.outputTokens) meta.push(`${item.outputTokens} tok`);
              if (secs && item.outputTokens) {
                meta.push(`${(item.outputTokens / secs).toFixed(1)} tok/s`);
              }
              return (
                <div key={i} className="msg-row assistant">
                  <div className={`msg assistant ${item.streaming ? "streaming" : ""}`}>
                    <Markdown text={item.text} animate={item.streaming} />
                  </div>
                  {!item.streaming && item.text.trim() !== "" && (
                    <div className="msg-footer">
                      <div className="msg-actions">
                        <button
                          title="Rethink — replace this answer and ask again"
                          onClick={() => rethink(i)}
                        >
                          ⟳
                        </button>
                      </div>
                      {meta.length > 0 && <span className="msg-meta">{meta.join(" · ")}</span>}
                    </div>
                  )}
                </div>
              );
            }
            case "thinking":
              return (
                <ThinkingBlock
                  key={i}
                  className={`msg thinking ${
                    item.streaming && i === items.length - 1 ? "streaming" : ""
                  }`}
                  summary={
                    item.streaming && i === items.length - 1
                      ? "thinking…"
                      : `Thought for ${thinkingDuration(item.durationMs)}`
                  }
                  text={item.text}
                />
              );
            case "tool":
              return <ToolCard key={i} item={item} onForceStop={onStop} />;
            case "system":
              return (
                <div key={i} className="msg system">
                  {item.text}
                </div>
              );
          }
        })}
        {streaming &&
          (() => {
            // Show a typing indicator while the model is working but has not yet
            // produced visible output (e.g. just after sending, or during a tool
            // call). Hidden once an assistant/thinking message is streaming text.
            const last = items[items.length - 1];
            const producing =
              (last?.kind === "assistant" || last?.kind === "thinking") && last.streaming;
            return producing ? null : (
              <div className="typing" aria-label="Model is working">
                <span />
                <span />
                <span />
              </div>
            );
          })()}
      </div>

      <div className="composer">
        {queued.length > 0 && (
          <div className="queue-list">
            <div className="queue-list-title">{queued.length} queued</div>
            {queued.map((text, i) => (
              <div key={i} className="queue-list-item" title={text}>
                {text}
              </div>
            ))}
          </div>
        )}
        <div
          className={`composer-box ${dragOver ? "drag-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            // Browser fallback (dev): Tauri handles drops natively above.
            e.preventDefault();
            setDragOver(false);
            for (const file of Array.from(e.dataTransfer?.files ?? [])) {
              void addDataAttachment(file);
            }
          }}
        >
          {attachments.length > 0 && (
            <div className="attachment-row">
              {attachments.map((a) => (
                <div key={a.path} className="attachment-chip" title={a.path}>
                  {a.previewUrl ? (
                    <img
                      className="attachment-thumb"
                      src={a.previewUrl}
                      alt={a.name}
                      onError={() =>
                        // Undecodable preview → fall back to the type icon.
                        setAttachments((list) =>
                          list.map((x) =>
                            x.path === a.path ? { ...x, previewUrl: undefined } : x,
                          ),
                        )
                      }
                    />
                  ) : (
                    <span className={`attachment-ext ${a.ext}`}>{extLabel(a.ext)}</span>
                  )}
                  <span className="attachment-name">{a.name}</span>
                  <button
                    className="attachment-remove"
                    title="Remove attachment"
                    onClick={() =>
                      setAttachments((list) => list.filter((x) => x.path !== a.path))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {editIndex !== undefined && (
            <div className="edit-banner">
              editing message — sending will remove the messages after it
              <button title="Cancel editing" onClick={cancelEdit}>
                ×
              </button>
            </div>
          )}
          {suggest && (
            <div className="suggest-menu" ref={suggestMenuRef}>
              {suggest.items.map((item, i) => (
                <button
                  key={`${item.kind}:${item.label}`}
                  className={`suggest-item ${item.kind} ${item.mode ?? ""} ${i === suggest.sel ? "selected" : ""}`}
                  onMouseEnter={() => setSuggest({ ...suggest, sel: i })}
                  onClick={() => pickSuggestion(item)}
                >
                  <span className="suggest-kind">
                    {item.kind === "tool" ? "◆" : item.kind === "dir" ? "▸" : "·"}
                  </span>
                  {item.label}
                  {item.kind === "tool" && (
                    <span className="dd-item-hint">{item.desc || "tool"}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="composer-input">
            <div className="composer-highlight" aria-hidden="true" ref={highlightRef}>
              {renderUserText(draft)}
              {"\u200b"}
            </div>
          <textarea
            ref={taRef}
            rows={1}
            value={draft}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="Message the agent… (@ for files & tools — @plan, @deepsearch force a tool)"
            onChange={(e) => {
              setDraft(e.target.value);
              resizeComposer();
              void updateSuggest(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onPaste={(e) => {
              // Ctrl+V with files (screenshots, copied files) → attachments.
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length === 0) return;
              e.preventDefault();
              for (const file of files) void addDataAttachment(file);
            }}
            onKeyDown={(e) => {
              if (suggest) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSuggest({ ...suggest, sel: (suggest.sel + 1) % suggest.items.length });
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSuggest({
                    ...suggest,
                    sel: (suggest.sel - 1 + suggest.items.length) % suggest.items.length,
                  });
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickSuggestion(suggest.items[suggest.sel]);
                  return;
                }
                if (e.key === "Escape") {
                  setSuggest(undefined);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onScroll={(e) => {
              if (highlightRef.current) {
                highlightRef.current.scrollTop = e.currentTarget.scrollTop;
                highlightRef.current.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
            onBlur={() => setTimeout(() => setSuggest(undefined), 150)}
          />
          </div>
          <div className="composer-controls">
            <div className="plus-wrap">
              <button
                className={`plus-btn ${plusOpen ? "active" : ""}`}
                title="Attach files"
                onClick={() => setPlusOpen(!plusOpen)}
              >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                  <path
                    d="M6 1v10M1 6h10"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              {plusOpen && (
                <div className="plus-menu">
                  {window.__TAURI__?.dialog ? (
                    <button onClick={() => void attachFile()}>Attach file…</button>
                  ) : (
                    <div className="plus-menu-title">Type @ to mention files &amp; modes</div>
                  )}
                </div>
              )}
            </div>
            {controls}
            <div className="composer-spacer" />
            {(() => {
              const ctx = [...items]
                .reverse()
                .find(
                  (it): it is Extract<ChatItem, { kind: "assistant" }> =>
                    it.kind === "assistant" && !!it.contextTokens,
                );
              // A per-chat override wins over the window stamped on the message,
              // so the donut reflects a just-changed context size right away.
              const win = contextWindow ?? ctx?.contextWindow;
              return ctx && win ? (
                <ContextCircle tokens={ctx.contextTokens!} window={win} />
              ) : null;
            })()}
            {streaming && (
              <button
                className="send-btn queue"
                title="Queue message — sent when the agent finishes"
                disabled={!draft.trim() && attachments.length === 0}
                onClick={submit}
              >
                ↑
              </button>
            )}
            <button
              className={`send-btn ${streaming ? "stop" : ""}`}
              title={streaming ? "Stop" : "Send"}
              disabled={!streaming && !draft.trim() && attachments.length === 0}
              onClick={streaming ? onStop : submit}
            >
              {streaming ? "■" : "↑"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
