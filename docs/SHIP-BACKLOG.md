# AIOS executable shipping backlog

2026-09-18. Implements [SHIP-PLAN.md](SHIP-PLAN.md); findings refer to [SHIP-AUDIT.md](SHIP-AUDIT.md). There are 44 work packets: B01–B26, five provider packets under B27, and B28–B40. See [SHIP-STATUS.md](SHIP-STATUS.md) for actual implementation and verification; a partial packet is not complete.

## Execution rules

Each packet is an issue/epic suitable for a responsible engineering agent plus human review. Before implementation, split any packet exceeding about five working days into bounded PRs with the same acceptance criteria. Some security, sync, and release packets intentionally require several PRs. An agent should not start downstream work by assuming an unapproved protocol or inventing another encryption format.

For every packet, deliver the code/configuration, meaningful verification, a migration/rollback note where relevant, and concise operator/user documentation. Record actual commands and results, supported platforms/versions, remaining risks, and any unavailable account/device in the PR. Use synthetic fixtures and temporary vaults. Do not test against the owner's personal brain or live paid agent sessions by default.

Preserve the existing style and useful behavior. Enforce permission boundaries in the service, not just the UI. Feature flags must fail closed for incomplete remote execution and crypto functionality. Never weaken a release gate to make a test green, auto-upgrade all dependencies with force, or call a mock-only adapter production-ready.

Current checks: `npm.cmd run check` (desktop types, CJS syntax, security/migration/store tests, production build), `npm.cmd run test:electron` (real Chromium/API/IPC/gateway tests), and `npm.cmd run lint` in `mobile/`. New tests proposed in individual packets remain deliverables unless recorded as verified in the status document.

## First two implementation weeks

| Order | Concrete work | Evidence before moving on |
|---|---|---|
| Days 1–2 | B01 baseline; define documented supported platforms; open B02–B06 findings with repro fixtures | Reproducible type/build/store checks and advisory inventory |
| Days 2–5 | B02 local authentication/proxy containment; B03 secret boundary; B04 permission corrections | Unauthorized requests fail; renderer does not receive raw provider secrets; denied tools do not run |
| Days 4–8 | B05 fetch/file isolation; B06 safe dependency upgrades in small groups | Redirect/symlink fixtures fail safely; parser and stream regressions pass |
| Days 5–10 | B07 domain contracts; B08 encryption feasibility; B23 provider contract draft | Reviewed schemas, native compatibility matrix, adapter fixtures |
| End of week 2 | Architecture checkpoint and revised effort estimate | Approve encryption binding, sync conflict policy, native share approach, and GA scope |

This is a suggested sequence with multiple engineers; it is not a promise that one agent finishes all packets in ten days. Cryptography and mobile native feasibility must be resolved before committing to a launch date.

## Phase 0 — contain risk and establish evidence

### B01 — reproducible baseline and CI

Owner: release/test engineer. Dependencies: none. Start: `package.json`, lockfile, `tsconfig.json`, `scripts/`, `.github/workflows/`.

Steps: record runtime/SDK/native ABI versions; add CI for desktop typecheck, production build, existing storage tests, and dependency audit artifacts; add explicit mobile typecheck/build setup with a committed deterministic lockfile; establish temporary fixture vaults and baseline UI snapshots. Include Electron source validation rather than relying on the renderer-only typecheck. Pin a supported Node version after checking dependency requirements.

Acceptance: a clean checkout reproduces checks; CI fails on type errors and missing required artifacts; test runs do not touch real user data; audit failures are classified rather than silently ignored. Save baseline startup/bundle measurements and identify untested platforms.

### B02 — local API authentication and gateway containment

Owner: application security/backend. Dependencies: B01. Start: `electron/api-server.cjs`, `mobile-gateway.cjs`, `memory-ingest.cjs`, `src/lib/apiBase.ts`, mobile client.

Steps: authenticate privileged loopback calls with a session-scoped capability or OS-protected transport; validate Host and Origin for HTTP; replace wildcard remote proxy with an explicit operation allowlist; separate read/capture from run/terminal privileges; require appropriate transport protection for non-loopback access; retire query-string bearer tokens with a tested client transition. Keep health responses nonsensitive.

Acceptance: unpaired clients, hostile origins/hosts, expired credentials, and capture-only devices cannot read arbitrary content, execute agents, access files, or spawn a shell. Existing authenticated desktop workflows still work. Legacy mobile credentials cannot gain new authority through a fallback route.

### B03 — remove renderer secrets and harden Electron

Owner: desktop/security. Dependencies: B02. Start: `main.cjs`, `preload.cjs`, `keystore.cjs`, `src/App.tsx`, `src/lib/ai.ts`, model settings, terminal IPC.

