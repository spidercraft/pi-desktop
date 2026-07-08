/** Host-level settings (adapter selection, SearXNG URL). Not harness settings. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HostSettings } from "@pi-desktop/protocol";

const SETTINGS_PATH =
  process.env.PI_DESKTOP_SETTINGS ?? join(homedir(), ".pi-desktop", "settings.json");

const DEFAULTS: HostSettings = {
  adapter: "pi",
};

export class SettingsStore {
  #settings: HostSettings;

  constructor(private readonly path: string = SETTINGS_PATH) {
    this.#settings = { ...DEFAULTS };
    try {
      this.#settings = { ...DEFAULTS, ...JSON.parse(readFileSync(this.path, "utf8")) };
    } catch {
      /* first run */
    }
    if (process.env.PI_DESKTOP_ADAPTER) {
      this.#settings.adapter = process.env.PI_DESKTOP_ADAPTER;
    }
  }

  get all(): HostSettings {
    return { ...this.#settings };
  }

  get<K extends keyof HostSettings>(key: K): HostSettings[K] {
    return this.#settings[key];
  }

  set(key: string, value: unknown): void {
    (this.#settings as unknown as Record<string, unknown>)[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.#settings, null, 2));
  }
}
