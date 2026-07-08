/**
 * Right side panel (§7.6): the agent's live task list on top, artifacts
 * (code viewer, more later) below. Shown whenever either has content.
 */
import type { Todo } from "../chat/ToolCard.js";
import { CodeViewer, type ViewerContent } from "../viewer/CodeViewer.js";

function tasksWidth(todos?: Todo[]): number | undefined {
  if (!todos?.length) return undefined;
  const titleChars = `Tasks ${todos.filter((t) => t.status === "completed").length}/${todos.length}`.length;
  const longest = Math.max(titleChars, ...todos.map((t) => t.content.length));
  // Approximate the rendered text width so a task-only panel hugs its content,
  // while still leaving room for the status mark, gap, and horizontal padding.
  return Math.min(620, Math.max(180, Math.ceil(longest * 7.25) + 52));
}

export function SidePanel({
  todos,
  viewer,
  width,
  onCloseViewer,
}: {
  todos?: Todo[];
  viewer?: ViewerContent;
  /** Panel width in px (user-resizable). */
  width?: number;
  onCloseViewer: () => void;
}) {
  const done = todos?.filter((t) => t.status === "completed").length ?? 0;
  const autoWidth = viewer ? undefined : tasksWidth(todos);
  const panelStyle = width ? { width } : autoWidth ? { width: autoWidth } : undefined;
  return (
    <aside className={`viewer side-panel ${viewer ? "" : "tasks-only"}`} style={panelStyle}>
      {todos && todos.length > 0 && (
        <div className="panel-tasks">
          <div className="panel-title">
            Tasks
            <span className="dim">
              {done}/{todos.length}
            </span>
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
      )}
      {viewer && <CodeViewer content={viewer} onClose={onCloseViewer} embedded />}
    </aside>
  );
}
