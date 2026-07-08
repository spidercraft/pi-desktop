/**
 * The pi adapter validated against the same conformance suite a hypothetical
 * second adapter would run (§1). Uses a temp agentDir so the developer's real
 * ~/.pi/agent is never touched, and a dummy key that is never sent anywhere.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConformanceSuite } from "@pi-desktop/harness-sdk/conformance";
import { PiAdapter } from "../adapters/pi/index.js";

const agentDir = mkdtempSync(join(tmpdir(), "pi-desktop-conformance-"));

runConformanceSuite("pi", async () => new PiAdapter({ agentDir }), {
  cwd: agentDir,
  seedProvider: { id: "anthropic", apiKey: "test-key-not-real" },
});