Steps: move Gemini calls to workers/backend; remove generic key retrieval and Deepgram key-return routes; expose configured/valid/error metadata instead; validate every IPC sender/frame and request; enable renderer sandboxing where compatible; implement navigation/window-open, permission, custom-protocol, and CSP policies; fail closed on Linux `basic_text` secure storage. Limit each window's bridge.

Acceptance: renderer inspection cannot obtain stored keys; untrusted frames cannot invoke vault or terminal handlers; capture/popouts/Monaco still work with the hardened policy; Linux without a keyring receives a usable password-unlock path or clear blocked credential storage.

### B04 — enforce tool policies and isolate run credentials

Owner: agent runtime/security. Dependencies: B01, B02. Start: SDK and CLI branches in `api-server.cjs`, `deep-research.cjs`, `src/lib/agents.ts`.

Steps: remove default permission bypasses; define available tools separately from preapproved tools; add deny rules and approval callbacks; use tool-free model calls for non-agent chat; pass credentials per child process/run, never through process-global mutation; constrain workspace roots, environment, network, and time/budget. Audit settings/skills inherited from the machine.

Acceptance: a chat prompt asking to write a file cannot do so; an unapproved shell action waits or fails safely; concurrent API/subscription runs do not share credentials; exceptions clean up child processes and run state; SDK-version mismatch is surfaced without silently broadening permissions.

### B05 — safe URL, file, and document processing boundary

Owner: backend/security. Dependencies: B02. Start: `electron/extract.cjs`, `research.cjs`, file routes, report rendering.

Steps: centralize URL validation and connection establishment; check each redirect before contact; prevent DNS rebinding and private/link-local/metadata access, including IPv6 forms; restrict headless browser subrequests; authorize real filesystem paths under approved roots with symlink/junction handling; cap downloads, archive expansion, parse time, memory, and output.

Acceptance: synthetic redirect-to-private, rebinding, symlink escape, oversized archive/PDF, decompression bomb, and stalled-response fixtures fail safely. Private agent endpoints use separately user-approved connection policies rather than disabling research fetch protections.

### B06 — dependency remediation and distribution inventory

Owner: maintenance/release. Dependencies: B01. Start: dependency manifests/lockfiles, extraction and streaming paths, `assets/`, `public/`.

Steps: map the audit's 21 affected entries to resolved versions and reachable features; upgrade fixable groups; replace or source a maintained distribution for packages without a registry fix; upgrade AI streaming adapters together with their parsers; inventory licenses for native binaries, media libraries, SDKs, models, meshes, textures, and icons. Produce an SBOM and proposed attribution file.

Acceptance: no untriaged high/critical production advisory; evidence for any accepted exception has owner/expiry; parsing and streaming regressions pass; dependency reproducibility and license obligations are documented. Do not claim that an audit with zero findings proves security.

## Phase 1 — dependable local vault and capture

### B07 — shared schemas, repositories, and migrations

Owner: data/platform. Dependencies: B01. Start: `electron/sqlite-store.cjs`, `src/lib/db.ts`, feature stores, mobile types.

Steps: define versioned domain schemas from the main plan; create shared validators and repository interfaces; add transactional migrations, referential rules, stable IDs, source revisions, separate user/generated fields, and device-local settings; introduce an encrypted-file-compatible blob manifest; preserve facade compatibility while extracting core packages.

Acceptance: old synthetic vaults migrate without lost fields; malformed records are rejected; failed migrations roll back; deleting an entity has defined child/reference behavior; desktop and mobile compile against the same contracts. A future schema version cannot be silently overwritten by an old client.

### B08 — encryption compatibility spike and storage implementation

Owner: native/storage engineer with security reviewer. Dependencies: B07. Start: SQLite initialization, packaging, mobile native config; proposed `packages/vault`.

Steps: build a maintained SQLCipher binding on Windows, macOS, Linux, Android, and iOS; establish database/WAL/temp behavior; implement encrypted blobs and streams with reviewed libraries; validate browser ciphertext storage separately; document algorithm/format versions and native distribution obligations. Make a decision at the 1–2 engineer-week spike checkpoint.

Acceptance: a known plaintext marker is absent from database/WAL/blob files while locked; wrong keys and modified ciphertext fail; partial/corrupt chunk streams cannot produce accepted content; every target build can create, reopen, migrate, and back up a synthetic vault. Independent review of composition remains a later release gate.

### B09 — key lifecycle, lock, recovery, and legacy conversion

Owner: vault/security. Dependencies: B08, B03. Start: keystore, startup, native secure storage, migration facade.

Steps: implement device keys, vault-key wrapping, password/KDF policy, recovery secret, lock/unlock, and OS-store integration; inventory and migrate existing SQLite/IndexedDB/data files through staged verified conversion; show retained legacy-copy status; add recovery rehearsal and controlled disposal of redundant plaintext data.

