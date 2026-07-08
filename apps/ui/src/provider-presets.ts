/**
 * Pre-made provider presets (§7.8): each fills in base URL + API dialect so
 * users never have to see them. "Custom…" exposes every field.
 */

export interface ProviderPreset {
  /** Provider id written into the model/provider config. */
  id: string;
  label: string;
  baseUrl?: string;
  api?: string;
  /** Cloud providers need a key; local servers usually don't. */
  needsApiKey: boolean;
  modelPlaceholder?: string;
}

export const CUSTOM_PRESET = "__custom__";

export const MODEL_PRESETS: ProviderPreset[] = [
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    needsApiKey: false,
    modelPlaceholder: "llama3.3:70b, qwen2.5-coder…",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    api: "openai-completions",
    needsApiKey: false,
    modelPlaceholder: "qwen2.5-coder-32b-instruct…",
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    baseUrl: "http://localhost:8080/v1",
    api: "openai-completions",
    needsApiKey: false,
    modelPlaceholder: "(as served by llama-server)",
  },
  {
    id: "vllm",
    label: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    api: "openai-completions",
    needsApiKey: false,
    modelPlaceholder: "(model name passed to vllm serve)",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    needsApiKey: true,
    modelPlaceholder: "deepseek/deepseek-chat, meta-llama/llama-3.3-70b…",
  },
];

/** Wire API dialects pi understands. */
export const API_DIALECTS = [
  { id: "openai-completions", label: "OpenAI-compatible (Ollama, LM Studio, vLLM…)" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
] as const;
