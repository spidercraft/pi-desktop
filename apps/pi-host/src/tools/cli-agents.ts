/**
 * claude_code & codex: delegate work to the official vendor CLIs.
 */
import { spawn } from "node:child_process";
import type { NeutralToolDefinition, NeutralToolResult } from "@pi-desktop/harness-sdk";

function ok(text: string): NeutralToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): NeutralToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

interface CliResult {
  output: string;
  rawText?: string;
  sessionId?: string;
  meta?: string;
}

function appendText(current: string | undefined, next: string | undefined): string {
  const value = next?.trim();
  if (!value) return current ?? "";
  if (!current) return value;
  return `${current}\n${value}`;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const chunks: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = firstString(record, ["text", "message", "content"]);
    if (text) chunks.push(text);
  }
  return chunks.join("\n").trim() || undefined;
}

function runJsonlCli(options: {
  command: string;
  args: string[];
  cwd: string;
  input: string;
  signal: AbortSignal | undefined;
  notFoundHint: string;
  onEvent: (event: Record<string, unknown>, state: CliResult) => void;
}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      shell: process.platform === "win32",
    });

    const state: CliResult = { output: "" };
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error("aborted")));
    };
    options.signal?.addEventListener("abort", onAbort);

    const handleLine = (line: string) => {
      if (!line) return;
      try {
        options.onEvent(JSON.parse(line) as Record<string, unknown>, state);
      } catch {
        state.rawText = appendText(state.rawText, line);
      }
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(new Error(err.code === "ENOENT" ? options.notFoundHint : err.message)),
      );
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(stdoutBuffer.slice(0, newline).trim());
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      finish(() => {
        handleLine(stdoutBuffer.trim());
        if (!state.output && !state.rawText && code !== 0) {
          reject(new Error(stderr.trim().slice(-500) || `exited with code ${code}`));
        } else {
          resolve(state);
        }
      });
    });

    child.stdin.write(options.input);
    child.stdin.end();
  });
}

function snippet(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export function createClaudeCodeTool(isEnabled: () => boolean): NeutralToolDefinition {
  const cliSessions = new Map<string, string>();

  return {
    name: "claude_code",
    label: "Claude Code",
    description:
      "Delegate a coding task to the official Claude Code CLI. It runs its own full agentic " +
      "loop in the project folder, billed to the user's Claude subscription plan.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The complete task, with all context the CLI needs",
        },
        continueSession: {
          type: "boolean",
          description: "Resume this chat's previous claude_code session",
        },
        readOnly: {
          type: "boolean",
          description: "Run without edit/write/shell tools for read-only fallback workspaces",
        },
        modelId: {
          type: "string",
          description: "Claude model id or alias selected in Pi Desktop",
        },
      },
      required: ["task"],
    },
    async execute(args, signal, onUpdate, context): Promise<NeutralToolResult> {
      if (!isEnabled()) {
        return fail("claude_code is disabled (Settings -> Providers -> official CLI toggle)");
      }
      const task = String(args.task ?? "").trim();
      if (!task) return fail("claude_code failed: task is empty");
      if (!context?.cwd) return fail("claude_code failed: this chat has no project folder");

      const parentKey = context.sessionId ?? context.cwd;
      const resumeId = args.continueSession === true ? cliSessions.get(parentKey) : undefined;
      const readOnly = args.readOnly === true;
      const modelId = typeof args.modelId === "string" ? args.modelId.trim() : "";
      const cliArgs = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        readOnly
          ? "Read,Grep,Glob,WebSearch,WebFetch"
          : "Bash,Read,Edit,Write,Grep,Glob,WebSearch,WebFetch",
      ];
      if (modelId) cliArgs.push("--model", modelId);
      if (!readOnly) cliArgs.push("--permission-mode", "acceptEdits");
      if (resumeId) cliArgs.push("--resume", resumeId);

      try {
        const result = await runJsonlCli({
          command: "claude",
          args: cliArgs,
          cwd: context.cwd,
          input: task,
          signal,
          notFoundHint:
            "Claude Code CLI not found. Install it (npm install -g @anthropic-ai/claude-code) " +
            "and log in with `claude` once, then retry.",
          onEvent: (event, state) => {
            const type = event.type as string | undefined;
            if (type === "assistant") {
              const message = event.message as
                | { content?: Array<{ type?: string; text?: string; name?: string }> }
                | undefined;
              for (const block of message?.content ?? []) {
                if (block.type === "text" && block.text) {
                  state.output = appendText(state.output, block.text);
                  onUpdate?.({ content: [{ type: "text", text: snippet(block.text) }] });
                } else if (block.type === "tool_use" && block.name) {
                  onUpdate?.({ content: [{ type: "text", text: `tool: ${block.name}` }] });
                }
              }
            } else if (type === "result") {
              const r = event as {
                result?: string;
                session_id?: string;
                num_turns?: number;
                total_cost_usd?: number;
              };
              if (r.result?.trim()) state.output = r.result;
              state.sessionId = r.session_id;
              const meta: string[] = [];
              if (r.num_turns) meta.push(`${r.num_turns} turns`);
              if (r.total_cost_usd !== undefined) meta.push(`$${r.total_cost_usd.toFixed(4)}`);
              if (meta.length > 0) state.meta = meta.join(" - ");
            }
          },
        });
        if (result.sessionId) cliSessions.set(parentKey, result.sessionId);
        return ok(result.output || result.rawText || "(no output)");
      } catch (err) {
        return fail(`claude_code failed: ${(err as Error).message}`);
      }
    },
  };
}