Acceptance: password changes retain data; another authorized device or recovery secret restores access; service login reset alone cannot decrypt; lock hides data and closes relevant handles; keyring failure does not silently downgrade; crash at every conversion checkpoint leaves either the verified old vault or verified new vault recoverable.

### B10 — durable processing service

Owner: backend/runtime. Dependencies: B07, B09. Start: `src/lib/memory.ts`, `SnippingTab.tsx`, ingestion listeners; proposed `packages/jobs` and runner.

Steps: move enrichment out of mounted React components; persist job stages, input hashes, processor versions, attempts, retry times, budgets, and cancellation; implement transactional claims/leases and idempotent output commit; decouple run lifetime from HTTP streams; emit replayable status events and recover interrupted jobs.

Acceptance: capture is acknowledged only after durable save; killing renderer/worker at each stage loses no acknowledged original; duplicate delivery does not duplicate neurons; offline/provider-429/disk-full conditions show actionable status; cancellation stops subsequent stages and cleans temporary resources.

### B11 — account-free screenshot/text/PDF capture and OCR

Owner: capture/desktop. Dependencies: B10, B03. Start: snipping overlay, SnippingTab, `ai.ts`, extraction, `SnippetEditor`.

Steps: unify snip, paste, drag/drop, file, and text capture through the job contract; bundle or offer a verified local OCR engine/languages; preserve raw source plus OCR blocks/confidence; offer optional provider enrichment; make Inbox visibility independent of embeddings. Include permission-denied/retry UX.

Acceptance: on a clean machine with no AI keys and network disabled, save a screenshot, extract basic text with the installed OCR pack, find it through lexical search, restart, and reopen the original. Cloud failure never prevents saving. Small-text and multilingual fixtures quantify OCR limits.

### B12 — bounded video ingestion and frame extraction

Owner: media/runtime. Dependencies: B05, B08, B10. Start: new media worker behind the extraction interface.

Steps: integrate a vetted FFmpeg distribution; validate type/size/duration; extract metadata/audio; detect scenes and sample periodic frames; deduplicate frames; generate timestamped thumbnails; encrypt artifacts and clean temp files; record sample coverage and estimated work before processing. Allow configurable limits with safe defaults.

Acceptance: reference short and one-hour recordings produce seekable timestamped frames; corrupt/unsupported files fail without affecting the app; cancellation and worker restart resume safely; repeated frames are deduplicated; brief-text omissions are acknowledged with manual/dense sampling options; no silent unlimited CPU or storage use.

### B13 — transcription and multimodal evidence merge

Owner: media/AI. Dependencies: B11, B12. Start: new speech adapter, processing schemas, snippet/neuron detail.

Steps: integrate local transcription with verified model downloads and optional external provider adapters; align transcript segments, frame OCR, and extracted entities; preserve literal observations separately from inferred labels; attach language/confidence/timestamps; deduplicate repeated links with provenance; support corrected transcript revisions.

Acceptance: a test video yields transcript, frame OCR, names/URLs, and clickable source times; correcting speech text does not destroy original output; silent videos remain useful via OCR; interrupted processing resumes; measured word/character errors and sampled-frame coverage are reported for the fixture corpus.

### B14 — retrieval, evidence-linked research, and scalable brain data

Owner: knowledge/retrieval. Dependencies: B07, B10, B11; integrate B13 as available. Start: `graph.ts`, SecondBrain, AskBrain, research modules.

Steps: add encrypted local full-text indexing and a local embedding option; version embedding spaces; retrieve paginated/chunked content; update semantic links incrementally in a worker; save evidence locators, citations, and research retrieval dates; cap graph neighborhoods; isolate external research behind cost and data-sharing policy.

Acceptance: search works without any cloud key; mismatched vector spaces are never compared; seeded retrieval tests find known evidence; research links support specific claims or are marked unsupported; a 10,000-neuron synthetic vault does not require mounting all original media or comparing every pair on each edit.

### B15 — portable backup/export/import

Owner: data/recovery. Dependencies: B07–B09. Start: `main.cjs` brain export/import and `sqlite-store.cjs` dump/bulk load.

Steps: keep JSON support; add versioned JSON/NDJSON-plus-attachments archives, encrypted by default; schema/checksum/path validation; dry-run preview; staged transactional merge/duplicate/replace; exclude credentials and active device/runtime state; disable imported automation; document how to change sync destinations.

Acceptance: export on one OS and restore into a fresh vault on another preserves source bytes, relationships, notes, and conversations; malformed/path-traversing/corrupt archives change nothing; large media does not require one giant in-memory JSON value; restoring twice has predictable collision handling; old exports remain importable or receive a precise migration message.

## Phase 2 — encrypted replication and independent mobile

### B16 — sync protocol and conflict conformance suite

