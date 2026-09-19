# AIOS shipping assessment

Assessment date: 2026-09-18. Repository baseline: `ac2edab`; package version `1.4.0`. This is a code assessment and limited local verification, not a penetration test or a certification of shipped binaries.

Read [the product and architecture plan](SHIP-PLAN.md), [the executable backlog](SHIP-BACKLOG.md), and [the launch plan](SHIP-LAUNCH.md) alongside this assessment.

## Overall judgment

AIOS is a substantial personal desktop application with reusable product assets. It is not yet a secure, independently usable, multi-device product. The remaining work is primarily in data ownership, trust boundaries, background execution, onboarding, and distribution. These are architectural changes, not a final layer of UI polish.

Keep the existing visual identity, Second Brain, snippet editor, DeepDive conversations, Orchestra board, and terminal presentation. Introduce service boundaries behind them incrementally. Avoid a wholesale framework rewrite.

The code is materially ahead of `README.md`: SQLite, Hermes, the brain graph, the mobile gateway, and orchestration already exist. Conversely, some comments overstate protection: not all AI calls stay outside the renderer, the mobile gateway uses HTTP rather than HTTPS, and an empty Claude `allowedTools` list is not a tool sandbox.

## What exists and what is missing

| Area | Evidence in the repository | Shipping assessment |
|---|---|---|
| Desktop shell | Electron, tray, global capture shortcut, reusable UI primitives | Keep; harden permissions and OS behavior |
| Brain presentation | 2D/3D graph, clustering, embeddings, neuron editor | Strong visual foundation; add scale and accessibility gates |
| Screenshot capture | Region selection, OCR/enrichment, tags, entities, subimages | Real implementation; depends on cloud Gemini for the principal path |
| Video/audio | External transcript uploader and a transcription TODO | No complete built-in video ingestion, transcription, or frame OCR pipeline found |
| Persistence | Nine SQLite tables, IPC facade, migration from IndexedDB | Real local storage; database content is not encrypted |
| Portability | Full JSON dump and merge import | Valuable starting point; needs validation, migration, attachment integrity, and safe restore |
| Mobile | Expo/React Native companion, pairing, capture, graph WebView, remote chat/terminal | Desktop-dependent client; lacks a local vault and durable offline queue |
| Mobile share capture | README records removal of crashing share integration | Needs native iOS share extension and Android receive handling |
| Agents | Claude SDK runs; Codex SDK chat; Hermes chat/cron; Grok and Google CLI paths | Connections exist, but capabilities and authentication are not interchangeable |
| Orchestration | Kanban, deterministic Maestro tick, parallel runs, transcript review | Mostly renderer-managed, Claude-specific, without durable distributed scheduling |
| Web/cloud | Standalone mobile brain page served by Electron | Full app still requires Electron's database bridge; no independent cloud service found |
| Distribution | Three desktop OS build jobs, Android EAS profiles | Desktop installers unsigned; no complete updater or shipping test matrix found |

## Verification performed

| Check | Result and limits |
|---|---|
| `npm.cmd run lint` | Passed. This is TypeScript checking, not a full linter. `tsconfig.json` includes `src` and Vite configuration, not Electron CJS or the mobile project |
| Production Vite build | Passed in a new temporary directory. The sandbox initially blocked configuration resolution; approved execution outside it succeeded |
| Existing SQLite store test | Passed under Electron's Node runtime using a temporary database. Covers CRUD, sort order, embeddings, uniqueness, and bulk loading |
| `npm.cmd audit --omit=dev --json` | Reported 21 affected production package entries: 8 high, 6 moderate, 7 low, 0 critical. Registry access required approved execution outside the sandbox |
| Static review | Storage, capture, extraction, research, IPC, network gateways, provider integrations, orchestration, mobile persistence, and release configuration inspected |
| Not verified | Interactive UI, actual provider logins or paid calls, mobile compilation, iOS/Android devices, Linux/macOS capture, full installer execution, updater behavior, penetration testing, and encryption/sync behavior that has not yet been implemented |

The mobile dependency directory was absent. No mobile build was claimed. No personal AIOS data, provider credentials, or live agent sessions were inspected or used. Application source and installed dependencies were not changed for this assessment.

