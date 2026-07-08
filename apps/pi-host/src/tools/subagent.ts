/**
 * plan & deepsearch as delegable tools: each spawns a short-lived, in-memory
 * subagent session (read-only plan config / research config from the mode
 * engine) and returns its final answer as the tool result. The host injects
 * the actual runner so this file stays free of session plumbing.
 */
import type { NeutralToolDefinition, NeutralToolResult } from "@pi-desktop/harness-sdk";

export interface SubagentSource {
  title: string;
  url: string;
  snippet?: string;
}

export interface SubagentRunResult {
  output: string;
  /** Every web_search hit the run touched (deepsearch); rendered as cards. */
  sources: SubagentSource[];
}

export type RunSubagentProgress = (partial: SubagentRunResult) => void;

export type RunSubagent = (
  mode: "plan" | "deepsearch",
  promptText: string,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  onProgress?: RunSubagentProgress,
) => Promise<SubagentRunResult>;

function ok(text: string): NeutralToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): NeutralToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function createPlanTool(run: RunSubagent): NeutralToolDefinition {
  return {
    name: "plan",
    label: "Plan",
    description:
      "Delegate planning to a read-only planning agent: it inspects the project and returns " +
      "a step-by-step implementation plan. Use it before non-trivial or multi-file changes, " +
      "and ALWAYS when the user mentions @plan.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "What to plan, with all relevant constraints and context",
        },
      },
      required: ["task"],
    },
    async execute(args, signal, _onUpdate, context): Promise<NeutralToolResult> {
      const task = String(args.task ?? "").trim();
      if (!task) return fail("plan failed: task is empty");
      if (!context?.cwd) {
        return fail("plan failed: this chat has no project folder to inspect");
      }
      try {
        return ok((await run("plan", task, context.cwd, signal)).output);
      } catch (err) {
        return fail(`plan failed: ${(err as Error).message}`);
      }
    },
  };
}

export function createDeepsearchTool(run: RunSubagent): NeutralToolDefinition {
  return {
    name: "deepsearch",
    label: "Deep search",
    description:
      "Delegate web research to a research agent: it runs many varied web searches, " +
      "cross-checks sources, and returns a structured cited report. Use it for questions " +
      "needing thorough sourced research, and ALWAYS when the user mentions @deepsearch.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The research question, with any scope or constraints",
        },
      },
      required: ["query"],
    },
    async execute(args, signal, onUpdate, context): Promise<NeutralToolResult> {
      const query = String(args.query ?? "").trim();
      if (!query) return fail("deepsearch failed: query is empty");
      try {
        onUpdate?.({ content: [{ type: "text", text: "Deepsearch is starting… 0 visited links so far." }] });
        const result = await run("deepsearch", query, context?.cwd, signal, (partial) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text:
                  partial.output ||
                  `Deepsearch is running… ${partial.sources.length} visited link${partial.sources.length === 1 ? "" : "s"} so far.`,
              },
            ],
            ...(partial.sources.length > 0
              ? { details: { kind: "web_search_results", results: partial.sources } }
              : {}),
          });
        });
        return {
          content: [{ type: "text", text: result.output }],
          // Same shape web_search uses — the UI renders these as source cards.
          ...(result.sources.length > 0
            ? { details: { kind: "web_search_results", results: result.sources } }
            : {}),
        };
      } catch (err) {
        return fail(`deepsearch failed: ${(err as Error).message}`);
      }
    },
  };
}