Owner: sync architect. Dependencies: B07, B09. Start: new protocol schemas and synthetic multi-replica harness.

Steps: specify envelope, mutation ID, device signature, parent revision, key epoch, cursor, tombstone, snapshot, and blob lifecycle; implement the merge rules from the plan; define version negotiation, retained-history windows, reset recovery, and compromised-relay limitations; establish cross-platform test vectors before networking.

Acceptance: a simulator with three devices converges under reordered/duplicate delivery and clock skew; concurrent notes preserve alternatives; deletions do not resurrect; incompatible clients fail safely; cryptographic metadata binding and snapshot rollback checks have reviewer-approved tests.

### B17 — relay and client outbox/inbox

Owner: sync/backend. Dependencies: B16, B18; local persistence can start against mock identity. Start: `services/relay`, `packages/sync`, desktop vault repository.

Steps: implement PostgreSQL-backed envelope storage, durable cursors, idempotent push/pull, tenant/vault authorization, quotas, and metadata-only metrics; connect local transactions to outbox/inbox; add foreground reconnect and optional push hints; implement snapshot/reseed policy; package a single-host deployment.

Acceptance: acknowledged changes survive service/client restart; one account cannot enumerate or retrieve another's records/blobs; sync interruption and replay converge; a relay database dump contains no plaintext brain content; unsent local work survives cursor reset; one relay can serve two desktop replicas without Electron running on the relay.

### B18 — pairing, device permissions, revocation, and recovery

Owner: identity/security. Dependencies: B09, B16. Start: mobile pairing/auth and new device registry.

Steps: replace shared tokens with one-use invites and authenticated device enrollment; bind device keys to vault membership; provide QR and manual verification; issue scoped, expiring service credentials; separate passkey/service account recovery from vault recovery; implement device grants, revocation epochs, and auditable key transitions.

Acceptance: intercepted/expired/reused invites cannot enroll; a read/capture grant cannot execute; lost-phone revocation blocks future sync and command requests; old queued writes have an explicit reconciliation path; adding a new device requires authorized vault-key access; secrets never appear in URLs or logs.

### B19 — encrypted media sync and remote worker channel

Owner: sync/storage. Dependencies: B17, B18, B08. Start: blob adapters and device transport.

Steps: add chunked resumable uploads/downloads, integrity verification, encrypted manifests, preview-first sync, cache quotas, Wi-Fi preference, and pin-offline controls; implement a separately scoped authenticated channel for remote job commands/events; require endpoint identity and encrypted transport even on an untrusted LAN.

Acceptance: a large video resumes after interruption without full reupload; cache eviction never deletes the authoritative original; partial uploads are not readable as complete assets; a sync-only relay cannot launch a terminal; no worker receives a vault master key merely because it can execute one job.

### B20 — independent mobile vault and persistent conversations

Owner: React Native/native data. Dependencies: B07–B09, B10; sync integration after B17–B19. Start: `mobile/App.tsx`, store, API client, chat screens.

Steps: upgrade Expo/React Native through a tested path; add native encrypted database and secure secret storage; implement local repositories/outbox; save chats and captures immediately; decouple login from mandatory desktop pairing; bundle brain assets locally with a constrained WebView bridge; add lock and restore screens.

Acceptance: fresh Android and iOS installs can create a local vault and capture offline; new/continued chats remain after app termination; existing cached neurons are accessible with desktop off; the graph never needs a bearer token in a page URL; missing original media is distinguished from data loss.

### B21 — native mobile sharing and fast capture UX

Owner: iOS/Android capture. Dependencies: B20, B11; media processing connects to B12/B13. Start: native extension targets/config plugins and CaptureScreen.

Steps: implement Android single/multiple share receives and iOS share extension/App Group handoff; copy scoped URIs immediately into encrypted staging; support images, selected text, URLs, audio, and video; handle cold start, locked vault, duplicate intents, and out-of-space conditions; add screenshot-to-brain onboarding and optional shortcuts.

Acceptance: share from Photos/browser/files while AIOS is closed and offline; acknowledge only after durable staging; kill/resume both extension and app without loss or duplicates; a locked-vault path never stores plaintext drafts; test real devices across repeated background/resume cycles, the scenario that broke the previous share implementation.

### B22 — deletion, retention, lost devices, and server migration

Owner: data lifecycle/security. Dependencies: B15, B17–B21. Start: tombstones, caches, snapshots, restore UI, settings.

Steps: implement local-only removal versus delete-everywhere; remove/rebuild affected indexes; garbage-collect unreachable encrypted blobs; publish backup expiry; reject stale-device resurrection; migrate a vault between self-hosted and managed relays with snapshot plus mutation catch-up and explicit cutover; retain rollback receipts.

