/**
 * Pi-specific glue for §7.3: fulfills the neutral tool-call interception
 * capability using pi's documented `tool_call` extension event (which may
 * return `{ block: true, reason }`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCallInterceptor, UiBridge } from "@pi-desktop/harness-sdk";

function describeInput(input: unknown): string {
  try {
    const text = JSON.stringify(input);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return String(input);
  }
}

export function createPermissionBridge(
  sessionId: string,
  getInterceptor: () => ToolCallInterceptor | undefined,
  getUi: () => UiBridge | undefined,
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event) => {
      const interceptor = getInterceptor();
      if (!interceptor) return;
      const decision = await interceptor(event.toolName, event.input, sessionId);
      if (decision === "deny") {
        return { block: true, reason: "Blocked by permission policy" };
      }
      if (decision === "ask") {
        const ui = getUi();
        const ok = ui
          ? await ui.confirm(`Allow ${event.toolName}?`, describeInput(event.input))
          : false;
        if (!ok) return { block: true, reason: "Blocked by user" };
      }
      return undefined;
    });
  };
}
