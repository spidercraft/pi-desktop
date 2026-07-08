/** Shared model-list helpers: local providers surface first. */
import type { ModelInfo } from "@pi-desktop/protocol";

const LOCAL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "lm-studio",
  "llamacpp",
  "llama-cpp",
  "llama.cpp",
  "local",
  "localhost",
  "vllm",
  "koboldcpp",
  "oobabooga",
  "textgen",
]);

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider.toLowerCase());
}

export type CliVendor = "anthropic" | "openai";

type CliPrefs = Partial<Record<CliVendor, boolean>>;

/** Which subscription vendor, if any, backs a provider's models. */
export function cliVendorForProvider(provider: string): CliVendor | undefined {
  const id = provider.toLowerCase();
  if (id === "anthropic") return "anthropic";
  if (id === "openai" || id === "openai-codex") return "openai";
  return undefined;
}

/** True when this provider's work is routed through the user's official CLI. */
export function usesOfficialCliForProvider(provider: string, cliPrefs?: CliPrefs): boolean {
  const vendor = cliVendorForProvider(provider);
  return Boolean(vendor && (cliPrefs?.[vendor] ?? vendor === "anthropic"));
}

function versionParts(text: string): number[] {
  const matches = text.match(/\d+(?:\.\d+)*/g) ?? [];
  return matches.flatMap((m) => m.split(".").map((p) => Number(p)).filter(Number.isFinite));
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function officialCliFamily(model: ModelInfo): string | undefined {
  const provider = model.provider.toLowerCase();
  const id = model.modelId.toLowerCase();
  const name = (model.displayName ?? model.modelId).toLowerCase();
  if (provider === "anthropic") {
    const family = /claude[- ](sonnet|opus|haiku|fable)/.exec(`${id} ${name}`)?.[1];
    return family ? `${provider}:${family}` : undefined;
  }
  if (provider === "openai" || provider === "openai-codex") {
    const key = id.includes("codex-spark")
      ? "codex-spark"
      : id.includes("codex-max")
        ? "codex-max"
        : id.includes("codex-mini")
          ? "codex-mini"
          : id.includes("codex")
            ? "codex"
            : id.includes("chat")
              ? "chat"
              : id.includes("mini")
                ? "mini"
                : id.includes("nano")
                  ? "nano"
                  : id.includes("pro")
                    ? "pro"
                    : /^o\d/.test(id)
                      ? id.replace(/-\d{4}.*$/, "")
                      : "base";
    return `${provider}:${key}`;
  }
  return undefined;
}

/** For official CLI routing, keep only the newest usable model line per family. */
export function currentOfficialCliModels(
  models: ModelInfo[],
  cliPrefs?: CliPrefs,
): ModelInfo[] {
  const best = new Map<string, { model: ModelInfo; version: number[]; index: number }>();
  const keep = new Set<ModelInfo>();

  models.forEach((model, index) => {
    if (!usesOfficialCliForProvider(model.provider, cliPrefs)) {
      keep.add(model);
      return;
    }
    const family = officialCliFamily(model);
    if (!family) {
      keep.add(model);
      return;
    }
    const version = versionParts(`${model.displayName ?? ""} ${model.modelId}`);
    const current = best.get(family);
    if (!current || compareVersions(version, current.version) > 0) {
      best.set(family, { model, version, index });
    }
  });

  for (const { model } of best.values()) keep.add(model);
  return models.filter((model) => keep.has(model));
}

/** UI metadata for how a model is billed/routed in model lists. */
export function modelRouteForProvider(
  provider: string,
  cliPrefs?: CliPrefs,
): { kind: "subscription" | "api"; label: string; title: string } {
  const vendor = cliVendorForProvider(provider);
  if (vendor) {
    const useCli = cliPrefs === undefined ? undefined : (cliPrefs[vendor] ?? vendor === "anthropic");
    return {
      kind: "subscription",
      label: `subscription${useCli === undefined ? "" : useCli ? " (official)" : " (pi)"}`,
      title: "Uses your OpenAI/Claude subscription. Change in Settings → Providers.",
    };
  }
  return {
    kind: "api",
    label: "api",
    title: "Uses direct API usage.",
  };
}

/** Compact token count: "128k", or "1M" / "1.5M" once it reaches millions. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(n / 1000)}k`;
}

/** Stable sort: local-provider models first, original order preserved within each group. */
export function localFirst(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort(
    (a, b) => Number(isLocalProvider(b.provider)) - Number(isLocalProvider(a.provider)),
  );
}
