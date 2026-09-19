# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AIOS is a unified local-first **Electron desktop app** (Electron + Vite + React 19 + TypeScript + Tailwind v4) that merges several AI tools into one tabbed window: DeepDives (multi-AI threaded chat), Snipping Vault (screenshot/OCR capture), Second Brain (2D/3D RAG graph over snippets + chats), a Kanban "Orchestra" board that runs Claude Code agents on cards, a built-in terminal, and a Hermes cron/gateway integration. An Android companion app (`mobile/`) drives the desktop over an opt-in LAN gateway.

The README and `docs/PROGRESS.md` describe earlier phases and are partly stale (the app has grown well past the "Phase 2" framing); trust the code. `docs/PROGRESS.md` is still the best narrative for the **3D brain** and **mobile gateway** internals and their hard-won gotchas.

## Commands

```powershell
npm install              # postinstall auto-runs electron-rebuild for native modules
npm run electron:dev     # MAIN dev command: Vite on :3000 + Electron pointed at it
npm run dev              # Vite renderer only (port 3000)
npm run lint             # tsc --noEmit — the ONLY typecheck/lint; there is no eslint
npm run build            # vite build → dist/ (also builds the brain-mobile entry)
npm run dist             # vite build + electron-builder for the current OS → release/
npm run rebuild:native   # rebuild better-sqlite3 + node-pty against Electron's ABI
npm run prep:brain       # regenerate public/brain/* assets from assets/brain_*
```

Use `npm run check` for desktop typechecking, Electron CJS syntax validation, security/mobile-migration tests, native SQLite tests, and a production build. Then run `npm run test:electron` for real Chromium/IPC/gateway tests (Linux CI needs `xvfb-run -a`). Mobile: `npm ci --ignore-scripts` and `npm run lint` in `mobile/`. All automated fixtures use temporary data, not the user's vault. See `docs/SHIP-STATUS.md` for verified scope and release blockers.

Hot reload covers the renderer (`src/`). Changes to `electron/*.cjs` require **restarting** `electron:dev`.

After pulling changes that touch dependencies, re-run `npm install` (native modules are recompiled by the `postinstall` hook). `.npmrc` sets `legacy-peer-deps=true` — keep it.

## Architecture

Three cooperating layers, all on one machine:

1. **Electron main** (`electron/main.cjs`) — window/tray/global-hotkey lifecycle, the screenshot overlay window, all `ipcMain` handlers, and boot of the SQLite store + the local servers. The window hides to tray instead of quitting. Several Chromium `disable-*-backgrounding` switches are set deliberately so a minimized window doesn't stall in-flight OCR — don't remove them.

2. **Renderer** (`src/`) — React 19 SPA. `src/App.tsx` keeps **all tabs mounted** (hidden, not unmounted) so in-progress state survives navigation. `src/components/Sidebar.tsx` defines the `TabId` union and routing.

3. **Local Express API server** (`electron/api-server.cjs`) — bound to `127.0.0.1` on a **random port**, started in `main.cjs`, port handed to the renderer via `additionalArguments` → `getApiPort` IPC → `src/lib/apiBase.ts` (`apiUrl()` builds absolute URLs). This server emulates the old DeepDive Next.js API routes and is where **all AI provider calls happen** (keys never live in the renderer). ~2300 lines, ~45 routes.

### AI provider routing (the central pattern)

Every AI feature dispatches on **(provider, auth mode)**:

- **Auth mode** is per-provider, persisted in the SQLite `meta` table via `src/lib/authMode.ts` (`'api'` vs `'subscription'`). `'api'` = use a stored API key; `'subscription'` = drive the locally-installed CLI / Agent SDK (Claude Code login, Gemini CLI, etc.). Gemini defaults to `subscription`. The renderer reads its auth mode and sends `authMode` in the request body; the server branches on it.
  - Anthropic `api` → `@ai-sdk/anthropic` with the stored key. `subscription` → `@anthropic-ai/claude-agent-sdk` `query()` against the logged-in Claude Code CLI (routes ending `-agent`, e.g. `/api/claude-agent/chat`). Same split exists for OpenAI/Codex, Grok, Gemini.