Build observations: the main JavaScript chunk was approximately 4.69 MB minified / 1.23 MB gzip; the 3D brain chunk approximately 1.86 MB / 0.49 MB gzip; the TypeScript editor worker approximately 6.02 MB. These are asset sizes, not measured startup time or resident memory. An existing `1.3.1` Windows installer is about 353 MB; it is not evidence that the assessed `1.4.0` builds into the same size or works on a clean machine.

## Findings ordered by release impact

### F01 — P0: privileged local API lacks an authentication boundary

`electron/api-server.cjs:11`, `:429`, and `:2276` configure wildcard CORS and a random loopback listener without an application authentication middleware. The same service exposes agent execution, project and agent file operations, research file extraction, configuration writes, and a Deepgram key-returning endpoint (`:2030`). A random port is discovery friction, not access control.

Any process able to reach the port can access these handlers. Browser-based access depends on browser local-network controls and request context; no browser exploit was reproduced. Production requirements must not rely on those browser protections.

Required: authenticated local transport, strict Host/Origin handling for HTTP, request schemas, sender/frame validation for IPC, capability checks for each privileged operation, and removal of long-lived secret-returning APIs. Backlog: B02, B03.

### F02 — P0: mobile authorization grants excessive host authority

`electron/mobile-gateway.cjs:94` accepts the long-lived shared bearer token in query strings. `:319` forwards every `/api/proxy/*` request to the privileged local API. `:693` exposes terminal spawning. `:756` binds an HTTP listener to `0.0.0.0`. `electron/memory-ingest.cjs:171` similarly binds HTTP for ingestion. These listeners are opt-in, which reduces default exposure but does not constrain a paired device.

`mobile/src/store/auth.tsx` persists the token in AsyncStorage; `mobile/src/components/Brain3DView.tsx` places it in the WebView URL. `mobile/app.json` permits cleartext Android traffic. A compromised paired device can exercise much more authority than saving a screenshot requires.

Required: separate sync, capture, chat, execution, and terminal permissions; device-specific credentials; authenticated pairing; TLS; per-device revocation; and no blanket API proxy. Terminal access must require explicit host-level permission. Backlog: B02, B03, B18, B19.

### F03 — P0: encrypted credentials are not an encrypted brain

`electron/sqlite-store.cjs:20` opens ordinary `better-sqlite3`, enables WAL, and stores JSON text and vector blobs without encryption. Images ride inside records. JSON exports are plaintext. Legacy IndexedDB is deliberately retained after migration (`src/lib/db.ts:7`), creating another data copy that a vault migration must account for.

`electron/keystore.cjs` protects provider keys with Electron `safeStorage`, but checks availability rather than the selected Linux backend. Electron documents that `basic_text` provides no meaningful protection. Require a real OS secret store or password-based vault unlock; never silently downgrade. [Electron safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage).

Required: encrypted database, encrypted attachments and indexes, key lifecycle, lock/recovery behavior, and migration of old plaintext copies. Backlog: B07–B09, B15, B22.

### F04 — P0: Claude permission configuration is unsafe even for chat

