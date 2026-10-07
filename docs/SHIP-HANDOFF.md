# AIOS v1.4.0 — handoff to the next agent

Updated 2026-09-19. The owner requested a clean stopping point to limit usage. Pick one bounded task below; do not resume the entire roadmap autonomously.

## Resume here

- Repository: `jfoote22/AIOS`; branch: `feat/shipping-foundation`; package version: **1.4.0**. Use the commit accompanying this document as the checkpoint.
- The branch includes the other Claude session's fixes, the shipping plan, and three hardening batches. Main was `ffac4a5` at verification. Do not reset to main or cherry-pick fixes already in the ancestry.
- No v1.4.0 tag existed when checked. No merge, tag, installer publication or GA certification is part of this handoff. Immediate objective: **a private Windows test installer**, not the complete encrypted multi-device launch.
- Read `SHIP-STATUS.md`, `RELEASING.md`, and `CLAUDE.md`. `SHIP-BACKLOG.md` is the larger B01–B44 roadmap; the original audit is historical, not the current implementation state.

## Other agent's work: reconciled and preserved

Verified every supplied commit with `git merge-base --is-ancestor <commit> HEAD`:

| Commit | Work already present |
|---|---|
| `463c991` | Windows development, ConPTY fix, brain export/import, agy CLI |
| `a799722` | v1.3.0 reconciliation merge |
| `0b9b391` | Duplicate backup UI removal, v1.4.0, cross-platform setup |
| `13f90de` | Linux/Wayland guidance |
| `21d1a6a` | Memory ingest bind recovery and enrichment retry backoff |
| `ac2edab` | External memory-ingest contract |

Code checks confirmed single-instance enforcement/`AIOS_ALLOW_MULTI`, ingest startup failure notification, bind retry/`lastError`, enrichment retry fields, 60-second retry sweep, and Settings error banner remain intact. Do not restore the removed duplicate backup files.

The other agent reported killing development Electron processes and recovering 15 personal-vault snippets, with 14 enriched afterward and a prior DB backup in its session temp. This is **reported external machine state**, not independently inspected or repeated here. Do not rerun recovery against the owner's database without permission.

Both reported integration bugs are resolved:

1. `native-smoke.cjs` explicitly exits 0 after PASS; lingering ConPTY handles no longer cause the parent timeout to report failure.
2. All new scripts/modules are committed with package.json/lockfile, including postinstall's `rebuild-native.cjs`, native probes, and both chat test files. Never commit just the manifest while leaving its scripts untracked.

## Codex changes, summarized

- `1892406`: authenticated loopback API; trusted/sandboxed renderer IPC; main-process Gemini; default-deny agent tools; bounded public URL fetch; restricted mobile proxy/terminals; mobile secure-credential migration; CI/tests.
- `a0c7087`: native-approved workspace/attachment paths; link checks; recoverable `.aios-trash`; bounded document child processes/ZIP preflight; officeparser 8; vulnerable XLS dependency removed.
- Commit accompanying this handoff: AI SDK 7/provider upgrades, compatibility streaming adapter, replacement text-chat session hook, cancellation/error tests, Electron 41.10.7/toolchain patches, native prebuild-aware setup/probe fix, refreshed documentation.

Compatibility notes: approve saved workspaces after restart; reselect changed attachments; convert XLS to XLSX/CSV; old mobile query-token authentication is unsupported; remote terminals default off; agent tools require approval. Existing visual style and saved text-message format remain. Official OpenAI documentation was checked to preserve Chat Completions and configured models, not migrate models.

## Evidence and limits

Passed locally on Windows x64/Node 22.14.0/Electron 41.10.7:

- `npm.cmd run check`: types, CJS syntax, 35 CommonJS tests, 10 TypeScript tests, SQLite CRUD, real native SQLite/PTY probe, production build.
- `npm.cmd run test:electron`: actual Chromium/API/IPC/gateway/file/parser smoke using a temporary profile.
- Full and production-only desktop npm audits: **zero findings**. Mobile unchanged: prior inventory 21 high, 1 critical, 17 moderate.

The initial forced node-pty source rebuild failed without Visual Studio; setup now uses its bundled prebuild when available and verifies it under Electron. Source-only platforms still require build tools. Native probe success requires both PASS and prompt exit 0.

Not verified: fresh-clone installation, packaged installers, real React chat interaction/save-load matrix, paid/live providers, physical phones, remote CI, macOS/Linux runtime. Large bundle warnings remain. Tests used synthetic data/temp profiles, not the owner's brain.

