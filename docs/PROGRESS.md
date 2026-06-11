# AIOS — Session Progress & Jumping-Off Point

Living record of two major features built in this thread. Everything below is
**implemented, typechecks, and builds clean**. Visual/UX tuning of the 3D view is
ongoing (it can only be judged on a running desktop). Use this as the starting
context for a new session.

Last commit at time of writing: `cfea24a` on `main`.

---

## Feature 1 — Android companion app + desktop "mobile gateway"

A React Native / Expo app (`mobile/`) that drives everything AIOS is connected to,
talking to the desktop over a new, security-scoped gateway.

### Desktop side
- **`electron/mobile-gateway.cjs`** — second Express server, bound `0.0.0.0` on a
  fixed port (default **8766**), **OFF by default**, every request bearer-token
  gated. Modeled on `electron/memory-ingest.cjs`. Exposes:
  - Curated read APIs: `/api/mobile/snippets`, `/threads`, `/agents`, `/skills`
  - Create/delete: snippets, agents, skills; markdown `/ingest`
  - **`/api/mobile/ocr`** — Gemini `gemini-2.5-flash` OCR (mirrors the desktop
    snipping vault; NOT the OpenAI `/api/vision` route)
  - **`/api/mobile/chat`** — auth-aware chat router: picks the correct upstream
    (`anthropic` vs `claude-agent`, `openai` vs `codex-agent`, etc.) based on the
    stored auth mode in the `meta` table; passes Grok persona (`mode`) + claude
    `variant`
  - **`/api/mobile/deep`** — Deep Research with `authMode` injected
  - **`/api/proxy/*`** — streaming reverse proxy to the loopback api-server
  - **Terminal bridge** — `/api/mobile/term/*` (SSE for output, POST for input);
    spawns a real shell on the desktop
- Wired in `electron/main.cjs` (boot start if enabled, IPC `mobile:get-config` /
  `set-config` / `regenerate-token`, `getWebContents` passed for renderer notify).
- Settings UI: **Settings → Hermes Gateway → "Mobile companion"** (in
  `src/tabs/HermesSettingsTab.tsx`) — enable toggle, port, URL, token, and a
  base64 **pairing code**.
- Snippet enrichment: mobile-created snippets are flagged `memoryPending +
  preAnalyzed + memorySource:'mobile'` and the gateway calls `notifyRenderer`
  (reuses the `memory:ingested` channel) so the desktop Second Brain reloads and
  embeds them. `src/lib/memory.ts` has a `preAnalyzed` fast-path (embed only, do
  not re-derive the Gemini OCR metadata).

### Mobile app (`mobile/`) — Expo SDK 52, RN 0.76.9
Screens: Pair, Second Brain (browse/search/detail), DeepDives (tabbed workspace +
selection context menu), Build (agents/skills create), Terminal (SSE), Capture
(screenshot/photo → OCR), Quick Action, More. Key files: `src/api/client.ts`
(gateway client, chat streaming, research), `src/store/auth.tsx` (pairing creds),
`src/components/ChatView.tsx` (chat + model dropdown + Grok personas + selection
menu), `src/components/SelectionMenu.tsx`, `DiveChatScreen.tsx` (tabbed threads).

### Build / run
- Desktop: `npm run electron:dev` from `app/` (restart to pick up gateway changes).
- Mobile: `cd mobile && npm run build:apk` (EAS cloud build → APK). EAS project is
  already linked (`@justinfoote22/aios-mobile`).

### Hard-won gotchas (do NOT re-introduce)
- **Cleartext HTTP**: release APKs block plain HTTP. Fixed via
  `expo-build-properties` → `android.usesCleartextTraffic: true`. The gateway is
  HTTP, so this is required.
- **`expo-share-intent` removed**: its native AppState listener crashed the app to
  a white screen on every background/resume (and a native crash bypasses the JS
  ErrorBoundary). System share-sheet auto-routing is gone; Quick Action works via
  paste. Re-add only with a more robust module.