`electron/api-server.cjs:731` combines `allowedTools: []` with `permissionMode: 'bypassPermissions'`; similar patterns appear in drafting, planning, review, and research. The executable card path (`:1479`) also bypasses permissions and loads user/project settings and all skills. Current Anthropic documentation explains that `allowedTools` pre-approves tools; it does not restrict the available tools when bypass mode approves unmatched requests. The installed SDK types also document a separate opt-in flag for bypass mode that this code does not set. Runtime behavior must be verified against a pinned SDK/CLI combination. [Claude permission documentation](https://code.claude.com/docs/en/agent-sdk/permissions).

Required: explicit tool inventory, enforceable denials, approval callbacks, sandboxed workspaces, skill trust, and contract tests. Use ordinary model APIs for tool-free chat where appropriate. Do not “repair” SDK compatibility by adding a bypass flag globally. Backlog: B04, B24–B26.

### F05 — P0 for cloud: fetch and file guards are incomplete

`electron/extract.cjs` contains useful scheme/private-address checks. However, `extractUrl()` follows redirects before checking the final URL; an internal destination could already have been contacted. DNS is checked separately from connection establishment. The headless browser fallback lacks a demonstrated per-request egress boundary. `electron/research.cjs:22` has a separate link verifier that fetches candidate URLs without the same guard.

`electron/api-server.cjs:1252` checks lexical containment inside a caller-supplied `.claude` root, without a demonstrated approved-workspace registry or symlink/junction containment. Research file extraction also accepts host paths.

Required: one hardened fetch broker with redirect-by-redirect and connection-time validation, isolation for document parsers/browser workers, and canonical authorized file roots. Add adversarial fixtures rather than testing against private production endpoints. Backlog: B05, B12.

### F06 — P1: agent credentials and lifecycle are process-global or volatile

`electron/api-server.cjs:1446` mutates `process.env.ANTHROPIC_API_KEY` per run, restoring it on the success path rather than in `finally`. Concurrent runs and failures can cross-contaminate execution context. Active runs are held in in-memory maps. `src/lib/runs.ts` makes the renderer responsible for saving stream progress and completion.

Required: per-process/per-run environment, durable events, explicit runner ownership, cancellation acknowledgments, crash reconciliation, and bounded retries. Backlog: B04, B10, B24.

The current calls also use runtime defaults rather than a demonstrated isolated encrypted session-storage boundary. Claude/Codex/other CLI history and logs require a separate inventory; encrypting `aios.db` alone cannot establish protection for runtime-owned files.

### F07 — P1: capture durability depends on UI and provider availability

`src/tabs/SnippingTab.tsx` and `src/lib/memory.ts` perform analysis/indexing in the renderer. Some retries and raw-note persistence already exist, but there is no shared durable processing queue. `mobile/src/screens/CaptureScreen.tsx:76` requires successful analysis before saving to the desktop. Closing the app or losing connectivity can therefore interrupt the mobile capture path before a durable save.

Required: persist original bytes and capture metadata first; show saved, processing, indexed, and failed as separate states. Store each processing stage durably outside React. Backlog: B10–B14, B20, B21.

### F08 — P1: local-first operation is incomplete

`src/App.tsx:37` retrieves the Gemini key into renderer memory; `src/lib/ai.ts:31` retains it and constructs the Gemini client. OCR, categorization, embeddings, and much of research depend on Gemini. The provider registry lists Ollama, but an integrated offline equivalent was not found. Existing CLI subscription chat does not supply all these capabilities.

Required: server/worker-owned credentials, useful capture and lexical search with zero provider accounts, local OCR and embedding options, optional local transcription, and explicit consent before sending content externally. Backlog: B03, B11, B13, B14, B23.

### F09 — P1: mobile is remote control rather than synchronization

`mobile/src/api/client.ts` reads from the desktop. `mobile/src/screens/DiveChatScreen.tsx` and `ChatView.tsx` manage conversations in component state; the README explicitly identifies continued chats as ephemeral. The 3D WebView downloads its application from the desktop. No record replication, local brain database, conflict handling, or per-device encrypted blob cache was found.

Required: local replicas, durable conversations, bundled brain assets, selective offline media, and device-independent synchronization. Backlog: B16–B22.

### F10 — P1: orchestration is coupled to Claude and mounted React tabs

`src/lib/maestro.ts` is a useful deterministic scheduler core, but `src/tabs/KanbanTab.tsx:628` runs its heartbeat in React. Worker definitions and run routes are Claude-specific. `electron/api-server.cjs:1656` creates a new Codex thread per chat call and reconstructs history as text. Closing the UI, reconnecting from a phone, or retrying a run cannot rely on a durable common session protocol.

Required: retain the board, move coordination to a service, persist provider session IDs and structured events, and normalize capability differences. An LLM transcript review is an advisory signal, not proof that tests passed. Backlog: B23–B28.

The Google adapter's comment at `electron/api-server.cjs:1918` describes an older Antigravity text-only interface. Current official documentation exposes structured output and resumable conversations; qualify the installed runtime version before upgrading the adapter. [Antigravity headless interface](https://antigravity.google/docs/cli/headless/).

### F11 — P1: import, deletion, and settings are not ready for replication

`electron/main.cjs:582` accepts a wrapped or bare JSON object and bulk loads it without validating the export version or every record. `electron/sqlite-store.cjs:26` disables foreign keys; deletion is table-specific, and no synchronized tombstone lifecycle exists. `dumpAll()` includes every meta key, which mixes portable preferences with machine-specific and potentially active orchestration state.

Required: versioned manifests and validators, transactional staged import, fresh identity on restore, explicit collision handling, disabled imported automations, and deletion of derived data. Backlog: B07, B15–B17, B22.

### F12 — P1: dependency security and packaging need a controlled upgrade

The production audit includes high-severity entries in `xlsx`, `officeparser`/`pdfjs-dist`, `@xmldom/xmldom`, `form-data`, `undici`, `jsondiffpatch`, and `nanoid`. Counts include transitive propagation and do not establish exploitability of every advisory. `xlsx` reported no automatic fix in the configured npm distribution. Several recommended upgrades are major-version changes; running a blind forced audit fix would be unsafe.

Required: lockfile-specific advisory inventory, reachability triage, maintained replacements where needed, parser isolation, and regression tests around provider stream formats. Backlog: B01, B06, B32.

### F13 — P1: installation and cross-platform support are not demonstrated

`package.json` sets `mac.identity` to `null`; `RELEASING.md` describes unsigned distribution. `.github/workflows/release.yml` builds installers without typechecks or smoke tests and accepts missing installer files. Intel Mac is disabled. The mobile profile prepares Android artifacts; iOS config alone is not an iOS release. No updater implementation was found.

`CLAUDE.md` also documents Linux/Wayland capture limitations. These must appear in the support matrix until tested and fixed. Windows signing does not guarantee immediate SmartScreen reputation; the release document's EV claim is outdated. [Microsoft signing and reputation guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

Backlog: B29–B33.

### F14 — P2: scale and usability need measurement

`src/lib/graph.ts:303` performs pairwise semantic comparisons; several consumers load all snippets/chunks and score them in JavaScript. All major desktop tabs remain mounted. These choices preserve state but can become expensive as video frames and transcripts multiply the number of records.

Required: durable state before lazy mounting, paginated queries, worker-based indexing, bounded graph neighborhoods, explicit embedding model/version metadata, reduced-motion/list fallbacks, and large-vault benchmarks. Backlog: B14, B21, B28, B32.

### F15 — P1 commercial gate: authentication rights and asset licensing

Anthropic's current Agent SDK overview says third-party products must obtain approval before offering Claude subscription login/rate limits. Existing local code behavior does not establish permission to sell that integration. Ship supported API-key authentication unless the relevant approval is obtained; preserve a user-operated local terminal as a distinct mode, subject to applicable terms. [Anthropic Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

No root license file or complete third-party asset/model attribution inventory was found. Establish rights for brain meshes, textures, icons, bundled SDK/CLI binaries, OCR/speech weights, and media codecs. Backlog: B06, B23, B35.

## Recommended order

Contain privileged access and unsafe permissions first. Define the shared data model and encryption lifecycle next. Then make captures durable and useful offline, implement encrypted replication, promote mobile to a real local client, modernize adapters and orchestration, and complete signed distribution. The detailed dependencies and completion evidence are in [SHIP-BACKLOG.md](SHIP-BACKLOG.md).

## Source navigation

| Code | Main review area |
|---|---|
| [SQLite store](../electron/sqlite-store.cjs) / [renderer facade](../src/lib/db.ts) | Persistence, migration, deletion, export |
| [API server](../electron/api-server.cjs) | Local authorization, providers, filesystem, agent runs |
| [Mobile gateway](../electron/mobile-gateway.cjs) / [mobile auth](../mobile/src/store/auth.tsx) | Pairing, transport, proxy, terminal authority |
| [Electron main](../electron/main.cjs) / [preload](../electron/preload.cjs) | Window security, IPC, export/import, credentials |
| [AI layer](../src/lib/ai.ts) / [capture](../src/tabs/SnippingTab.tsx) / [memory enrichment](../src/lib/memory.ts) | Renderer AI work, raw capture, retries |
| [Extraction](../electron/extract.cjs) / [research](../electron/research.cjs) | Files, URL fetching, redirects, provider dependencies |
| [Maestro](../src/lib/maestro.ts) / [runs](../src/lib/runs.ts) / [Orchestra](../src/tabs/KanbanTab.tsx) | Scheduling, execution, review, persistence |
| [Mobile capture](../mobile/src/screens/CaptureScreen.tsx) / [mobile conversations](../mobile/src/screens/DiveChatScreen.tsx) | Offline behavior and persistence |
| [Graph construction](../src/lib/graph.ts) / [brain visualization](../src/components/BrainView3D.tsx) | Performance and reusable visual assets |
| [Release workflow](../.github/workflows/release.yml) / [package configuration](../package.json) | Build matrix, signing, checks, dependencies |
