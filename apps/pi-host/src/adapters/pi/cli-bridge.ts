/**
 * Wraps the `pi` CLI for package management (§2) and reads pi's settings.json
 * conventions for listing. Pi-specific by design — lives inside adapters/pi.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginInfo, PluginManager } from "@pi-desktop/harness-sdk";

const require = createRequire(import.meta.url);

function piCliPath(): string {
  const pkgPath = require.resolve("@earendil-works/pi-coding-agent/package.json");
  return join(dirname(pkgPath), "dist", "cli.js");
}

function runPiCli(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [piCliPath(), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pi ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
    });
  });
}

function readPackages(settingsPath: string, scope: PluginInfo["scope"]): PluginInfo[] {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      packages?: Array<string | { source?: string }>;
    };
    return (parsed.packages ?? []).map((entry) => {
      const source = typeof entry === "string" ? entry : (entry.source ?? "unknown");
      return { name: source.split("/").pop() ?? source, source, scope };
    });
  } catch {
    return [];
  }
}

export class PiPluginManager implements PluginManager {
  constructor(
    private readonly agentDir: string = join(homedir(), ".pi", "agent"),
    private readonly projectCwd?: string,
  ) {}

  async list(): Promise<PluginInfo[]> {
    const global = readPackages(join(this.agentDir, "settings.json"), "global");
    const project = this.projectCwd
      ? readPackages(join(this.projectCwd, ".pi", "settings.json"), "project")
      : [];
    return [...global, ...project];
  }

  async install(source: string): Promise<void> {
    await runPiCli(["install", source], this.projectCwd);
  }

  async remove(source: string): Promise<void> {
    await runPiCli(["remove", source], this.projectCwd);
  }

  async update(source?: string): Promise<void> {
    await runPiCli(source ? ["update", source] : ["update"], this.projectCwd);
  }
}
