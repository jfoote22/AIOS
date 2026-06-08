# Releasing AIOS

AIOS ships as a desktop app for **Windows, macOS (Apple Silicon + Intel), and
Linux**, built from this single codebase by [electron-builder](https://www.electron.build/).
Cross-platform builds run in GitHub Actions (`.github/workflows/release.yml`) so
you don't need a Mac to produce the Mac build.

## Cut a release

1. Bump the version in `package.json` (`"version": "1.0.0"`).
2. Commit, then tag and push:
   ```bash
   git commit -am "Release v1.0.0"
   git tag v1.0.0
   git push origin main --tags
   ```
3. The **Release** workflow builds every platform and creates a **draft** GitHub
   Release with the installers attached. Open it under the repo's *Releases* tab,
   check the files, and click **Publish**.

Artifacts produced:

| Platform | File |
|----------|------|
| Windows  | `AIOS-Setup-<version>.exe` (NSIS installer, x64) |
| macOS    | `AIOS-<version>-arm64.dmg` (Apple Silicon) + `.zip` |
| Linux    | `AIOS-<version>-x64.AppImage` + `.deb` |

> Intel Mac (`macos-13`/x64) builds are disabled for v1 — GitHub's Intel runners
> are scarce/being retired and queue indefinitely. Re-enable the `macos-13` line
> in `.github/workflows/release.yml` if you need an Intel `.dmg`.

You can also trigger the workflow manually from the **Actions** tab
(`workflow_dispatch`) to test a build without creating a release.

## Build locally (optional)

`npm run dist` builds installers for the **current** OS into `release/`.
Note: a macOS `.dmg` can only be built on macOS, and Windows `.exe` on Windows —
native modules (`better-sqlite3`, `node-pty`) are compiled per-OS and can't be
cross-compiled. That's why CI uses one runner per platform/architecture.

## App icon

electron-builder reads the icon from `build/icon.png`. Provide a square PNG
(**1024×1024** recommended); electron-builder converts it to `.ico` (Windows)
and `.icns` (macOS) automatically. Until `build/icon.png` exists, builds use the
default Electron icon.

## Code signing — currently OFF (v1 ships unsigned)

v1 is intentionally **unsigned** to ship at zero cost. What users see:

- **Windows:** SmartScreen — *"Windows protected your PC"* → **More info** →
  **Run anyway**.
- **macOS:** Gatekeeper blocks a double-click — users **right-click → Open**
  once (or run `xattr -cr /Applications/AIOS.app`). `mac.identity` is set to
  `null` in `package.json` so electron-builder ad-hoc signs (required for the app
  to launch on Apple Silicon) without a Developer ID.

### Turning signing on later (no restructure needed)

- **macOS** (removes the Gatekeeper warning): enrol in the
  [Apple Developer Program](https://developer.apple.com/programs/) ($99/yr),
  then in CI set secrets `CSC_LINK` (base64 of your `.p12`), `CSC_KEY_PASSWORD`,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Remove
  `"identity": null`, add `"notarize": true` under `mac`, and pass the env vars
  to the macOS build job.
- **Windows** (removes SmartScreen warning): obtain a code-signing certificate
  (OV ~\$200–500/yr, or EV for instant reputation), set `CSC_LINK` /
  `CSC_KEY_PASSWORD` secrets for the Windows job.
