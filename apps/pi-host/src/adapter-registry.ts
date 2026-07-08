/**
 * Selects the active HarnessAdapter (§1). Swapping harnesses later means
 * adding a case here and flipping the `adapter` setting — nothing else.
 */
import type { HarnessAdapter } from "@pi-desktop/harness-sdk";
import { MockAdapter } from "@pi-desktop/harness-sdk/mock";

export interface AdapterFactoryOptions {
  /** Harness-global config dir override (used by tests). */
  agentDir?: string;
}

export async function createAdapter(
  kind: string,
  options: AdapterFactoryOptions = {},
): Promise<HarnessAdapter> {
  switch (kind) {
    case "pi": {
      // Dynamic import keeps pi completely out of the picture for other adapters.
      const { PiAdapter } = await import("./adapters/pi/index.js");
      return new PiAdapter(options);
    }
    case "mock":
      return new MockAdapter();
    default:
      throw new Error(`Unknown harness adapter: ${kind}`);
  }
}
