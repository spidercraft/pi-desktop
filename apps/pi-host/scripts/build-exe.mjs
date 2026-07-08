#!/usr/bin/env node
/**
 * Compiles pi-host into a single self-contained native binary with Bun, named
 * per Tauri's `externalBin` sidecar convention (`<name>-<target-triple>[.exe]`)
 * and dropped into apps/shell/src-tauri/binaries/ so `cargo tauri build` picks
 * it up and bundles it into the installer.
 *
 * Why this exists: the shell used to spawn pi-host with `node dist/server.js`,
 * which silently fails on any machine without Node on PATH (i.e. every real
 * install via the MSI). Compiling to a standalone binary removes that
 * dependency entirely.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");

const TRIPLES = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

const key = `${process.platform}-${process.arch}`;
const triple = TRIPLES[key];
if (!triple) {
  console.error(`[build-exe] unsupported platform/arch: ${key}`);
  process.exit(1);
}

const ext = process.platform === "win32" ? ".exe" : "";
const outDir = join(pkgRoot, "..", "shell", "src-tauri", "binaries");
const outfile = join(outDir, `pi-host-${triple}${ext}`);
const entry = join(pkgRoot, "src", "server.ts");

mkdirSync(outDir, { recursive: true });

console.log(`[build-exe] compiling ${entry}`);
console.log(`[build-exe]        -> ${outfile}`);

try {
  execFileSync("bun", ["build", entry, "--compile", "--outfile", outfile], {
    stdio: "inherit",
  });
} catch (err) {
  console.error("[build-exe] bun build failed. Is Bun installed? See https://bun.sh");
  process.exit(err.status ?? 1);
}
