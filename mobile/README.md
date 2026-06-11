# AIOS Mobile (Android companion)

A React Native / Expo app that taps into everything your AIOS desktop is connected to:

- **Second Brain** — lands on the desktop's **3D brain visualization** (Three.js, streamed from the gateway into a WebView; tap a neuron to open it natively), with a "☰ List" toggle to browse & search neurons and open detail with image + OCR text. Requires a built desktop app (`npm run build` in `app/`) so the gateway can serve the page from `dist/`
- **DeepDives** — browse/continue saved threads or start a new chat (Claude / GPT / Grok), streamed live. **Long-press any AI response** for the full context menu (Ask, Get more details, Examples, Simplify, Get links, Get videos, Deep Dive (autonomous research), Save to Brain) — branching actions open as **tabs** across the top so you can keep multiple threads in one screen
- **Build** — list, create, and delete Agents & Skills, with AI-assisted drafting
- **Terminal** — open a real, live shell **on your desktop** (SSE-streamed), optional start folder, with Ctrl-C / Tab / arrows — run git, npm, claude, anything
- **Capture → OCR** — pick a screenshot or take a photo; the desktop runs the same vision/OCR pipeline and you save the result as a neuron
- **Quick Action** — paste or pass in any text → Summarize / Explain / Key points / Action items / Deep dive / Save to Brain (reachable from More → Quick Action, or "Ask AIOS about this" on a neuron)

All AI work runs on the **desktop** (it holds the API keys / subscriptions). The phone is a thin, secure client.

## Architecture

```
 Android app  ──HTTPS+Bearer──►  AIOS desktop "mobile-gateway" (0.0.0.0:8766)
                                   ├─ /api/mobile/*   curated read/write (SQLite)
                                   ├─ /api/proxy/*    → loopback api-server (chat, vision, drafting)
                                   └─ /api/mobile/term/*  SSE + POST terminal bridge (node-pty)
```

The gateway is **off by default** and every request carries a bearer token. See
`electron/mobile-gateway.cjs` on the desktop side.

## 1. Enable the gateway on the desktop

1. Open AIOS → **Settings → Hermes Gateway → Mobile companion**.
2. Toggle it **Enabled**.
3. Copy the **Pairing code** (it bundles the URL + token).

> Away from home? Install [Tailscale](https://tailscale.com) on both the desktop
> and phone; the pairing URL will use the desktop's tailnet IP and work anywhere.

## 2. Run the app

```bash
cd mobile
npm install

# Because this app uses native modules (share-intent, image-picker), it needs a
# Dev Client or a real build — it does NOT run in plain Expo Go.

# Option A — build a shareable APK in the cloud (no Android SDK needed locally):
npx eas-cli login
npm run build:apk          # eas build -p android --profile preview
# download + install the APK on your phone

# Option B — local dev with a custom dev client:
npx expo prebuild -p android
npx expo run:android       # requires Android Studio / SDK + a device or emulator
```

## 3. Pair

Launch AIOS on the phone → **Paste the pairing code** (or use **Manual** to enter
the URL + token separately) → **Connect**. The token is verified before it's saved.

## Notes & limits

- The terminal uses a lightweight ANSI stripper, not a full xterm emulator — great
  for shells, git, builds, and running `claude`/`codex`; rich TUIs will look rough.
- Continuing a DeepDive streams a fresh reply but does not yet write back to the
  desktop's saved thread (read + ephemeral continue). New chats are ephemeral.
- System share-sheet integration was removed (the `expo-share-intent` native
  module crashed the app on every background/resume). Quick Action is in-app
  (paste text). A share target can be re-added later with a more robust approach.
- `npm run lint` runs `tsc --noEmit`.

## Project layout

```
App.tsx                     navigation + share-intent + auth gate
src/api/client.ts           gateway HTTP client, chat streaming, terminal helpers
src/store/auth.tsx          credential storage + pairing
src/components/              ui kit, ChatView, TabIcon
src/screens/                Pair, Brain, SnippetDetail, Dives, DiveChat,
                            Build, NewAgent, NewSkill, Terminal, Capture,
                            QuickAction, More
```
