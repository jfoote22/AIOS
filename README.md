# AIOS

Unified local desktop app merging **DeepDive** (multi-AI research) and **Snipping Vault** (screenshot/text capture + AI analysis). Electron + Vite + React 19 + TypeScript + Tailwind v4.

## Status

**Phase 2 (current)** — DeepDives ported, cross-link to Vault wired up.

| Tab            | Status   | Notes |
|----------------|----------|-------|
| DeepDives      | Done     | Full ThreadedChat ported from Next.js → Vite. Resizable panels, multi-row threads, contextual right-click (Get more details / Simplify / Examples / Links / Videos / Ask / **Save to Vault**), learning snippets. Save/Load to local SQLite, no Firebase, no auth. AI replies powered by local Express server inside Electron, pulling keys from safeStorage |
| Snipping       | Done     | Full Snipping Vault: tray, global hotkey (Ctrl+Shift+S), screenshot overlay, Gemini analysis, vault grid, Ask-the-Vault chat, tags, chunks, semantic search. Snippets created from DeepDive carry `originThreadId` cross-link |
| Second Brain   | Stub     | Unified RAG over snippets + threads — Phase 3 |
| Hermes         | Stub     | TBD |
| Models         | Done     | Add/clear credentials per provider; safeStorage-encrypted |
| Subscriptions  | Stub     | Phase 3 |

## Architecture

- **Electron main** (`electron/main.cjs`) — tray, global hotkey, screenshot overlay window, capture IPC, multi-provider key vault (Electron `safeStorage` → DPAPI on Windows, file at `%APPDATA%/AIOS/provider-keys.json`).
- **Keystore** (`electron/keystore.cjs`) — shared encrypted key reader/writer used by both main IPC handlers and the API server.
- **API server** (`electron/api-server.cjs`) — local Express server bound to `127.0.0.1` on a random port. Emulates DeepDive's `/api/openai/chat`, `/api/anthropic/chat`, `/api/grok/chat`, `/api/deepgram` endpoints using the Vercel `ai` SDK. Pulls API keys from the encrypted store per-request — keys never live in renderer memory longer than needed.
- **Overlay window** (`electron/overlay.html` + `overlay.js`) — transparent always-on-top BrowserWindow that captures the current display via `desktopCapturer`, marquee-select, returns cropped PNG data URL to renderer.
- **Renderer** (`src/`) — React 19 with a collapsible left sidebar (`Sidebar.tsx`) that routes between tabs. Each tab is self-contained.
- **Data** — IndexedDB (`src/lib/db.ts`) holds snippets, DeepDive sessions (the `threads` store), chat history. Phase 3 will migrate to SQLite via `better-sqlite3` for FTS5 search.
- **AI providers** — Gemini for snippet analysis/embeddings; OpenAI / Anthropic / Grok for DeepDive chat via the local API server. Keys configured per-provider in the Models tab. Adding a key automatically activates that model in the relevant tab.

## Setup

```powershell
cd C:\Users\rawfo\Curser\AIOS\app
npm install
npm run electron:dev
```

This starts the Vite dev server on port 3000 and launches Electron pointing at it. Hot reload works for the renderer; restart for changes to `electron/*.cjs`.

## Key paths

- App data: `%APPDATA%/AIOS/`
- Provider keys (encrypted): `%APPDATA%/AIOS/provider-keys.json`
- IndexedDB: in-renderer (`aios` database, see DevTools → Application)

## Cross-links between tabs

Snippets carry an optional `originThreadId`. When DeepDive lands in Phase 2, right-clicking selected text in a DeepDive response and choosing "Save as snippet" will create a snippet with `originThreadId` set, and the snippet detail view (already in `SnippingTab.tsx`) will display "from thread …" with a click-back link.

## Roadmap

- **Phase 3**: SQLite migration with FTS5, Second Brain unified RAG over snippets + threads, Hermes integration, AI subscriptions dashboard, the `/api/grok/analyze-learning` + `/api/openai/transcribe` + `/api/replicate/*` endpoints for full "Generate Learning Tools" parity, optional encrypted Firebase backup/sync.

## After updating

Phase 2 added new deps (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `express`, `replicate`). Re-run:

```powershell
cd C:\Users\rawfo\Curser\AIOS\app
npm install
npm run electron:dev
```