- **Missing core deps**: `expo-asset` (Metro won't start without it) and
  `expo-file-system` (image-picker needs it for `AppDirectories`) must be present.
- **Version drift**: `expo-share-intent` had pulled SDK-53-era `expo-constants` →
  `@expo/config-plugins@10` (Gradle fails). `package.json` has `overrides` pinning
  `expo-constants@17.0.8` + `@expo/config-plugins@9.0.17`. (share-intent is gone
  now but keep the overrides harmless/correct.)
- **OCR provider**: mobile OCR must use **Gemini** (`/api/mobile/ocr`), not the
  OpenAI `/api/vision/analyze-snip` route (that uses the `openai` model slot, set
  to `gpt-5`, which 404s).
- **Chat auth**: route by the user's stored auth mode (subscription → `*-agent`
  CLI endpoints; api → key endpoints). Hardcoding the key endpoints 500s for
  subscription users.
- There is an `ErrorBoundary` around the app — keep it.

---

## Feature 2 — 3D Second Brain visualization

A Three.js volumetric brain behind a **2D ⇄ 3D toggle** in `src/tabs/SecondBrainTab.tsx`
(top-left of the graph). 2D view is untouched.

### Files
- **`src/components/BrainView3D.tsx`** — the whole 3D view.
- **`src/lib/brain3d.ts`** — placement math: `loadPointCloud` (+ rotation),
  `pcaBasis` / `projectWithBasis` (stable PCA), `makePointPicker` (incremental
  nearest-free interior point assignment).
- **`scripts/prep-brain-assets.cjs`** (`npm run prep:brain`) — converts
  `assets/brain_points/brainPoints.csv` → `public/brain/points.f32` (raw Float32)
  and copies the GLTF mesh + textures into `public/brain/`.
- Deps: `react-force-graph-3d@1.29.1`, `three@0.179`, `@types/three`.

### Assets (verified)
- **Mesh** `assets/brain_mesh/brainMesh` (GLTF): 137,898 verts, **watertight**
  (0 boundary edges after welding), bbox ±0.5, with PBR textures.
- **Points** `assets/brain_points/brainPoints.csv`: 100,000 interior points, clean,
  bbox ±0.5 — **same coordinate space as the mesh** (no Houdini 100× rescale
  needed). NOTE: earlier `.gltf`/`.ply` point exports were corrupt/empty — the
  **CSV is the source of truth**.
- `public/brain/` holds the runtime copies (`points.f32`, `brainMesh.gltf` + `.bin`
  + 3 PNGs).

### Behaviors
- **Placement**: PCA of each neuron's Gemini embedding → projected into the brain
  volume → **pinned (`fx/fy/fz`) to the nearest free interior scaffold point**.
  Basis computed **once** and cached; placement is **incremental** (existing
  neurons never move; only new ones get placed; cluster nodes land at the average
  of their connected neighbors → expand/collapse stays local). Fresh node objects
  each rebuild (reusing them orphaned the links).
- **Shell state machine** (button top-right): translucent (glass) → off → textured.
- **Cloud**: subsampled to ~10% (10k), faint, with a per-point proximity attribute
  so points **glow near neurons** and fade far away.
- **Pulses**: CUSTOM rig (small spheres animated along links), NOT the library's
  particles. Adaptive hub selection (top 15% by degree, fallback all) so they
  never vanish on cluster toggle.
- Post: UnrealBloom + ACES tone mapping + depth fog. OrbitControls with damping +
  slow auto-rotate (toggle button). Canvas sized to the panel via ResizeObserver.

### Current tuning constants (in `BrainView3D.tsx`)
- `BRAIN_ROT_X = +Math.PI/2` (stands the brain upright; applied to point DATA and
  the mesh object so they stay aligned)
- Neuron radius: `(0.0035 + min(cbrt(val),5)*0.0016) * (focused 1.7 | member 0.5 | 1)`
- Expanded-cluster members: **same look, half size** (the visual cue)
- Pulse: radius `0.002`, opacity `0.875`, color `0xcfeeff`, every 3.2s, life 1.3s
- Cloud: 10% subset, `uSize 5.5`, `uOpacity 0.5`, proximity radius `0.10`
- Bloom `UnrealBloomPass(.., 0.5, 0.35, 0.6)`, exposure `0.95`, fog `0.16`
- Drift amplitude `0.004` (slow)
- Camera framed at `z = 2.4`