- **Model IDs** are slot-based, stored unencrypted in `%APPDATA%/AIOS/provider-models.json` via `electron/modelstore.cjs`. Slots: `openai`, `claude` (Anthropic opus/variant=opus), `anthropic` (Anthropic sonnet/variant=sonnet), `grok`, `gemini`, `hermes`. Retired model IDs are auto-upgraded on read (`RETIRED` map). Edit defaults there, not scattered in routes.
- **API keys** are encrypted with Electron `safeStorage` (DPAPI on Windows) at `%APPDATA%/AIOS/provider-keys.json` via `electron/keystore.cjs`, shared by main IPC and the API server. `src/lib/providers.ts` is the renderer-side registry + "which providers are configured" cache.
- Chat streaming uses the **Vercel AI data-stream protocol**. SDK routes use `result.pipeDataStreamToResponse`; the hand-rolled agent routes emit it manually (`0:` text delta, `d:` finish, `3:` error — see `streamPart`).

When adding a provider/feature, follow an existing route in `api-server.cjs`: pull the key/model from the stores, branch on `authMode`, stream back in the AI data-stream format.

### Data layer

- **SQLite** via `better-sqlite3` in main (`electron/sqlite-store.cjs`), reached from the renderer over a single whitelisted IPC op bridge (`ipcMain.handle('aios:db', op, args)` → `window.aios.db.call`). `src/lib/db.ts` is the **only** renderer module that talks to the store; everything imports from it. Tables: `snippets, meta, threads, messages, imports, import_chunks, agents, skills, runs`. The `meta` table is the catch-all key/value store for prefs, auth modes, board state, Maestro config, etc.
- There was a one-time IndexedDB→SQLite migration (`src/lib/db.ts` `ensureMigrated` + `src/lib/idb-legacy.ts`); SQLite is now the source of truth.
- Per-feature stores wrap `db.ts`: `snippetStore.ts`, `deepdiveStore.ts`, `agents.ts`, `skills.ts`, `runs.ts`, `kanban.ts`, `memory.ts`, `imports.ts`. Full export/import of the whole brain to JSON is in `main.cjs` (`brain:export`/`brain:import` → `sqliteStore.dumpAll`/`bulkLoad`).

### Kanban "Orchestra" + Maestro (agent orchestration)

- Cards live on a board (`src/lib/kanban.ts`); each **agent** (`src/lib/agents.ts`) is a Claude Code subagent definition that also gets written to `<workingDir>/.claude/agents/<slug>.md` (and skills to `.claude/skills/<slug>/SKILL.md`) so the same agents work from the bare `claude` CLI.
- "Play" a card → `POST /api/agents/run` uses `electron/agent-policy.cjs`: explicit tool inventory, no automatic installed skills/settings, per-invocation desktop approval, and per-run credentials. Chat/drafting uses no tools. Never restore permission bypasses or mutate `process.env` for a run. Output streams back and is saved as a **run** (`src/lib/runs.ts`).
- **Maestro** (`src/lib/maestro.ts`) is an autonomous conductor: `tick()` is a pure state machine that scans the board and emits actions (promote/assign/start/review); LLM calls (worker selection heuristic `chooseWorkerForCard`, review via `/api/agents/review`) are separate. Maestro itself is stored as a `role:'maestro'` agent and excluded from worker pools.

### Other servers (opt-in, off by default)

- `electron/memory-ingest.cjs` — LAN webhook that POSTs markdown into Second Brain.
- `electron/mobile-gateway.cjs` — second Express server bound `0.0.0.0` (default port 8766), bearer-token gated, for the Android app; also serves the standalone 3D brain page (`brain-mobile.html`, a second Vite entry) at `/brain3d/`. See `docs/PROGRESS.md` for the full route list and gotchas. Both are configured under Settings and toggled via IPC in `main.cjs`.

### Renderer conventions

- Path alias `@/` → `src/` (configured in both `vite.config.ts` and `tsconfig.json`).
- Shared primitives live in `src/ui/` (Button, Card, Dialog, Table, etc.); import via `src/ui/index.ts`. Tailwind v4 (no config file — `@tailwindcss/vite` plugin + `src/index.css`).
- Tabs are in `src/tabs/`; the dashboard/home is `src/features/dashboard/`. Every tab is wrapped in `ErrorBoundary` — keep it (a crashing tab must not take down the window).
- Electron bridge surface is typed in `src/electron.d.ts` (`window.aios.*`). When adding an IPC handler in `main.cjs`, add it to `preload.cjs` and to this type.
- `src/lib/navigate.ts` is the cross-tab navigation bus; snippets/threads cross-link via `originThreadId`.

## Native modules & packaging