Acceptance: deletion while another device is offline converges after reconnect; stale edits become visible conflicts; revoked devices cannot regain access through restore; migration preserves pending captures and checksums; account deletion and billing cancellation have distinct effects; cached content already held by revoked devices is not falsely claimed erased.

## Phase 3 — configurable agents and durable Orchestra

### B23 — provider/runtime registry and connection wizard

Owner: integration/platform. Dependencies: B03, B04, B07. Start: providers/models/authMode, ModelsTab, Hermes settings, Sidebar.

Steps: separate model capabilities from agent runtime capabilities; implement connection manifests and typed adapter interfaces for discover/auth/health/models/session/run/events/cancel/approve/artifacts; pin protocol ranges; build a connection wizard and per-device secret references; migrate existing settings without assuming every credential supports every feature.

Provide existing-host/API choices when no runtime is installed. Qualify any optional installer by signature/checksum, version, platform, license, and explicit user choice; do not make arbitrary downloaded scripts part of onboarding.

Acceptance: multiple connections to one provider can coexist; health probes explain missing CLI/auth/unsupported versions; a text-only provider cannot be selected for OCR; connection templates sync without passwords/CLI tokens or automatic execution; privacy and billing mode are clear before the first external request.

### B24 — persistent sessions, run events, and service-owned Maestro

Owner: orchestration/runtime. Dependencies: B10, B23, B04; remote execution additionally requires B18/B19. Start: `maestro.ts`, `runs.ts`, KanbanTab, run routes.

Steps: port deterministic tick logic to the service; store task dependencies and typed append-only events; retain provider session mappings; implement single-owner leases/fencing, budgets, pause/resume/cancel, approval expiry, and reconnection replay; isolate code workspaces/worktrees; persist review evidence and artifacts rather than only transcript text.

Inventory runtime-created session/checkpoint/cache/log files and isolate/protect them separately from the AIOS database. Specify lock, crash cleanup, and native-resume behavior; never assume a provider's shared user profile is safe to move, sync, or delete.

Acceptance: closing every UI does not stop an authorized service run; reconnect shows all committed events; network partitions cannot duplicate a side-effecting run; crash leaves an interrupted/reconcilable state; cancel receives a terminal acknowledgment; review requires evidence linked to acceptance checks.

### B25 — supported Claude integration

Owner: Claude adapter engineer. Dependencies: B23, B24, B04. Start: Claude routes and AgentBuilder; current SDK types.

Steps: pin compatible SDK/CLI; implement persistent sessions, structured tool events, approval hooks, constrained subagents, budgets, and workspace/skill policies; keep API-key auth as the shipping baseline unless the vendor grants subscription integration approval; distinguish terminal use from embedded automation.

Acceptance: resume retains context; denied tools remain denied; approval expires correctly after disconnect; parallel agents have isolated credentials/workspaces; supported auth succeeds against an explicitly authorized test account; adapter contract and failure fixtures pass. No secret cache copying or subscription impersonation.

### B26 — Codex job adapter and optional richer session adapter

Owner: Codex adapter engineer. Dependencies: B23, B24, B04. Start: `/api/codex-agent/chat`, Codex SDK integration.

Steps: persist SDK thread IDs, continue/resume sessions, map structured events and usage, separate chat from coding policies, and support cancel/recovery; investigate app-server account/session/approval UX in a preview adapter with explicit version/maturity gates. Keep experimental public WebSocket exposure out of the GA dependency chain.

Acceptance: existing chat remains usable; a resumed job preserves native context; sandbox restrictions are enforced; unsupported approval/steering operations are disabled honestly; provider-owned login is never harvested into AIOS sync; app-server unavailability does not break GA capture, chat history, or orchestration through supported adapters.

### B27-H — Hermes sessions, jobs, and approvals

Owner: Hermes adapter engineer. Dependencies: B23, B24. Start: Hermes routes/tab/settings.

Steps: probe capabilities; select supported HTTP run/session or other documented structured protocol; persist remote IDs; normalize approvals, steering, events, and stop; retain legacy chat fallback; qualify cron operations against the actual gateway version; remove private-IP defaults from new-user settings.

Acceptance: current supported gateway resumes a run and handles approve/deny/cancel; a legacy gateway stays usable with unsupported controls disabled; connection failures do not erase saved sessions; cron mutations require appropriate grants and remain scoped to the chosen connection.

### B27-O — OpenClaw connection

Owner: OpenClaw adapter engineer. Dependencies: B23, B24, B18. Start: new adapter and shared conversation shell.

Steps: implement gateway version/capability negotiation, authenticated device enrollment, operator scopes, session/event mapping, and approval lifecycle; store gateway credentials only on the executing device; expose distinct chat and administrative capabilities.

Acceptance: unauthorized scopes and wrong device identity fail; disconnect/resume preserves session identity; read-only connection cannot invoke execution/admin methods; revoked gateway credentials surface reconnect guidance; tested gateway versions appear in the compatibility matrix.