export function createCodexTool(isEnabled: () => boolean): NeutralToolDefinition {
  return {
    name: "codex",
    label: "Codex",
    description:
      "Delegate a coding task to the official OpenAI Codex CLI. It runs its own full agentic " +
      "loop in the project folder, billed to the user's ChatGPT subscription plan.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The complete task, with all context the CLI needs",
        },
        readOnly: {
          type: "boolean",
          description: "Run Codex in a read-only sandbox for fallback workspaces",
        },
        modelId: {
          type: "string",
          description: "Codex model id selected in Pi Desktop",
        },
      },
      required: ["task"],
    },
    async execute(args, signal, onUpdate, context): Promise<NeutralToolResult> {
      if (!isEnabled()) {
        return fail("codex is disabled (Settings -> Providers -> official CLI toggle)");
      }
      const task = String(args.task ?? "").trim();
      if (!task) return fail("codex failed: task is empty");
      if (!context?.cwd) return fail("codex failed: this chat has no project folder");

      try {
        const modelId = typeof args.modelId === "string" ? args.modelId.trim() : "";
        const cliArgs =
          args.readOnly === true
            ? ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-"]
            : ["exec", "--json", "--full-auto", "--skip-git-repo-check", "-"];
        if (modelId) cliArgs.splice(2, 0, "--model", modelId);
        const result = await runJsonlCli({
          command: "codex",
          args: cliArgs,
          cwd: context.cwd,
          input: task,
          signal,
          notFoundHint:
            "Codex CLI not found. Install it (npm install -g @openai/codex) and log in " +
            "with `codex` once, then retry.",
          onEvent: (event, state) => {
            const item =
              event.item && typeof event.item === "object" && !Array.isArray(event.item)
                ? (event.item as Record<string, unknown>)
                : undefined;
            const msg = (event.msg ?? item ?? event) as Record<string, unknown>;
            const type = String(msg.type ?? event.type ?? "");
            const text =
              firstString(msg, [
                "message",
                "text",
                "result",
                "final_answer",
                "last_agent_message",
                "output",
                "summary",
              ]) ?? textFromContent(msg.content);

            if (text && /(?:agent|assistant|message|result|complete|final|response)/i.test(type)) {
              state.output =
                type.includes("delta") || type.includes("partial")
                  ? appendText(state.output, text)
                  : text;
              onUpdate?.({ content: [{ type: "text", text: snippet(text) }] });
            } else if (type.startsWith("exec_command") && typeof msg.command === "string") {
              onUpdate?.({ content: [{ type: "text", text: `tool: ${snippet(msg.command)}` }] });
            } else if (!type && text) {
              state.output = appendText(state.output, text);
            }
          },
        });
        return ok(result.output || result.rawText || "(no output)");
      } catch (err) {
        return fail(`codex failed: ${(err as Error).message}`);
      }
    },
  };
}
