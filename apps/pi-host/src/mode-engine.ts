/**
 * Mode engine (§7.2). Modes are an app concept: each mode is just a neutral
 * SessionConfig handed to the active adapter. No harness knowledge here.
 */
import type { ModeId, PermissionPolicyConfig, SessionConfig } from "@pi-desktop/harness-sdk";

const PLAN_SYSTEM_PROMPT = `You are in PLAN mode. You may inspect the project with read-only tools
(read, grep, find, ls) but you must NOT modify anything. Produce a clear,
step-by-step implementation plan as your final answer — a plan artifact, not
edits. If asked to change files, explain the change in the plan instead.`;

const DEEPSEARCH_SYSTEM_PROMPT = `You are in DEEPSEARCH mode. Answer research questions by issuing
multiple web_search tool calls with varied queries, cross-checking sources.
Then produce a structured, cited report: a short summary, findings grouped by
theme, and a source list with URLs. Prefer primary sources. After the report,
keep answering follow-up questions in the same conversation.`;

/** Tool names considered mutating when a policy asks only about mutations. */
export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

export function sessionConfigForMode(
  mode: ModeId,
  cwd: string | undefined,
  policy: PermissionPolicyConfig,
): SessionConfig {
  switch (mode) {
    case "chat":
      return {
        inMemory: true,
        tools: ["web_search", "ask_user", "set_todos", "deepsearch"],
        permissionPolicy: policy,
      };
    case "plan":
      return {
        cwd,
        tools: ["read", "grep", "find", "ls", "ask_user", "set_todos"],
        systemPromptOverride: PLAN_SYSTEM_PROMPT,
        // Policy is inherited from the workspace (not forced by the mode);
        // plan mode is read-only anyway via its tool list + system prompt.
        permissionPolicy: policy,
      };
    case "code":
      return {
        cwd,
        tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "web_search", "ask_user", "set_todos", "plan", "deepsearch", "claude_code", "codex"],
        permissionPolicy: policy,
      };
    case "deepsearch":
      return {
        inMemory: cwd === undefined,
        cwd,
        tools: ["web_search", "read", "grep", "ask_user", "set_todos"],
        systemPromptOverride: DEEPSEARCH_SYSTEM_PROMPT,
        permissionPolicy: policy,
      };
  }
}

export function deepsearchPromptTemplate(query: string): string {
  return `Research the following question thoroughly using the web_search tool
(multiple queries, cross-check sources), then write a structured cited report.

Question: ${query}`;
}
