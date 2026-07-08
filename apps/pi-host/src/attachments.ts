import { lstatSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { HistoryItem } from "@pi-desktop/harness-sdk";

export const ATTACHMENTS_DIR = process.env.PI_DESKTOP_ATTACHMENTS ??
  join(homedir(), ".pi-desktop", "attachments");

const MENTION_PATH_RE = /@file:"((?:\\.|[^"])*)"|@"((?:\\.|[^"])*)"|@(\S+)/g;

function unescapeQuotedPath(path: string): string {
  return path.replace(/\\(["\\])/g, "$1");
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function mentionedPaths(text: string): string[] {
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = MENTION_PATH_RE.exec(text))) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path) paths.push(match[3] ? path : unescapeQuotedPath(path));
  }
  return paths;
}

export function historyMentionedPaths(items: HistoryItem[]): string[] {
  return items.flatMap((item) => mentionedPaths(item.text ?? ""));
}

export function isManagedAttachmentPath(path: string): boolean {
  return isAbsolute(path) && isInside(ATTACHMENTS_DIR, path);
}

export function managedAttachmentPaths(items: HistoryItem[]): string[] {
  return [...new Set(historyMentionedPaths(items).filter(isManagedAttachmentPath))];
}

export function deleteManagedAttachments(paths: Iterable<string>): void {
  for (const path of paths) {
    if (!isManagedAttachmentPath(path)) continue;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      rmSync(path, { force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error("[pi-host] failed to delete attachment:", (err as Error).message);
      }
    }
  }
}
