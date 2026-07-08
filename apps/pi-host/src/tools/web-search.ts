/**
 * Multi-engine web_search tool (§7.4), registered through the adapter's
 * neutral registerTool() capability — no harness knowledge here.
 *
 * Engines (Settings → General → Web search):
 *   - duckduckgo (default): scrapes the HTML endpoint, zero configuration
 *   - brave: official API, needs an API key
 *   - searxng: self-hosted instance URL (must enable search.formats: [json])
 * The chosen engine is used for every search until changed.
 */
import type { NeutralToolDefinition, NeutralToolResult } from "@pi-desktop/harness-sdk";
import type { SettingsStore } from "../settings.js";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function ok(results: SearchHit[]): NeutralToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    // Structured details for the UI's search-result cards.
    details: { kind: "web_search_results", results },
  };
}

function fail(text: string): NeutralToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Strip tags and common entities from scraped HTML fragments. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------- DuckDuckGo ------------------------------- */

/** DDG links go through a redirect (`/l/?uddg=<encoded>`); unwrap it. */
function unwrapDdgUrl(href: string): string {
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    const real = url.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : href;
  } catch {
    return href;
  }
}

async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const res = await fetch(url, {
    signal: signal ?? null,
    headers: { "User-Agent": "Mozilla/5.0 (pi-desktop)" },
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  const html = await res.text();

  const links = [
    ...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g),
  ];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  return links.slice(0, 8).map((m, i) => ({
    title: stripHtml(m[2]),
    url: unwrapDdgUrl(m[1]),
    snippet: stripHtml(snippets[i]?.[1] ?? ""),
  }));
}

/* ---------------------------------- Brave ---------------------------------- */

async function searchBrave(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "8");
  const res = await fetch(url, {
    signal: signal ?? null,
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Brave returned HTTP ${res.status}${res.status === 401 ? " (bad API key?)" : ""}`);
  }
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? []).slice(0, 8).map((r) => ({
    title: stripHtml(r.title ?? ""),
    url: r.url ?? "",
    snippet: stripHtml(r.description ?? ""),
  }));
}

/* --------------------------------- SearXNG --------------------------------- */

async function searchSearxng(
  query: string,
  category: string | undefined,
  base: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  if (category) url.searchParams.set("categories", category);
  const res = await fetch(url, { signal: signal ?? null });
  if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? []).slice(0, 8).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

/* ---------------------------------- tool ----------------------------------- */

export function createWebSearchTool(settings: SettingsStore): NeutralToolDefinition {
  return {
    name: "web_search",
    label: "Web search",
    readOnlyAllowedByDefault: true,
    description:
      "Search the web. Returns a JSON list of results with title, url and snippet. " +
      "Issue several focused queries for research tasks.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        category: {
          type: "string",
          description: "Optional category (general, news, it, science, …) — SearXNG only",
        },
      },
      required: ["query"],
    },
    async execute(args, signal): Promise<NeutralToolResult> {
      const query = String(args.query ?? "");
      const engine = settings.get("searchEngine") ?? "duckduckgo";
      try {
        let results: SearchHit[];
        if (engine === "searxng") {
          const base = settings.get("searxngUrl");
          if (!base) {
            return fail(
              "web_search (SearXNG) is not configured — set the instance URL in " +
                "Settings → General, or switch the search engine.",
            );
          }
          results = await searchSearxng(
            query,
            typeof args.category === "string" ? args.category : undefined,
            base,
            signal,
          );
        } else if (engine === "brave") {
          const apiKey = settings.get("braveApiKey");
          if (!apiKey) {
            return fail(
              "web_search (Brave) is not configured — set the API key in " +
                "Settings → General, or switch the search engine.",
            );
          }
          results = await searchBrave(query, apiKey, signal);
        } else {
          results = await searchDuckDuckGo(query, signal);
        }
        return ok(results);
      } catch (err) {
        return fail(`web_search failed (${engine}): ${(err as Error).message}`);
      }
    },
  };
}

/** Connection test used by the Settings screen ("Save & test" for SearXNG). */
export async function testSearxng(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = new URL("/search", baseUrl);
    url.searchParams.set("q", "connection test");
    url.searchParams.set("format", "json");
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} (is search.formats: [json] enabled?)` };
    await res.json();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
