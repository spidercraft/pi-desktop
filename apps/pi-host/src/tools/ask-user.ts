/**
 * ask_user — neutral custom tool letting the model ask the user a question
 * with proposed answers. The user picks one or types their own; the answer is
 * returned to the model as the tool result.
 */
import type { NeutralToolDefinition } from "@pi-desktop/harness-sdk";
import type { UiRequest } from "@pi-desktop/protocol";

export function createAskUserTool(
  requestUi: (request: UiRequest, sessionId?: string) => Promise<unknown>,
): NeutralToolDefinition {
  return {
    name: "ask_user",
    label: "Ask user",
    readOnlyAllowedByDefault: true,
    description:
      "Ask the user a question when you need a decision, preference, or missing information. " +
      "Provide 2-4 short proposed answers in `options`; the user can pick one or type a custom answer. " +
      "Prefer asking over guessing when requirements are ambiguous.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask the user." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Proposed answers the user can pick from (2-4 recommended).",
        },
      },
      required: ["question"],
    },
    async execute(args, _signal, _onUpdate, context) {
      const question = String(args.question ?? "").trim();
      const options = Array.isArray(args.options)
        ? args.options.map((o) => String(o)).filter(Boolean).slice(0, 6)
        : [];
      if (!question) {
        return { content: [{ type: "text", text: "No question provided." }], isError: true };
      }
      const answer = await requestUi(
        {
          method: "ask",
          title: question,
          options,
          placeholder: "Type your own answer…",
        },
        context?.sessionId,
      );
      const text = typeof answer === "string" ? answer.trim() : "";
      return {
        content: [
          {
            type: "text",
            text: text
              ? `The user answered: ${text}`
              : "The user did not answer (dialog dismissed or timed out). Proceed with your best judgment.",
          },
        ],
      };
    },
  };
}