Still absent: encrypted database, encrypted device sync, independent mobile vault/offline capture, local OCR/video job pipeline, configurable provider tabs, signed updates/installers, and billing/launch. Parser children are not OS sandboxes; path checks are not race-proof against hostile same-user processes. LAN traffic still needs protected transport. Zero npm findings do not close those risks.

## Modular next tasks

### H01 — clean Windows install and private artifact (first)

Scope: setup/packaging only. Depends on this checkpoint being pushed.

1. Use a separate clean clone/worktree of this branch. Run `npm.cmd ci`, `npm.cmd run check`, `npm.cmd run test:electron`, `npm.cmd audit --audit-level=high`.
2. Run `npm.cmd run dist`, or manually dispatch Release on this branch **without a tag**. Record source SHA, runtime versions, artifact path and SHA-256.
3. Test installation, launch, quit/relaunch, and uninstall in a disposable Windows profile. Do not overwrite/delete the owner's vault.

Done: repeatable installer and pass/fail report; fix only reproduced packaging failures. No automatic publication. Rollback requires the prior binary and a verified separate vault backup; provider keys are machine-bound and are not restored by copying JSON between machines.

### H02 — chat/UI regression

Scope: `chatSession.ts`, `useChat.tsx`, `ThreadedChat.tsx`, `chat-stream.cjs`, tests. Depends on current dev build or H01.

Test main chat plus two concurrent threads, layout/fullscreen remount, stop/close mid-stream, new conversation, save/load with reused thread IDs, provider switching, errors and retries. Add a real React/Electron interaction test rather than only store tests. Use synthetic transports first; live provider/subscription checks require owner-approved accounts/costs.

Done: no cross-thread leakage, late replies after reset, lost restored messages, silent failures or duplicate sends. Preserve `0:/3:/d:` protocol and permissions. Deliver tests and exact remaining provider gaps.

### H03 — ingest regression for the preserved Claude fixes

Scope: ingest/memory code and dedicated fixtures. Use a temporary profile and synthetic snippets.

Occupy the port, verify bounded bind retries/visible lastError, free it and verify recovery. Simulate 429/503/network errors and retry sweep; prove capped attempts, successful retry-field reset, and no duplicate captures. Check authenticated examples in `MEMORY-INGEST.md` and installed-versus-dev single-instance behavior.

Done: repeatable regression evidence without paid Gemini use, personal DB edits, or broad Electron process kills.

### H04 — cross-platform evidence and release decision

Depends on H01–H03. Run Verify via PR and/or manually dispatch Release on the selected branch. Configured targets: Windows x64, macOS arm64, Linux x64; Intel Mac is disabled. Record unavailable platforms honestly. Audit the **full** desktop tree because Electron is a devDependency but ships in the app.

Done: owner reviews build/test evidence and approves the exact release SHA. Only then merge through the agreed process and create the approved tag. A feature-branch tag builds that branch's commit. A useful private unsigned v1.4 installer is not public secure-product readiness.

### H05 — mobile dependency migration (separate PR)

Scope: mobile package/lockfile and B06/B20. Audit, select a compatible Expo/RN migration, typecheck, build and exercise native SecureStore/pairing on devices. No forced dependency upgrades or typecheck-only readiness claims.

Done: mobile audit delta and native build/device evidence. Report required accounts/hardware; do not create accounts or upload store builds automatically.

### H06 — larger roadmap, only when the owner resumes it

Separate packets: B07 schema/transactions → B08 SQLCipher feasibility → B09 recovery/migration → B10 durable jobs/B11 offline capture. Encrypted sync, provider tabs and monetization follow their dependencies. They are not prerequisites for testing existing Windows fixes. Assign one bounded packet per agent with non-overlapping file ownership.

## Coordination

- Announce branch, SHA, task ID and files before editing. Check status; never reset/stash another agent's work. Commit one verified task at a time.
- Quit installed AIOS via its tray before normal development startup. Deliberate PowerShell coexistence: `$env:AIOS_ALLOW_MULTI='1'; npm.cmd run electron:dev`. Instances can still share data/ports; prefer disposable profiles.
- Never weaken auth, approval, audit or parsing/path limits for a green test. Respect the separately planned Linux capture port.
- Update status with files, commands/exit codes, artifacts, limitations and the next task. Do not begin account creation, billing or publication without owner direction.
