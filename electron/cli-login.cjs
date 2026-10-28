// Sign-in for the subscription CLIs AIOS drives (Claude Code, Codex, Grok
// Build). When a request fails because the CLI isn't signed in, the model
// router calls ensureLogin(): the CLI's own login runs, the browser opens on
// its sign-in page, and the request continues once the user finishes.

const { spawn } = require('node:child_process');
const os = require('node:os');
const { Notification, shell } = require('electron');
const { claudeCodeExecutable, codexExecutable } = require('./sdk-binaries.cjs');
const { resolveGrokBin } = require('./cli-bins.cjs');

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function run(bin, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(bin, args, { cwd: os.tmpdir(), windowsHide: true, env: process.env, shell: false }); }
    catch { return resolve({ code: -1, out: '' }); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const FLOWS = {
  claude: {
    label: 'Claude',
    bin: () => claudeCodeExecutable() || 'claude',
    async signedIn() {
      const { out } = await run(this.bin(), ['auth', 'status']);
      try { return JSON.parse(out.slice(out.indexOf('{'))).loggedIn === true; } catch { return null; }
    },
    loginArgs: ['auth', 'login', '--claudeai'],
    // Claude Code opens the browser itself.
    opensBrowser: true,
  },
  chatgpt: {
    label: 'ChatGPT',
    bin: () => codexExecutable() || 'codex',
    async signedIn() {
      const { code, out } = await run(this.bin(), ['login', 'status']);
      if (/not logged in/i.test(out)) return false;
      return code === 0 && /logged in/i.test(out) ? true : null;
    },
    loginArgs: ['login'],
    opensBrowser: true,
  },
  grok: {
    label: 'Grok',
    bin: () => resolveGrokBin(),
    // No status command; the router recognizes Grok's "Not signed in" error.
    signedIn: async () => null,
    notSignedInError: /not signed in/i,
    // Device-code flow: Grok prints the URL and code, AIOS opens the browser.
    loginArgs: ['login', '--device-code'],
    opensBrowser: false,
  },
};

const pending = new Map();

function notify(body) {
  try {
    if (Notification.isSupported()) new Notification({ title: 'AIOS', body }).show();
  } catch { /* notifications are best effort */ }
}

function startLogin(id) {
  const flow = FLOWS[id];
  return new Promise((resolve) => {
    let child;
    try { child = spawn(flow.bin(), flow.loginArgs, { cwd: os.tmpdir(), windowsHide: true, env: process.env, shell: false }); }
    catch { return resolve(false); }
    let out = '';
    let opened = false;
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, LOGIN_TIMEOUT_MS);
    const onData = (d) => {
      out += d;
      if (opened || flow.opensBrowser) return;
      const url = /https:\/\/\S+/.exec(out.replace(/\x1b\[[0-9;]*m/g, ''))?.[0];
      if (!url) return;
      opened = true;
      shell.openExternal(url).catch(() => {});
      const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(out)?.[0];
      notify(`Sign in to ${flow.label} in the browser window that just opened${code ? ` (code ${code})` : ''}. AIOS continues once you're signed in.`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    if (flow.opensBrowser) notify(`Sign in to ${flow.label} in your browser. AIOS continues once you're signed in.`);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      notify(ok ? `Signed in to ${flow.label}.` : `${flow.label} sign-in didn't finish. AIOS will ask again next time.`);
      resolve(ok);
    });
  });
}

/** Has a sign-in flow for this connection id? */
function hasFlow(id) {
  return Object.prototype.hasOwnProperty.call(FLOWS, id);
}

/**
 * Was this failure caused by the CLI being signed out? Checks the CLI's own
 * status when it has one, else the error text.
 */
async function isSignedOut(id, error) {
  const flow = FLOWS[id];
  if (!flow) return false;
  if (flow.notSignedInError?.test(String(error?.message || error))) return true;
  return (await flow.signedIn()) === false;
}

/** Start (or join) the sign-in flow; resolves true once signed in. */
function ensureLogin(id) {
  if (!pending.has(id)) {
    const p = startLogin(id).finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return pending.get(id);
}

module.exports = { hasFlow, isSignedOut, ensureLogin, FLOWS };
