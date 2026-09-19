# AIOS implementation status

Updated 2026-09-18. **Foundation hardening implemented; not ready for public release.**

This is the execution record for [SHIP-BACKLOG.md](SHIP-BACKLOG.md), not a replacement roadmap. No vault encryption, multi-device sync, offline OCR, video pipeline, signed installers, or launch/billing system is claimed by this batch. No production user data or paid provider sessions were used for testing.

## Implemented in the first batch

| Packet | Implemented | Remaining before packet acceptance |
|---|---|---|
| B01, partial | Repeatable desktop check/test/build commands; Electron syntax checks; Windows/macOS/Linux CI definition; mobile typecheck; real Chromium/API/IPC/gateway smoke; release artifact and high-severity dependency gates | Remote CI results, native mobile builds, startup measurements, UI interaction snapshots, audit artifacts/SBOM |
| B02, partial | Process-lifetime loopback credential; Host/Origin checks; exact mobile proxy allowlist; header-only mobile auth; remote terminal off by default with desktop confirmation; token rotation closes active gateway streams/terminals; ingest authentication before body parsing | Enforced encrypted remote transport, per-device/scoped grants, rate/resource limits; existing LAN listeners are still HTTP |
| B03, partial | Gemini generation moved out of renderer; raw provider-key getter and Deepgram key route removed; provider-only credential mutation; trusted top-frame IPC checks; renderer/overlay sandbox; navigation controls; production CSP; insecure Linux keyring fallback rejected; safer credential-file replacement; dictation file logging opt-in | Comprehensive IPC payload schemas, narrower popout capabilities, explicit browser-permission policy, complete capture/editor/popout regression matrix, custom app protocol |
| B04, partial | Claude chat/drafting has explicit empty tool inventory; agent execution has bounded selected tools and native allow-once/deny hooks; no implicit machine skills/settings; per-run credential environment; disconnect cancellation; duplicate-run rejection; SDK failures not reported as success; removed Google CLI permission-bypass flag | Live SDK approval/denial tests; workspace/network/OS sandbox; comprehensive CLI capability/version checks; approval history and persistent run lifecycle; environment minimization across providers |
| B05, partial | Shared research fetch transport validates every redirect before contact, pins DNS answers, excludes private/reserved addresses, limits response size/redirects/time; URL liveness checks use it; unsafe browser fallback removed | Approved real-path filesystem capabilities, symlink/junction tests, isolated parsers, archive/PDF/resource-limit fixtures, safe JS-rendering worker |
| B06, inventory only | Re-ran desktop/mobile production dependency audits; release gate rejects high/critical findings | Dependency upgrades/replacements, parser/stream compatibility testing, license inventory, SBOM |
| B20 prerequisite only | Mobile pairing credentials migrated to native SecureStore with verified readback before deleting legacy plaintext; unpair ordering tested; tokens removed from WebView/SSE URLs | Native Android/iOS migration tests, independent encrypted mobile vault, durable offline capture queue, TLS/pinning/device pairing |

The existing layout, colors, sidebar, brain visualization, capture controls, and agent tabs have not been redesigned. Functional security changes below are intentional.

## Compatibility and migration notes

- Desktop API access is private to registered AIOS top-level windows and internal services. Scripts that called its random port without authentication no longer work. Use the dedicated authenticated ingest interface for external note capture; never expose the desktop API token.
- Gemini prompts and result shapes remain in the existing capture/brain flow, but requests now pass through the main-process service. Stored provider keys are not hydrated into browser memory. A newly entered credential necessarily exists briefly in its input field before saving.
- Update the desktop and mobile builds together. Old mobile clients that put the token in a terminal/WebView URL are intentionally unsupported. Pairing format remains `{url, token}`; there is no automatic privilege expansion.
- SecureStore adds native configuration: mobile binaries must be rebuilt. On first launch, valid legacy credentials are copied to SecureStore, read back, then removed from AsyncStorage. Failed migration preserves the original for recovery. An older mobile binary will require pairing again after downgrade; do not restore plaintext automatically.
- Remote terminal access is disabled even if the gateway was already enabled. Enabling it requires a warning/confirmation on the desktop and grants **every holder of the current shared token** shell access. It is not a per-device grant. Turning it off closes gateway sessions through the settings restart. Rotation closes active streams and terminals; it does not undo actions already performed or guarantee cancellation of every provider-side request.
- Existing Claude board agents now request approval for each tool invocation, including reads. Deny is the default. Installed skills, project hooks/settings, and automatic subagents are not silently loaded. Unknown tool names fail closed. Fine-grained remembered grants come later; this can increase prompts or require edits to old definitions.
- Research only fetches public HTTP(S) on ports 80/443, with a 4 MiB response cap, five redirects, and an overall deadline including DNS/body transfer. Compressed responses ignoring the requested identity encoding are rejected. Private Hermes/provider endpoints use their separate connection paths. JS-only sites may return thin text: use a screenshot/file until the isolated browser worker exists.
- No database schema or existing vault record was migrated. Database and JSON exports remain **plaintext**. Provider credential encryption is not database encryption. Credential-store corruption now fails closed instead of overwriting the file with an empty store. Existing encrypted key format is unchanged.
- Linux `basic_text` cannot save/read credentials through the keystore. Install/unlock a real OS keyring. This does not yet provide the planned password/recovery vault flow.
- Diagnostic dictation file logging now requires `AIOS_DICTATION_DEBUG=1`. This change does not erase historical log files.

