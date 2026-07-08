/**
 * The conformance suite validated against the reference "second adapter".
 */
import { runConformanceSuite } from "../conformance.js";
import { MockAdapter } from "../mock-adapter.js";

runConformanceSuite("mock", async () => new MockAdapter(), {
  seedProvider: { id: "anthropic", apiKey: "test-key-not-real" },
});
