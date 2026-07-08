/**
 * Permission policy engine (§7.3). Written entirely against neutral types;
 * the adapter's tool-call interception hook calls evaluate() and performs the
 * UI "ask" itself via the UiBridge.
 */
import type {
  PermissionPolicyConfig,
  PermissionRule,
  ToolDecision,
} from "@pi-desktop/harness-sdk";
import { MUTATING_TOOLS } from "./mode-engine.js";

function extractPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "cwd"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return undefined;
}

function ruleMatches(rule: PermissionRule, toolName: string, input: unknown): boolean {
  if (rule.toolName !== "*" && rule.toolName !== toolName) return false;
  if (rule.pathPrefix !== undefined) {
    const path = extractPath(input);
    if (path === undefined || !path.startsWith(rule.pathPrefix)) return false;
  }
  return true;
}

export class PermissionPolicyEngine {
  constructor(
    public policy: PermissionPolicyConfig,
    private readonly readOnlyAllowedTools: () => readonly string[],
  ) {}

  evaluate(toolName: string, input: unknown): ToolDecision {
    const mutating = MUTATING_TOOLS.has(toolName);
    switch (this.policy.mode) {
      case "full-auto":
        return "allow";
      case "deny-all-mutation":
        return this.readOnlyAllowedTools().includes(toolName) ? "allow" : "deny";
      case "ask":
        return mutating ? "ask" : "allow";
      case "custom": {
        for (const rule of this.policy.rules ?? []) {
          if (ruleMatches(rule, toolName, input)) return rule.decision;
        }
        // No matching rule: safe default — ask for mutations, allow the rest.
        return mutating ? "ask" : "allow";
      }
    }
  }
}
