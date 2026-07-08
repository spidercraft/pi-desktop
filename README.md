# Pi Desktop

Cross-platform desktop app wrapping the [pi agent harness](https://github.com/earendil-works/pi) behind a swappable `HarnessAdapter` boundary. See `../PI_DESKTOP_PLAN.md` for the architecture; §1's rule is enforced here: **the only pi-aware code is `apps/pi-host/src/adapters/pi/`**.

## Layout

- `packages/harness-sdk` — neutral `HarnessAdapter` interface, types, conformance suite, mock adapter
- `packages/protocol` — shell/UI ↔ host wire protocol (WebSocket, JSON)
- `packages/ui-kit` — design tokens
- `apps/pi-host` — Node sidecar: host core (session registry, mode engine, permission policy) + `adapters/pi`
- `apps/ui` — React frontend (imports `@pi-desktop/protocol` only)
- `apps/shell` — Tauri shell (window + sidecar supervision, no business logic)

## Build (debug)

Requires Node ≥ 22.19.

```sh
npm install
npm run build     # TypeScript packages + host + UI (unminified, sourcemaps)
npm test          # conformance suite: mock adapter + pi adapter
```

### Run without the shell (dev)

```sh
npm run dev:host                   # starts pi-host on ws://127.0.0.1:43117
npm run dev:ui                     # Vite dev server on http://localhost:5173
```

`PI_DESKTOP_ADAPTER=mock npm run dev:host` runs against the echo mock adapter (no API keys needed).

### Tauri shell (debug, i.e. NOT --release)

Requires Rust (rustup) — on Windows also VS Build Tools + WebView2 runtime; on Linux `webkit2gtk-4.1` dev packages.

```sh
npm run shell:debug                # = cargo build (debug profile) in apps/shell/src-tauri
# or with the Tauri CLI for a windowed dev loop:
cd apps/shell/src-tauri
cargo install tauri-cli --version "^2"
cargo tauri dev                    # uses devUrl http://localhost:5173 (start dev:host + dev:ui first)
```

The debug binary lands in `apps/shell/src-tauri/target/debug/`. The shell looks for the sidecar at `apps/pi-host/dist/server.js` (override with `PI_HOST_ENTRY`; node binary with `PI_HOST_NODE`).

## Configuration

- Host settings: `~/.pi-desktop/settings.json` (`adapter`, `searxngUrl`)
- MCP servers: `~/.pi-desktop/mcp-servers.json` (managed from the MCP tab; stdio `{command,args,env}` or HTTP/SSE `{url,headers}`). Tools from newly added servers apply to workspaces opened afterwards.
- Providers/API keys: stored by the active adapter (pi: `~/.pi/agent/auth.json` via `AuthStorage`)
- Deepsearch: point Settings → SearXNG URL at an instance with `search.formats: [json]` enabled
- Theme: presets + custom colors under Settings → Appearance (persisted in the webview's localStorage)

## Feature notes

- **MCP bridge** is implemented in the host core (`apps/pi-host/src/mcp-service.ts`) over the neutral `registerTool()` capability, so it works with any adapter that supports custom tools.
- **Session resume**: the open-workspace dialog lists resumable sessions for the chosen directory (`open_session` command → `SessionConfig.resumeSession`).
- **Permissions**: per-workspace policy control in the mode bar (Ask / Full auto / Read-only / Custom rules with tool + path-prefix matching).
- **Chat**: markdown rendering (marked + DOMPurify), inline diffs for edit/write tools, model switcher, compact button.
- **Native directory picker** via `tauri-plugin-dialog` (feature-detected; falls back to manual entry + recents in a plain browser).

## Swapping the harness

Implement `HarnessAdapter` under `apps/pi-host/src/adapters/<name>/`, add a case in `src/adapter-registry.ts`, run it against `@pi-desktop/harness-sdk/conformance`, and set `adapter` in `~/.pi-desktop/settings.json` (or `PI_DESKTOP_ADAPTER`). No UI/shell/protocol changes.
