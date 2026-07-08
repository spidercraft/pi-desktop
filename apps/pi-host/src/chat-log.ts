/**
 * Host-owned neutral transcript log (§7.1): one JSON file per chat, built from
 * neutral HarnessEvents. Because it never contains harness-native shapes, a
 * chat's transcript survives switching adapters — sessions are shareable
 * between harnesses.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HistoryItem } from "@pi-desktop/harness-sdk";

const LOG_DIR = process.env.PI_DESKTOP_CHATLOGS ?? join(homedir(), ".pi-desktop", "chats");

/** Best-effort plain text from a neutral tool result. */
export function toolResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ text?: string }>; output?: string };
  if (Array.isArray(r.content)) return r.content.map((c) => c?.text ?? "").join("\n");
  if (typeof r.output === "string") return r.output;
  try {
    return JSON.stringify(result).slice(0, 20_000);
  } catch {
    return String(result);
  }
}

export class ChatLog {
  #items: HistoryItem[] = [];

  constructor(private readonly chatId: string) {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (Array.isArray(parsed)) this.#items = parsed as HistoryItem[];
    } catch {
      /* new chat */
    }
  }

  private get file(): string {
    return join(LOG_DIR, `${this.chatId}.json`);
  }

  get items(): HistoryItem[] {
    return [...this.#items];
  }

  /** Append an entry; returns its index (for later update()). */
  append(item: HistoryItem): number {
    this.#items.push(item);
    this.#save();
    return this.#items.length - 1;
  }

  update(index: number, patch: Partial<HistoryItem>): void {
    const existing = this.#items[index];
    if (!existing) return;
    this.#items[index] = { ...existing, ...patch };
    this.#save();
  }

  /** Drop everything from the `n`-th user message onward (0-based), keeping the
   *  first `n` user messages and their replies. Used when a message is edited. */
  truncateToUserMessage(n: number): void {
    let userCount = 0;
    let cut = this.#items.length;
    for (let i = 0; i < this.#items.length; i++) {
      if (this.#items[i].role === "user") {
        if (userCount === n) {
          cut = i;
          break;
        }
        userCount++;
      }
    }
    if (cut < this.#items.length) {
      this.#items = this.#items.slice(0, cut);
      this.#save();
    }
  }

  delete(): void {
    rmSync(this.file, { force: true });
    this.#items = [];
  }

  #save(): void {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.#items));
    } catch (err) {
      console.error("[pi-host] chat log write failed:", (err as Error).message);
    }
  }
}
