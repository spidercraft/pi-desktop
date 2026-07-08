/**
 * Generic tool renderer (§7.6): per-tool-name presentation with a JSON
 * fallback for unknown tools — extensible without redeploys, adapter-agnostic.
 */
import type { ChatItem } from "../../chat-model.js";
import { DiffView } from "./DiffView.js";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** Pull old/new strings out of edit-style tool args (naming varies by harness). */
function editStrings(args: unknown): { oldText: string; newText: string } | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const a = args as Record<string, unknown>;
  const oldText = a.oldText ?? a.old_string ?? a.oldStr ?? a.old;
  const newText = a.newText ?? a.new_string ?? a.newStr ?? a.new;
  if (typeof oldText === "string" && typeof newText === "string") return { oldText, newText };
  return undefined;
}

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

function resultText(result: unknown): string {
  if (result == null) return "";
  const r = result as { content?: Array<{ type?: string; text?: string }>; output?: string };
  if (Array.isArray(r.content)) {
    return r.content.map((c) => c.text ?? "").join("\n");
  }
  if (typeof r.output === "string") return r.output;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** Structured web_search_results details only (no text fallback) — safe for
 *  any tool that attaches sources (e.g. deepsearch). */
function detailsSearchResults(item: ToolItem): SearchResult[] | undefined {
  const details = (item.result as { details?: { kind?: string; results?: SearchResult[] } })
    ?.details;
  if (details?.kind === "web_search_results" && Array.isArray(details.results)) {
    return details.results;
  }
  return undefined;
}

function searchResults(item: ToolItem): SearchResult[] | undefined {
  const fromDetails = detailsSearchResults(item);
  if (fromDetails) return fromDetails;
  // Fallback: the result text is a JSON array of {title,url,snippet}.
  try {
    const parsed = JSON.parse(resultText(item.result)) as SearchResult[];
    if (Array.isArray(parsed) && parsed.every((r) => typeof r?.url === "string")) return parsed;
  } catch {
    /* not JSON */
  }
  return undefined;
}

function argSummary(item: ToolItem): string {
  const args = item.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return "";
  if (item.toolName === "bash" && typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.query === "string") return String(args.query);
  if (typeof args.pattern === "string") return String(args.pattern);
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export function todoList(args: unknown): Todo[] | undefined {
  const todos = (args as { todos?: unknown })?.todos;
  if (!Array.isArray(todos)) return undefined;
  return todos.map((t: { content?: unknown; status?: unknown }) => ({
    content: String(t?.content ?? ""),
    status:
      t?.status === "completed" || t?.status === "in_progress" ? (t.status as Todo["status"]) : "pending",
  }));
}

export function ToolCard({ item, onForceStop }: { item: ToolItem; onForceStop?: () => void }) {
  const status = !item.done ? "running" : item.isError ? "error" : "ok";
  const forceStopButton =
    !item.done && onForceStop ? (
      <button
        className="tool-force-stop"
        title="Force stop this tool call if it is stuck"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onForceStop();
        }}
      >
        Force stop
      </button>
    ) : null;

  // set_todos → progress checklist.
  if (item.toolName === "set_todos") {
    const todos = todoList(item.args) ?? [];
    const done = todos.filter((t) => t.status === "completed").length;
    return (
      <div className={`tool-card ${status}`}>
        <div className="tool-head">
          <span className="tool-name">tasks</span>
          <span className="tool-arg">
            {done}/{todos.length} done
          </span>
          {forceStopButton}
        </div>
        <div className="todo-list">
          {todos.map((t, i) => (
            <div key={i} className={`todo-item ${t.status}`}>
              <span className="todo-mark">
                {t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}
              </span>
              {t.content}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (item.toolName === "web_search" && item.done && !item.isError) {
    const results = searchResults(item);
    if (results) {
      return (
        <details className={`tool-card ${status}`} open>
          <summary className="tool-head">
            <span className="tool-name">web_search</span>
            <span className="tool-arg">{argSummary(item)}</span>
          </summary>
          <div className="search-cards">
            {results.map((r, i) => (
              <a key={i} className="search-card" href={r.url} target="_blank" rel="noreferrer">
                <img
                  src={`https://icons.duckduckgo.com/ip3/${(() => {
                    try {
                      return new URL(r.url).hostname;
                    } catch {
                      return "example.com";
                    }
                  })()}.ico`}
                  alt=""
                />
                <div>
                  <div className="search-title">{r.title}</div>
                  <div className="search-snippet">{r.snippet}</div>
                  <div className="search-url">{r.url}</div>
                </div>
              </a>
            ))}
          </div>
        </details>
      );
    }
  }

  // edit → inline diff of old/new strings (§7.5).
  const edit = item.toolName === "edit" ? editStrings(item.args) : undefined;
  // write → whole content shown as additions.
  const written =
    item.toolName === "write" && typeof (item.args as { content?: unknown })?.content === "string"
      ? ((item.args as { content: string }).content as string)
      : undefined;

  const body = resultText(item.result);
  // Any tool can attach web_search_results details (e.g. deepsearch's full
  // source list) — rendered as the same cards web_search uses, below the body.
  const attachedSources =
    !item.isError && item.toolName !== "web_search" ? detailsSearchResults(item) : undefined;
  return (
    <details className={`tool-card ${status}`} open={item.toolName === "bash" && !item.done}>
      <summary className="tool-head">
        <span className="tool-name">{item.toolName}</span>
        <span className="tool-arg">{argSummary(item)}</span>
        {forceStopButton}
        <span className={`tool-status ${status}`}>{status}</span>
      </summary>
      {edit && <DiffView oldText={edit.oldText} newText={edit.newText} />}
      {written !== undefined && <DiffView oldText="" newText={written} />}
      {!edit && written === undefined && body && (
        <pre className={item.toolName === "bash" ? "terminal" : "tool-json"}>{body.slice(0, 20_000)}</pre>
      )}
      {attachedSources && attachedSources.length > 0 && (
        <>
          <div className="tool-sources-title">
            {item.toolName === "deepsearch" && !item.done ? "Visited links" : "Sources"} ({attachedSources.length})
          </div>
          <div className="search-cards">
            {attachedSources.map((r, i) => (
              <a key={i} className="search-card" href={r.url} target="_blank" rel="noreferrer">
                <div className="search-body">
                  <div className="search-title">{r.title || r.url}</div>
                  {r.snippet && <div className="search-snippet">{r.snippet}</div>}
                  <div className="search-url">{r.url}</div>
                </div>
              </a>
            ))}
          </div>
        </>
      )}
    </details>
  );
}
