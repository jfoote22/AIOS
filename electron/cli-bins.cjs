// Locations of the subscription CLIs AIOS drives (Grok Build, Antigravity).
// Shared by the chat routes in api-server.cjs and the model router.
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Resolve the `grok` CLI binary. The Electron process can have a stale PATH
// (the user often installs grok mid-session, which appends ~/.grok/bin to the
// *user* PATH only). So we check an explicit override, then the canonical
// install location, then fall back to the bare command for the OS to resolve.
let _grokBinCache;
function resolveGrokBin() {
  if (_grokBinCache !== undefined) return _grokBinCache;
  const override = (process.env.AIOS_GROK_BIN || '').trim();
  const candidates = [];
  if (override) candidates.push(override);
  const home = os.homedir();
  if (home) {
    candidates.push(path.join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'));
  }
  for (const c of candidates) {
    try { if (fsSync.existsSync(c)) { _grokBinCache = c; return c; } } catch {}
  }
  // Last resort: let the OS PATH-resolve it (works if grok is on PATH).
  _grokBinCache = process.platform === 'win32' ? 'grok.exe' : 'grok';
  return _grokBinCache;
}

// Resolve the Antigravity CLI binary (`agy`), Google's replacement for the old
// `gemini` CLI. Google decommissioned the Gemini CLI for Pro/Ultra/free
// (subscription) users on 2026-06-18; Antigravity CLI is the successor. It is a
// native binary (NOT an npm package) installed by
//   irm https://antigravity.google/cli/install.ps1 | iex   (Windows)
//   curl -fsSL https://antigravity.google/cli/install.sh | bash   (Unix)
// and dropped at %LOCALAPPDATA%\agy\bin\agy.exe (Windows) or ~/.local/bin/agy.
// Same stale-PATH problem as the others: that dir may not be on the Electron
// process PATH, so check an explicit override, then the canonical install
// location, then fall back to the bare command for the OS to resolve. Because
// it's a real .exe (not a .cmd shim), the agent route can spawn it with
// shell:false and pass argv directly — no shell-quoting needed.
// AIOS_AGY_BIN is the preferred override; AIOS_GEMINI_BIN is honored for
// back-compat with older configs.
let _geminiBinCache;
function resolveGeminiBin() {
  if (_geminiBinCache !== undefined) return _geminiBinCache;
  const override = (process.env.AIOS_AGY_BIN || process.env.AIOS_GEMINI_BIN || '').trim();
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'agy.exe' : 'agy';
  const candidates = [];
  if (override) candidates.push(override);
  const home = os.homedir();
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || (home && path.join(home, 'AppData', 'Local'));
    if (localAppData) candidates.push(path.join(localAppData, 'agy', 'bin', 'agy.exe'));
  } else if (home) {
    candidates.push(path.join(home, '.local', 'bin', 'agy'));
  }
  for (const c of candidates) {
    try { if (fsSync.existsSync(c)) { _geminiBinCache = c; return c; } } catch {}
  }
  // Last resort: let the OS PATH-resolve it (works if agy is on PATH).
  _geminiBinCache = exe;
  return _geminiBinCache;
}

module.exports = { resolveGrokBin, resolveGeminiBin };