### Hard-won gotchas (do NOT re-introduce)
- **Library particle radius is floored at 0.05**: `three-forcegraph` computes
  `photonR = Math.ceil(width*10)/10/2`, so any width < 0.1 → 0.05 (huge in a
  1-unit brain). That's why we use a **custom pulse rig**.
- **Scale**: the brain is ~1 unit (±0.5). Neuron radii live in `~0.003–0.012`.
  A radius of `1.6` (an early bug) is bigger than the whole brain.
- **Force-layout scale**: react-force-graph initializes nodes in a large default
  space and starts simulating before placement runs. Neurons must be **pinned**
  (`fx/fy/fz`) to the scaffold points or they float at the wrong scale.
- **Don't reuse node objects** across graph rebuilds — it orphans the links
  (connections vanish on cluster toggle). Create fresh objects, pin from a
  position cache keyed by id.
- **Recomputing PCA every rebuild reshuffles everything** — compute the basis once
  and cache it.
- Points + mesh are both ±0.5; the only transform needed is the +90° X rotation.

### Open / next
- Final visual polish on a running desktop (neuron size balance, pulse
  brightness/size, cloud density, shell tint, fog) toward "9–10".
- Optional: Git LFS or gitignore `public/brain/` (the 17 MB textures are duplicated
  between `assets/` and `public/brain/`, ~34 MB redundant).

---

## Feature 3 — 3D brain as the mobile landing page

The mobile app's Brain tab (the landing tab) now opens straight into the SAME
Three.js 3D Second Brain the desktop renders, with a "☰ List" toggle back to
the original browse/search list (mirrors the desktop's 2D ⇄ 3D switch).

### How it works
The 3D view cannot run natively in React Native (it's DOM Three.js +
react-force-graph-3d), so the desktop serves it as a web page and the phone
renders it in a WebView:

- **`brain-mobile.html` + `src/brain-mobile/main.tsx`** — a second Vite entry
  (see `vite.config.ts` `build.rollupOptions.input`) that reuses `BrainView3D`
  and `lib/graph` 1:1. It reads the bearer token from its URL query, fetches
  `/api/mobile/brain-graph`, runs the same `buildGraph` + collapsed-cluster +
  groupColors pipeline as `SecondBrainTab`, and posts neuron taps to the app
  via `window.ReactNativeWebView.postMessage`.
- **Gateway (`electron/mobile-gateway.cjs`)**:
  - Serves `dist/` at **`/brain3d/`** (index = `brain-mobile.html`) —
    intentionally **unauthenticated** (code + cosmetic mesh/texture/point
    assets only, no user data); relative `./brain/*` asset URLs resolve to
    `dist/brain/*`.
  - **`/api/mobile/brain-graph`** (token-gated): snippets WITH embeddings
    (images stripped), slim DeepDives (`msgCount` + `threadIds`, no message
    bodies), imports with per-conversation chunk-centroid embeddings, plus the
    saved `second-brain-physics` and `second-brain-expanded-docs` metas so the
    mobile graph's links match the desktop exactly.
- **Mobile**: `react-native-webview@13.12.5` (SDK-52 pinned);
  `src/components/Brain3DView.tsx` (WebView → `{url}/brain3d/?token=…`, error
  + retry via remount); `BrainScreen` defaults to immersive 3D
  (`headerShown:false` for the tab, safe-area-padded) and navigates natively on
  taps: snippet → SnippetDetail, deepdive → DiveChat.

### Gotchas
- **The mobile brain page is served from `dist/`** — after changing the 3D
  view or the page, run `npm run build` in `app/` or the phone keeps seeing the
  old page (or a 503 hint page if never built). `electron:dev`'s Vite server is
  localhost-only, so the phone can't use it.
- The page's own controls (rotate/shell) are top-RIGHT; the native "☰ List"
  overlay deliberately sits top-LEFT.
- The viewport meta pins page zoom (`user-scalable=no`) so pinch gestures go to
  OrbitControls, not the page.
