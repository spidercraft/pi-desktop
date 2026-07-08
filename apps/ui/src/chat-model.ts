/** Chat transcript reducer over neutral HarnessEvents (§7.1 / §7.6). */
import type { HarnessEvent } from "@pi-desktop/protocol";

export type ChatItem =
  | { kind: "user"; text: string; queued?: boolean }
  | {
      kind: "assistant";
      text: string;
      streaming: boolean;
      /** Set when the first token arrived (for duration/rate stats). */
      startedAt?: number;
      durationMs?: number;
      outputTokens?: number;
      /** Context consumed / window size after this message (for the fill circle). */
      contextTokens?: number;
      contextWindow?: number;
    }
  | { kind: "thinking"; text: string; streaming: boolean; startedAt?: number; durationMs?: number }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      isError?: boolean;
      done: boolean;
    }
  | { kind: "system"; text: string };

/** Finalize a trailing thinking block (streaming -> done + duration) the moment
 *  the model moves on to text or a tool. Mutates the array in place. */
function closeThinking(items: ChatItem[]): void {
  const last = items[items.length - 1];
  if (last && last.kind === "thinking" && last.streaming) {
    items[items.length - 1] = {
      ...last,
      streaming: false,
      durationMs: last.startedAt !== undefined ? Date.now() - last.startedAt : last.durationMs,
    };
  }
}

export function applyEvent(items: ChatItem[], event: HarnessEvent): ChatItem[] {
  const next = [...items];
  const last = next[next.length - 1];

  switch (event.type) {
    case "agent_start": {
      // A new run consumes the oldest queued message.
      const i = next.findIndex((item) => item.kind === "user" && item.queued);
      if (i >= 0) next[i] = { ...(next[i] as { kind: "user"; text: string }), queued: false };
      return next;
    }
    case "queue_update": {
      // Authoritative queue size from the harness: only the last N queued
      // user messages are still pending — anything older has been sent.
      let remaining = event.steering.length + event.followUp.length;
      for (let i = next.length - 1; i >= 0; i--) {
        const item = next[i];
        if (item.kind === "user" && item.queued) {
          if (remaining > 0) remaining--;
          else next[i] = { ...item, queued: false };
        }
      }
      return next;
    }
    case "message_update": {
      const { kind, delta } = event.delta;
      if (kind === "toolcall") return next; // rendered via tool_execution_* events
      const wantKind = kind === "text" ? "assistant" : "thinking";
      if (last && last.kind === wantKind && last.streaming) {
        next[next.length - 1] = { ...last, text: last.text + delta };
      } else if (wantKind === "assistant") {
        closeThinking(next);
        next.push({ kind: "assistant", text: delta, streaming: true, startedAt: Date.now() });
      } else {
        next.push({ kind: "thinking", text: delta, streaming: true, startedAt: Date.now() });
      }
      return next;
    }
    case "message_end": {
      if (event.role !== "assistant") return next;
      for (let i = next.length - 1; i >= 0; i--) {
        const item = next[i];
        if (item.kind === "assistant" && item.streaming) {
          next[i] = {
            kind: "assistant",
            text: event.text || item.text,
            streaming: false,
            startedAt: item.startedAt,
            durationMs: item.startedAt !== undefined ? Date.now() - item.startedAt : undefined,
            outputTokens: event.usage?.outputTokens,
            contextTokens:
              event.usage?.totalTokens ??
              (event.usage ? event.usage.inputTokens + event.usage.outputTokens : undefined),
            contextWindow: event.usage?.contextWindow,
          };
          return next;
        }
      }
      if (event.text) next.push({ kind: "assistant", text: event.text, streaming: false });
      return next;
    }
    case "tool_execution_start":
      closeThinking(next);
      next.push({
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        done: false,
      });
      return next;
    case "tool_execution_update":
    case "tool_execution_end": {
      for (let i = next.length - 1; i >= 0; i--) {
        const item = next[i];
        if (item.kind === "tool" && item.toolCallId === event.toolCallId) {
          next[i] =
            event.type === "tool_execution_end"
              ? { ...item, result: event.result, isError: event.isError, done: true }
              : { ...item, result: event.partialResult };
          break;
        }
      }
      return next;
    }
    case "agent_end":
      if (event.errorMessage) next.push({ kind: "system", text: `Error: ${event.errorMessage}` });
      if (event.aborted) next.push({ kind: "system", text: "Aborted." });
      // Close any dangling streaming items.
      return next.map((item) =>
        (item.kind === "assistant" || item.kind === "thinking") && item.streaming
          ? {
              ...item,
              streaming: false,
              ...(item.kind === "thinking" && item.startedAt !== undefined
                ? { durationMs: Date.now() - item.startedAt }
                : {}),
            }
          : item,
      );
    case "compaction_start":
      next.push({ kind: "system", text: "Compacting conversation…" });
      return next;
    case "compaction_end":
      next.push({
        kind: "system",
        text: event.errorMessage
          ? `Compaction failed: ${event.errorMessage}`
          : "Conversation compacted.",
      });
      return next;
    case "error":
      next.push({ kind: "system", text: `Error: ${event.message}` });
      return next;
    default:
      return next;
  }
}