### B27-X — Grok API and qualified local CLI connection

Owner: xAI adapter engineer. Dependencies: B23, B24. Start: Grok API/CLI routes.

Steps: implement documented API streaming, tools/search where supported, budgets and error handling; qualify the installed CLI's provenance, version, auth, and output contract before offering its adapter; keep a generic local terminal option separate from structured orchestration; preserve user persona preferences as portable settings.

Acceptance: API connection passes session/tool/stream contract tests; unavailable CLI does not block API use; unknown CLI output never becomes a false success; subscription and API billing labels are accurate; version support and licensing are documented.

### B27-G — Google/Gemini/Antigravity connections

Owner: Google adapter engineer. Dependencies: B23, B24, B04. Start: Gemini API and Antigravity subprocess route.

Steps: retain distinct API and CLI adapter identities; detect Antigravity version and structured input/output support; map conversation IDs, resume, tool events, usage, and denied actions; remove unconditional permission skipping; preserve a compatible text fallback only where verified; separately qualify Gemini CLI versions if offered.

Acceptance: supported structured mode persists/resumes conversations and handles denial; the UI distinguishes a successful answer from a refused tool action; prompt input avoids command-line length limits and shell interpolation; expired login/missing executable produce actionable messages.

### B27-L — local-model connection

Owner: local AI adapter engineer. Dependencies: B23, B14. Start: Ollama placeholder and processing capability routing.

Steps: implement explicit local endpoint discovery/configuration, model inventory and capabilities, streamed chat and embeddings, resource checks, and model-download progress; allow user-entered compatible endpoints without making arbitrary LAN fetches available to research agents.

Acceptance: capture/search/chat work with the tested local model and Internet disabled; absent or insufficient models yield a clear installation option; remote endpoint use is labeled as external processing; model versions are recorded and incompatible embeddings are reindexed safely.

### B28 — configurable tabs, bot conversations, and preserved UI

Owner: frontend/product. Dependencies: B23, B24, B14; integrate completed provider packets. Start: Sidebar, App, HermesTab, AgentRunDrawer, ThreadedChat, brain/neuron components.

Steps: replace hardcoded connection tabs with pinned/reorderable user entries; build one reusable bot chat shell with host/model/status, evidence attachments, approvals, artifacts, and linked handoffs; connect persistent service state; add neuron source/transcript/frame panels; lazy-mount costly views while retaining sessions; provide list/2D/reduced-motion and keyboard alternatives.

Acceptance: a user adds two Claude connections and one Hermes connection without a code change; each can be chatted with independently; handing off context is visible and limited; tab navigation loses no run/chat; baseline styling remains recognizable; screen reader and keyboard users can reach all core information without interacting with the 3D canvas.

## Phase 4 — installation, cloud, and release readiness

### B29 — first-run onboarding and OS capture support

Owner: desktop/mobile product engineering. Dependencies: B09, B11, B20, B23; polish after B28. Start: startup/settings, overlay, pairing, local model setup.

Steps: add Create/Recover vault, optional sync, optional providers, first capture, and recovery rehearsal; remove owner-specific hosts/paths; detect missing OS permissions; implement tested capture backends for supported Windows/macOS/Linux environments; define a precise support matrix and troubleshooting diagnostics.

Acceptance: representative nondevelopers reach a saved first capture within five minutes on clean machines without developer tools; account-free mode is obvious; denied permissions have recovery instructions; Windows mixed-DPI, macOS capture permission, and supported Linux display-server cases have recorded results. Unverified platforms are not advertised as supported.

### B30 — independent web client and self-host deployment

Owner: web/platform. Dependencies: B17–B19, B14, B23; remote actions require B24. Start: database facade, apiBase, current mobile brain entry, extracted packages.

Steps: implement browser vault/transport adapters, unlock/device enrollment, encrypted cache, and limited offline behavior; remove Electron assumptions; ship relay Compose configuration, TLS/domain setup, health checks, persistent volumes, backup/restore, and upgrade instructions; make the runner an optional isolated service with explicit grants.

Acceptance: a fresh server serves two device replicas and web access without Electron or a desktop session; browser source contains no server secrets; locked/logout pages do not display cached content; restart/upgrade preserves ciphertext; basic self-host mode needs no SaaS dependency; terminal/global-snipping limitations are accurately shown in web.

### B31 — signed desktop installers and safe updater

Owner: release engineer. Dependencies: B01, B06, B08, B35 signing identity. Start: electron-builder config, release workflow, RELEASING.md.

Steps: build each supported native architecture; sign and notarize macOS; sign/timestamp Windows; sign/checksum Linux artifacts; add signed update metadata and staged channels; require backups/compatibility checks before schema upgrades; pin CI actions and protect signing secrets; fail when expected artifacts are missing.

