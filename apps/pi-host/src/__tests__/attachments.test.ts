import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HistoryItem } from "@pi-desktop/harness-sdk";

const attachmentDir = mkdtempSync(join(tmpdir(), "pi-desktop-attachments-"));
process.env.PI_DESKTOP_ATTACHMENTS = attachmentDir;

const attachments = await import("../attachments.js");

test("finds only managed attachment mentions in chat history", () => {
  const image = join(attachmentDir, "shot one.png");
  const other = join(tmpdir(), "not-managed.png");
  const items: HistoryItem[] = [
    { role: "user", text: `see @"${image}" and @plan` },
    { role: "assistant", text: `outside @"${other}"` },
    { role: "user", text: `legacy @file:"${image}"` },
  ];

  assert.deepEqual(attachments.managedAttachmentPaths(items), [image]);
});

test("deletes files inside the managed attachment directory only", () => {
  const keepDir = mkdtempSync(join(tmpdir(), "pi-desktop-keep-"));
  const managed = join(attachmentDir, "delete-me.png");
  const outside = join(keepDir, "keep-me.png");
  const nestedDir = join(attachmentDir, "not-a-file");
  mkdirSync(nestedDir);
  writeFileSync(managed, "managed");
  writeFileSync(outside, "outside");

  attachments.deleteManagedAttachments([managed, outside, nestedDir]);

  assert.equal(existsSync(managed), false);
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(nestedDir), true);
});
