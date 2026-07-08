/**
 * Conformance suite (§1): every HarnessAdapter — pi today, anything tomorrow —
 * must pass these tests. Deliberately avoids anything that needs a live LLM
 * call: it validates capabilities coherence, session lifecycle, event plumbing
 * and manager surfaces only.
 *
 * Usage (inside a `node --test` file):
 *
 *   runConformanceSuite("pi", () => makePiAdapter());
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessAdapter } from "./adapter.js";
import type { UiBridge } from "./types.js";

/** A UiBridge that auto-answers; good enough for conformance runs. */
export function autoUiBridge(confirmAnswer = true): UiBridge {
  return {
    confirm: async () => confirmAnswer,
    select: async (_t, options) => options[0],
    input: async () => "",
    notify: () => {},
    setStatus: () => {},
  };
}

export interface ConformanceOptions {
  /**
   * cwd used for filesystem-bound session tests. When omitted, only in-memory
   * sessions are exercised.
   */
  cwd?: string;
  /** Provider id + dummy key seeded before session tests (never sent anywhere). */
  seedProvider?: { id: string; apiKey: string };
}

export function runConformanceSuite(
  label: string,
  makeAdapter: () => Promise<HarnessAdapter>,
  options: ConformanceOptions = {},
): void {
  const withAdapter = async (fn: (adapter: HarnessAdapter) => Promise<void>) => {
    const adapter = await makeAdapter();
    await adapter.initialize({ ui: autoUiBridge() });
    if (options.seedProvider && adapter.providers) {
      await adapter.providers.addProvider(options.seedProvider.id, options.seedProvider.apiKey);
    }
    try {
      await fn(adapter);
    } finally {
      await adapter.dispose();
    }
  };

  test(`[${label}] capabilities are well-formed and coherent`, async () => {
    await withAdapter(async (adapter) => {
      const caps = adapter.capabilities;
      assert.ok(caps.id.length > 0, "capabilities.id must be non-empty");
      assert.ok(caps.displayName.length > 0);
      for (const flag of [
        "supportsSessionTree",
        "supportsToolCallInterception",
        "supportsMcpBridge",
        "supportsPluginInstall",
        "supportsDynamicProviderRegistration",
        "supportsCustomTools",
        "supportsCompaction",
        "supportsSteering",
        "supportsThinkingLevels",
        "supportsSkills",
      ] as const) {
        assert.equal(typeof caps[flag], "boolean", `${flag} must be boolean`);
      }
      // Manager surfaces must exist exactly when the flag says so.
      assert.equal(!!adapter.providers, caps.supportsDynamicProviderRegistration);
      assert.equal(!!adapter.plugins, caps.supportsPluginInstall);
      assert.equal(!!adapter.mcp, caps.supportsMcpBridge);
      assert.equal(!!adapter.skills, caps.supportsSkills);
    });
  });

  test(`[${label}] in-memory session lifecycle`, async () => {
    await withAdapter(async (adapter) => {
      const session = await adapter.createSession({ inMemory: true, tools: [] });
      assert.ok(session.id.length > 0);
      assert.equal(session.isStreaming, false);
      const seen: string[] = [];
      const unsubscribe = session.subscribe((e) => seen.push(e.type));
      assert.equal(typeof unsubscribe, "function");
      unsubscribe();
      await session.dispose();
    });
  });

  test(`[${label}] two sessions get distinct ids`, async () => {
    await withAdapter(async (adapter) => {
      const a = await adapter.createSession({ inMemory: true, tools: [] });
      const b = await adapter.createSession({ inMemory: true, tools: [] });
      assert.notEqual(a.id, b.id);
      await a.dispose();
      await b.dispose();
    });
  });

  test(`[${label}] listSessions returns an array`, async () => {
    await withAdapter(async (adapter) => {
      const sessions = await adapter.listSessions(options.cwd);
      assert.ok(Array.isArray(sessions));
    });
  });

  test(`[${label}] thinking level round-trips when supported`, async () => {
    await withAdapter(async (adapter) => {
      if (!adapter.capabilities.supportsThinkingLevels) return;
      const session = await adapter.createSession({ inMemory: true, tools: [] });
      try {
        assert.ok(
          session.setThinkingLevel && session.getThinking,
          "supportsThinkingLevels implies setThinkingLevel/getThinking on sessions",
        );
        const info = await session.getThinking!();
        assert.ok(Array.isArray(info.available) && info.available.length > 0);
        assert.ok(info.available.includes(info.level), "current level must be available");
        const target = info.available[info.available.length - 1];
        await session.setThinkingLevel!(target);
        assert.equal((await session.getThinking!()).level, target);
      } finally {
        await session.dispose();
      }
    });
  });

  test(`[${label}] tool-call interceptor registration`, async () => {
    await withAdapter(async (adapter) => {
      if (!adapter.capabilities.supportsToolCallInterception) return;
      adapter.registerToolCallInterceptor(() => "allow");
    });
  });

  test(`[${label}] custom tool registration is visible to new sessions`, async () => {
    await withAdapter(async (adapter) => {
      if (!adapter.capabilities.supportsCustomTools) return;
      adapter.registerTool({
        name: "conformance_echo",
        label: "Echo",
        description: "Echoes its input (conformance probe).",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        execute: async (args) => ({
          content: [{ type: "text", text: String(args.value) }],
        }),
      });
      const session = await adapter.createSession({
        inMemory: true,
        tools: ["conformance_echo"],
      });
      await session.dispose();
    });
  });

  test(`[${label}] provider manager basics`, async () => {
    await withAdapter(async (adapter) => {
      if (!adapter.providers) return;
      const providers = await adapter.providers.listProviders();
      assert.ok(Array.isArray(providers));
      const models = await adapter.providers.getAvailableModels();
      assert.ok(Array.isArray(models));
      if (options.seedProvider) {
        assert.ok(
          providers.some((p) => p.id === options.seedProvider!.id && p.hasCredentials),
          "seeded provider must be listed with credentials",
        );
      }
    });
  });

  test(`[${label}] plugin manager list()`, async () => {
    await withAdapter(async (adapter) => {
      if (!adapter.plugins) return;
      const plugins = await adapter.plugins.list();
      assert.ok(Array.isArray(plugins));
    });
  });
}
