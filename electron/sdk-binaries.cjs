// Native CLI binaries shipped by the agent SDKs, resolved for packaged builds.
//
// The Claude Agent SDK and the Codex SDK locate their bundled executables
// relative to their own module path. In a packaged app that path is inside
// app.asar, which Windows cannot execute from, so every spawn failed with
// "Claude Code native binary ... exists but failed to launch". electron-builder
// extracts executables to app.asar.unpacked; point the SDKs there.
const fs = require('node:fs');
const path = require('node:path');

function unpacked(p) {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function existing(p) {
  const u = unpacked(p);
  return fs.existsSync(u) ? u : undefined;
}

function packageDir(name) {
  try { return path.dirname(require.resolve(`${name}/package.json`)); }
  catch { return null; }
}

// undefined → let the SDK use its default lookup (development, or a platform
// package we do not recognize).
function claudeCodeExecutable() {
  const dir = packageDir(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`);
  if (!dir) return undefined;
  return existing(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'));
}

function codexExecutable() {
  const dir = packageDir(`@openai/codex-${process.platform}-${process.arch}`);
  if (!dir) return undefined;
  const vendor = path.join(dir, 'vendor');
  let triples = [];
  try { triples = fs.readdirSync(vendor); } catch { return undefined; }
  const bin = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const triple of triples) {
    const found = existing(path.join(vendor, triple, 'bin', bin));
    if (found) return found;
  }
  return undefined;
}

// The Claude Agent SDK with query() defaulting pathToClaudeCodeExecutable.
async function loadClaudeSdk() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const exe = claudeCodeExecutable();
  if (!exe) return sdk;
  const query = (args) => sdk.query({
    ...args,
    options: { pathToClaudeCodeExecutable: exe, ...(args?.options || {}) },
  });
  return { ...sdk, query };
}

function codexOptions() {
  const exe = codexExecutable();
  return exe ? { codexPathOverride: exe } : {};
}

module.exports = { loadClaudeSdk, codexOptions, claudeCodeExecutable, codexExecutable, unpacked };