Acceptance: clean VMs install, start, update, and uninstall without developer dependencies; tampered artifacts/update manifests are rejected; incompatible downgrade preserves the vault and explains recovery; migration failure can restore a verified backup; signatures/notarization verify. Do not promise signing alone eliminates SmartScreen prompts.

### B32 — integrated reliability, security, and performance gate

Owner: QA/security lead. Dependencies: applicable B02–B31 components; establish harness early via B01.

Steps: automate the release matrix below; run fault injection and large-vault tests; arrange independent crypto/sync and application-security review; verify fixed findings; build reproducible capture/OCR/transcript/retrieval fixtures; document tested devices and minimum hardware.

Acceptance: every GA gate has dated evidence against the release candidate commit/artifact; no unresolved critical/high access-control or data-loss flaw; no untriaged high/critical dependency finding; security fixes have regression tests; exceptions are explicit, narrow, and prevent unsupported claims.

### B33 — iOS and Android release pipeline

Owner: mobile/release. Dependencies: B20–B22, B29, B35. Start: mobile app/EAS/native config and new CI.

Steps: establish protected signing credentials, repeatable native builds and store profiles; test share extensions on real devices; prepare privacy declarations, permissions, accessibility, review credentials/demo mode, encryption declarations where applicable, and account-deletion flow; implement compatible update policy without downloading arbitrary mobile agent code.

Acceptance: TestFlight and Android closed-test artifacts install fresh, upgrade without losing a vault, and share offline after reboot; app review materials match real processing; supported OS/device matrix passes. Store approval and provider access are external gates, not assumed successful builds.

### B34 — operations and privacy-preserving diagnostics

Owner: platform/operations. Dependencies: B17, B24, B31; can start earlier on mock services.

Steps: add opt-in redacted diagnostics, local support export, sync lag/queue/error metrics, relay availability and storage alerts, quotas, rate limits, encrypted backup policies, restore drills, signing-key/credential rotation, incident runbooks, and notification opt-ins. Store no captured text, images, prompts, keys, or raw URLs in default analytics.

Acceptance: operators can diagnose a stalled sync without reading brain contents; logs are tested for sensitive markers; simulated disk-full, expired TLS, provider outage, and relay loss have a documented response; restoring service from backups preserves encryption and tenant boundaries; a named person owns alerts.

### B35 — publisher accounts, rights, and commercial prerequisites

Owner: founder/release/legal support. Dependencies: B06, B23. Start: inventory from the audit and account table in SHIP-LAUNCH.

Steps: establish software/license and asset rights; confirm provider integration permissions; select publisher identity and enroll required signing/store accounts; secure domains, support/privacy contacts, brand clearance, privacy terms, deletion policy, and chosen billing method; review store rules for current regions and product model.

Acceptance: account owners, access recovery, renewal dates, costs, and secret custody are recorded; no shipping feature depends on ungranted vendor permission; licenses/attributions are complete; privacy text matches the technical data flow. Account creation, payment, or legal acceptance is performed by the authorized owner.

## Phase 5 — bring to market

### B36 — qualified beta and activation measurement

Owner: founder/product/QA. Dependencies: applicable B31–B35 plus tested core capture/sync/mobile/provider paths.

Steps: recruit a small opt-in cohort, observe installation and first capture, test two-device pairing and recovery, collect structured friction reports, and run a 14-day candidate soak; begin with research-heavy individual users and expand only after evidence. Track consented aggregate funnels and interview feedback, not private content.

Acceptance: sample size and denominators accompany metrics; at least 20 two-device users complete capture/sync/restore exercises; no unrecovered acknowledged capture loss; top onboarding failures are fixed or block GA; product demand includes repeated use rather than only enthusiastic demos.

### B37 — pricing validation and billing entitlements

Owner: product/business/backend. Dependencies: B35, B36 evidence; technical scaffolding can precede final pricing.

Steps: test the proposed local/free and paid-sync offers; measure storage, traffic, support, and processing costs; implement verified checkout webhooks, idempotent entitlement changes, billing portal/cancellation/refunds, grace periods, and caps; keep provider usage separate and allow local access/export after cancellation.

Acceptance: paid/unpaid/expired/refunded/webhook-retry cases work; failed billing cannot corrupt or lock away a local brain; there is a written gross-margin model and cohort retention evidence; pricing is labeled experimental until approved; mobile purchase/link flows pass current store-policy review.

### B38 — concrete launch package

Owner: product marketing/release. Dependencies: B32, B35–B37. Start: new launch artifacts, not the runtime UI.

Steps: prepare landing page/download links, feature/support matrix, short screenshot-to-brain demo, platform setup guides, self-host guide, security architecture summary, provider compatibility list, FAQ, release notes, known issues, support intake, incident status page, and draft announcements. Use synthetic/demo data only.

