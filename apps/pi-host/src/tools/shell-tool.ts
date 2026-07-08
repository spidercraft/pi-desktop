/**
 * Neutral shell tool ("bash") registered through the adapter's registerTool()
 * capability — no harness knowledge here. Runs in the session cwd via the
 * platform shell (sh on POSIX, cmd on Windows), streams combined output, and
 * enforces a timeout and an output cap.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { NeutralToolDefinition, NeutralToolResult } from "@pi-desktop/harness-sdk";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
const MAX_OUTPUT_CHARS = 100_000;

export function createShellTool(): NeutralToolDefinition {
  return {
    name: "bash",
    label: "Run shell command",
    description:
      "Run a shell command in the workspace folder and return its combined " +
      "stdout/stderr. Long output is tail-truncated. Use timeout (seconds) for " +
      "long-running commands.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout: {
          type: "number",
          description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})`,
        },
      },
      required: ["command"],
    },
    execute(args, signal, onUpdate, context): Promise<NeutralToolResult> {
      const command = String(args.command ?? "").trim();
      if (!command) {
        return Promise.resolve({
          content: [{ type: "text", text: "bash failed: command is empty" }],
          isError: true,
        });
      }
      const timeoutMs =
        Math.min(Math.max(Number(args.timeout) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S) * 1000;

      return new Promise((resolvePromise) => {
        const child = spawn(command, {
          cwd: context?.cwd ?? homedir(),
          shell: true,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let output = "";
        let truncatedBytes = 0;
        let timedOut = false;
        let settled = false;

        const append = (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.length > MAX_OUTPUT_CHARS) {
            truncatedBytes += output.length - MAX_OUTPUT_CHARS;
            output = output.slice(-MAX_OUTPUT_CHARS); // keep the tail — errors live there
          }
          onUpdate?.({ content: [{ type: "text", text: output }] });
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);

        const killTimer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        const onAbort = () => child.kill("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });

        const finish = (text: string, isError: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          signal?.removeEventListener("abort", onAbort);
          resolvePromise({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
        };

        child.on("error", (err) => finish(`bash failed: ${err.message}`, true));
        child.on("close", (code, killSignal) => {
          let text = output;
          if (truncatedBytes > 0) {
            text = `[output truncated: ${truncatedBytes} earlier characters dropped]\n${text}`;
          }
          if (timedOut) {
            finish(`${text}\n[killed: timed out after ${timeoutMs / 1000}s]`, true);
          } else if (signal?.aborted) {
            finish(`${text}\n[killed: aborted]`, true);
          } else if (code !== 0) {
            finish(`${text}\n[exit code ${code ?? `signal ${killSignal}`}]`, true);
          } else {
            finish(text || "(no output)", false);
          }
        });
      });
    },
  };
}