- `better-sqlite3` and `node-pty` are native and **compiled per-OS against Electron's ABI**. They can't be cross-compiled — CI uses one runner per platform (`.github/workflows/release.yml`). `postinstall`/`rebuild:native` run `electron-rebuild`. They're `asarUnpack`ed in the electron-builder config.
- Releases: bump `version` in `package.json`, tag `vX.Y.Z`, push — the Release workflow builds Win/macOS/Linux installers as a draft GitHub Release. v1 ships **unsigned** (see `RELEASING.md`).

## Key runtime paths

- App data root: `%APPDATA%/AIOS/`
- Encrypted provider keys: `%APPDATA%/AIOS/provider-keys.json`
- Model-ID slots: `%APPDATA%/AIOS/provider-models.json`
- SQLite DB: `%APPDATA%/AIOS/aios.db`

## Cross-platform development (Windows primary, Linux secondary)

AIOS is **Windows-first**. It is also developed on an Omarchy (Arch + Hyprland)
laptop, and the two machines share one repo. Releases are unaffected by which
machine you work on: tagging `vX.Y.Z` makes CI build Windows, macOS (arm64) and
Linux on their own runners.

Runtime paths differ by OS. On Linux, `%APPDATA%/AIOS/` in the section above is
`~/.config/AIOS/` — so `provider-keys.json`, `provider-models.json` and
`aios.db` all live there instead.

**Neither keys nor data travel between machines.** `safeStorage` uses DPAPI on
Windows and libsecret on Linux, and both are machine-bound, so API keys must be
re-entered per machine. The SQLite brain is local too — move it with the Second
Brain tab's Export/Import buttons (`brain:export` / `brain:import` in
`main.cjs`, which dumps all 9 tables).

### Linux/Wayland status — deferred work, not regressions

Snipping Vault does not work on Hyprland out of the box. This is a known,
deliberate gap with a planned fix, **not** something to patch ad hoc. Split the
symptoms into two groups before touching anything:

**Group 1 — environment setup. No code change; these genuinely make the feature
work.** Omarchy likely ships most of it already; verify before installing.

| Symptom | Fix |
|---|---|
| No tray icon (`createTray`) | Enable Waybar's `tray` module, or any StatusNotifierItem host. Electron's `Tray` then behaves as on Windows. Until then `window-all-closed` is a deliberate no-op, so closing the window strands a headless process — quit from the app menu. |
| Credential storage unavailable (`electron/keystore.cjs`) | Install and unlock a Secret Service provider — `gnome-keyring` or KeePassXC. AIOS now rejects Electron's insecure `basic_text` fallback, even when `isEncryptionAvailable()` returns `true`. |
| Screen capture asks permission (`overlay:get-source`) | `xdg-desktop-portal-hyprland` + `pipewire` are required for `desktopCapturer` to function at all. **Necessary but probably not sufficient** — the code reads `match.thumbnail.toDataURL()`, and on Wayland a populated thumbnail needs per-stream portal consent, so expect it to come back empty. Untested; if it does work, the only cost is a consent dialog per snip. |

**Group 2 — needs the capture port. Code required.**

| Symptom | Why no environment fix exists |
|---|---|
| `Ctrl+Shift+S` does nothing (`globalShortcut.register`) | Wayland compositors own key grabs; Chromium cannot register global shortcuts from inside the app. |
| Overlay opens on the wrong display (`triggerCapture`) | `screen.getCursorScreenPoint()` is unreliable and Wayland clients cannot set their own window position. |

**The planned port** (do this deliberately, as its own change — not as a
drive-by while debugging something else):

1. Add a Linux branch to `triggerCapture` that shells out to `slurp | grim -g - -`
   and returns a PNG on stdout as a data URL, feeding the existing analysis path.
   This replaces the transparent overlay window entirely on Linux — Hyprland
   supplies the region-selection UI, so it is *less* code than the Windows path,
   and it sidesteps both Group 2 rows plus the portal problem above.
2. Expose a capture trigger route on the local Express server and bind
   `Ctrl+Shift+S` in `hyprland.conf` to hit it. The server binds a random port, so
   write the port somewhere the bind can read it.

Keep the Windows path untouched — it works and is the one most users run.

Everything outside Snipping Vault — DeepDives, Second Brain, Kanban/Orchestra,
terminal, mobile gateway — works on Linux today. The terminal is *better*: Linux
`node-pty` uses `forkpty` and sidesteps the ConPTY problems documented in
`electron/terminal.cjs`.

### Line endings

`.gitattributes` pins the repo to `eol=lf`. Do not commit CRLF; `core.autocrlf`
on Windows is overridden by it deliberately, so both machines see identical bytes.
