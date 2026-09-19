# Building and releasing AIOS

Updated 2026-09-19. Package version is **1.4.0**; no v1.4.0 tag or published installer is claimed by this checkpoint. Start with [the agent handoff](docs/SHIP-HANDOFF.md) and [verified implementation status](docs/SHIP-STATUS.md).

## Private Windows test build first

Use a separate clean clone of `feat/shipping-foundation`, with Node 22.14 or newer in the Node 22 line. Quit the installed AIOS through its tray: the single-instance lock otherwise focuses that copy instead of starting development.

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run test:electron
npm.cmd audit --audit-level=high
npm.cmd run dist
Get-FileHash -Algorithm SHA256 release/AIOS-Setup-1.4.0.exe
```

Run each command only after the previous command succeeds. Record the source SHA and artifact hash. Test in a disposable Windows profile before using the owner's vault. Back up the existing vault separately; exports and the database remain plaintext, while provider credentials are machine-bound. Do not delete or reset app data during an upgrade test.

Native setup rebuilds SQLite for Electron and uses node-pty's bundled prebuild when available; otherwise it compiles from source. Source builds require platform build tools. The native probe must print PASS **and exit 0**, not time out. See H01–H03 for installer, chat and memory-ingest acceptance checks.

Alternatively, in GitHub Actions choose **Release → Run workflow → feat/shipping-foundation**. A manual non-tag run uploads build artifacts without creating a release. This checkpoint has not dispatched that workflow or verified its artifacts.

## Platforms and outputs

| Configured target | Output |
|---|---|
| Windows x64 | `AIOS-Setup-<version>.exe` |
| macOS Apple Silicon | `AIOS-<version>-arm64.dmg` and ZIP |
| Linux x64 | AppImage and DEB |

Build native artifacts on their target OS. Intel Mac is currently disabled in the workflow; do not advertise it as tested. `npm run dist` builds the current host target into `release/`. Large-bundle warnings are not installer validation.

## Controlled release after testing

1. Complete H01–H04, review platform/UI/ingest evidence, and obtain the owner's approval of the exact source commit and release channel.
2. Recheck version consistency in package.json/lockfile and confirm the proposed tag does not already exist.
3. Merge the reviewed branch through the agreed process. Do not assume main already contains feature-branch changes.
4. Only after approval, create the exact tag on the approved SHA and push **that tag only**. For example, `git tag v1.4.0 <approved-sha>` then `git push origin v1.4.0`. Do not push all local tags.
5. The tag-triggered Release workflow checks, audits, packages and creates a **draft** GitHub Release after successful builds. Inspect artifacts/checksums and install-test them before owner-approved publication.

A tag created on the feature branch builds that commit. A successful audit/build does not make the encrypted multi-device product complete. The existing workflow audits production dependencies; also run the full audit because Electron is classified as dev but ships in the app.

## Signing and distribution limits

Current configuration has no configured production signing/notarization credentials. Treat generated installers as unsigned/ad-hoc-signed private test artifacts, with expected OS trust warnings. Do not promise public frictionless installation or recommend disabling system-wide protections.

Public distribution requires reviewed Windows signing and macOS signing/notarization, appropriate developer identities, update/recovery testing, privacy/security documentation, and the remaining shipping gates. Accounts and paid services require owner involvement; no new accounts were created for this checkpoint.

electron-builder uses `build/icon.png` when present; otherwise the default Electron icon may appear. Verify branding in the actual installer.