Acceptance: every advertised capability has passing evidence; installation instructions work on fresh systems; download signatures/checksums are published; analytics and privacy settings are documented; drafts are reviewable before public publishing or outreach.

### B39 — gated general availability

Owner: release owner/founder. Dependencies: B32–B38 and every feature marketed as GA, including all six requested provider families.

Steps: freeze the candidate and rerun only affected checks after fixes; sign off the gate matrix; verify backups/restore and incident staffing; publish in stages; monitor installation, sync, capture durability, and billing; use a rollout stop/rollback decision when predefined thresholds fail.

Acceptance: approval identifies exact signed artifacts, commit, protocol versions, tested platform matrix, account ownership, and rollback path; 1%/10%/50%/100% staged update cohorts are used where feasible; release notes distinguish preview adapters. Public publication and spending are explicit owner actions, not automatic consequences of a passing build.

### B40 — retention-led expansion

Owner: founder/product/platform. Dependencies: B39 and at least 30 days of operational evidence.

Steps: fix the largest capture/retrieval/onboarding friction; analyze voluntary feedback, four-week retention, support burden, and per-user cost; test paid acquisition only after activation/retention improve; prioritize browser extension, team vaults, managed runners, or richer agent integrations based on measured demand.

Acceptance: each new roadmap item has a user problem, success metric, cost, and security impact; no unlimited managed AI plan is sold without enforceable budgets; core export/local use stay available; expensive scope is not justified solely by agent implementation speed.

## Release evidence matrix

Numbers below are proposed acceptance targets, not measured current performance. B01/B32 must name exact reference hardware, corpus, network, sample size, and p95 methodology before using them as gates.

| Test | Proposed pass condition |
|---|---|
| Save screenshot ≤10 MB | Durable saved acknowledgment p95 ≤2 seconds on reference native devices; AI work excluded |
| Offline recovery | 1,000 synthetic captures across crash/restart checkpoints; zero lost acknowledged originals and zero unintended duplicate IDs |
| Replication | Three devices with concurrent edits, partitions, replay, clock skew, deletion, and rejoin converge; conflicting user text is preserved |
| Foreground sync | Text/small metadata p95 ≤5 seconds on reference broadband with available relay; large media and OS-throttled background delivery reported separately |
| Restore | Full export/import checksums and record relationships match; recovery works with original machine unavailable |
| Revocation | Online services reject a revoked device's next request; future key epoch is unavailable; old offline content limitations disclosed |
| Access control | All privileged API/IPC methods have negative authorization tests; capture-only role cannot execute |
| Provider safety | Denied tool never runs; lost connection cannot silently approve; budget/cancel/timeouts produce durable terminal states |
| Media | Short and one-hour files, noisy audio, silence, rotated frames, small text, bad codecs, malformed inputs, and limited disk are covered |
| Retrieval | A versioned 100-question evidence set measures source recall and unsupported claims; accept initial target ≥90% correct source in top five, then tune before claiming quality |
| Scale | 10,000 neurons / 100,000 evidence chunks; local search p95 ≤500 ms on agreed desktop hardware; mobile receives bounded views and media on demand |
| UI | Native capture, search, neuron details, chat, settings, and approvals operable by keyboard/screen reader; no graph-only access; reduced motion available |
| Packaging | Fresh install/update/rollback/uninstall for each advertised OS/architecture; vault retained or explicitly deleted according to choice |
| Real-device mobile | At least 100 share/background/resume cycles per representative iOS and Android device; zero lost acknowledged shares |
| Production beta | 14-day soak on candidate or documented successor; ≥99.5% crash-free sessions as an initial target, with sample size and all data-loss reports reviewed |
| Hosted operations | Demonstrated backup restore; initial 99.9% monthly relay availability objective; cold/uncached-client recovery limits and backup RPO/RTO published |

## Agent handoff template

```text
Implement packet [ID] from docs/SHIP-BACKLOG.md.
Read its dependencies and relevant sections of SHIP-PLAN.md and SHIP-AUDIT.md.
Inspect repository instructions and current changes before editing.
Confirm dependencies exist; use a contract fixture where explicitly permitted.
Deliver the smallest reviewable change covering this packet's acceptance criteria.
Preserve existing styling and migration compatibility.
Do not weaken encryption, permission checks, or gates to make the task pass.
Do not use personal vault data or invoke paid providers without authorized fixtures/accounts.
Record commands/results, migration/rollback, and unresolved platform limitations.
Do not publish, purchase, or contact external parties as part of this implementation packet.
```

Recommended coordination: one owner for schemas/crypto/sync contracts, one for capture/mobile, and one for adapters/release, with an independent security reviewer. Parallel work begins only after shared contracts are reviewed. A green PR is evidence for its packet, not a declaration that the entire product is ready to ship.