## Verification

Local environment: Windows, Node 22.14.0, dependencies resolved by the existing desktop lockfile. New mobile SecureStore dependency recorded in the mobile lockfile.

Commands:

```powershell
npm.cmd run check
npm.cmd run test:electron
Set-Location mobile
npm.cmd ci --ignore-scripts
npm.cmd run lint
```

Verified locally:

- Desktop and mobile TypeScript checks.
- Electron/test CommonJS syntax validation.
- Security suite: actual HTTP authentication/Host/Origin/preflight, mobile route policy, no-tool policy, allow-once/deny/cancel decisions, credential isolation, SDK error outcomes, Gemini input boundary, IP/redirect/DNS/deadline fixtures.
- Four migration tests: secure copy/readback, failure preservation, unpair ordering, malformed pairing rejection.
- Existing native SQLite CRUD/bulk-load tests plus inherited-property dispatch rejection.
- Production Vite build. Existing large-bundle warnings remain; no performance improvement is claimed.
- Real Electron/Chromium using a temporary profile/database: sandboxed preload, authenticated GET/JSON POST with preflight, unauthenticated HTTP rejected, unregistered/navigated IPC rejected, mobile forwarding authenticated internally, privileged proxy paths denied, terminal default-deny, token rotation, and corruption-safe credential-file handling. Native key encryption/roundtrip is tested when an OS keyring is available (Windows locally).

Tests retain temporary fixture profiles in the OS temp directory for inspection. The Electron smoke intentionally prints two “Untrusted IPC sender” errors for denied negative cases. These are expected; success is the final PASS and exit code 0.

Not verified: paid/live model calls, real Claude CLI permission hooks, all capture/Monaco/terminal interactions, physical phone SecureStore/WebView/SSE behavior, iOS builds, Linux/macOS desktop runtime, packaged installers, signing, updater, or remote CI. Native security review is still required. Local typechecks and mocks do not establish those claims.

## Release-blocking dependency inventory

`npm audit --omit=dev --json`, 2026-09-18:

| Tree | High | Critical | Other | Total affected entries |
|---|---:|---:|---:|---:|
| Desktop | 8 | 0 | 6 moderate, 7 low | 21 |
| Mobile | 21 | 1 | 17 moderate | 39 |

Counts include propagated/transitive entries, not that many independently exploitable runtime flaws. Mobile's production tree includes its Expo/Metro build tooling.

Desktop priorities: `xlsx` has no registry fix reported; `officeparser`/`pdfjs-dist` need a reviewed parser upgrade; AI SDK/jsondiffpatch/nanoid must be upgraded with stream-protocol tests; fixable xmldom/form-data/undici paths also remain. Mobile priorities: legacy Expo/RN toolchain and `tar` critical findings, plus markdown/linkification and parser dependencies. Do not run `audit fix --force` or override major versions without compatibility evidence.

The desktop release workflow now stops on high/critical audit results. It is expected to fail that gate until B06 is completed. No tag, installer publication, store upload, or monetization launch is authorized by a passing unit test.

## Next executable batches

1. Finish B05 approved-path/file capabilities and parser worker isolation. Add symlink/junction, malformed archive, oversized file, timeout, and rollback fixtures before handling more media formats.
2. Complete B06 in tested dependency groups, then run clean-install desktop/mobile CI. Confirm distribution rights for dependencies and brain assets.
3. B07 shared schemas and transaction-safe migrations; B08 SQLCipher/native binding compatibility spike on all intended platforms. Do not substitute a SQLite PRAGMA for verified encryption support.
4. B09 lock/recovery and staged conversion, then B10 durable jobs + B11 capture-first/offline OCR. Prove crash/retry/offline capture retains originals without any AI account.
5. B12–B15 media/evidence and portable archive; B16–B22 reviewed encryption/sync/device enrollment and independent mobile/share support. Keep cloud execution separate from ciphertext sync.
6. B23 onward provider registry/sessions/configurable tabs, then signing/updating, private beta, external security review, and the gated launch plan.

No new account was required for this batch. Native platform testing, code-signing/store identities, optional managed hosting, billing, and independent review require later owner participation. Local-only capture/use must remain account-free.

## Implementation references

- [Electron webRequest](https://www.electronjs.org/docs/latest/api/web-request): main-process header injection; only one listener per event, so consolidate future networking policies rather than overwriting this hook.
- [Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions): tool inventory, permission modes, and approval hooks are separate controls.
- [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/): native credential storage and platform backup limitations; not a substitute for a vault database.
- [Node HTTP request API](https://nodejs.org/api/http.html#httprequesturl-options-callback): controlled connection lookup and bounded request lifecycle.
