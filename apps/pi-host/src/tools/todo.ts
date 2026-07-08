/**
 * set_todos — neutral custom tool letting the model publish its task list.
 * Each call replaces the whole list; the UI renders it as a checklist card,
 * so progress is visible while the agent works through multi-step tasks.
 */
import type { NeutralToolDefinition } from "@pi-desktop/harness-sdk";

const STATUSES = ["pending", "in_progress", "completed"] as const;
type Status = (typeof STATUSES)[number];

export function createTodoTool(): NeutralToolDefinition {
  return {
    name: "set_todos",
    label: "Todo list",
    readOnlyAllowedByDefault: true,
    description:
      "Publish or update your task list so the user can follow your progress. " +
      "Call this when starting multi-step work (3+ steps), then again whenever a step's " +
      "status changes. Always send the FULL list; each call replaces the previous one. " +
      "Keep at most one item in_progress at a time.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete, ordered task list.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Short description of the step." },
              status: { type: "string", enum: [...STATUSES] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    async execute(args) {
      const todos = Array.isArray(args.todos)
        ? (args.todos as Array<{ content?: unknown; status?: unknown }>).map((t) => ({
            content: String(t?.content ?? ""),
            status: (STATUSES.includes(t?.status as Status)
              ? t?.status
              : "pending") as Status,
          }))
        : [];
      const done = todos.filter((t) => t.status === "completed").length;
      return {
        content: [
          {
            type: "text",
            text: `Todo list updated: ${done}/${todos.length} completed.`,
          },
        ],
      };
    },
  };
}
