// Process isolation for availability, NOT an OS filesystem/network sandbox.
// No source paths, user secrets, NODE_OPTIONS, or inherited stdio go to parsers.
const { fork } = require('node:child_process');
const path = require('node:path');
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const CHAR_CAP = 24000;
const activeChildren = new Set();
function stopParsers() { for (const child of activeChildren) child.kill(); }

function parserEnvironment() {
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

// The deadline starts at fork(), so it must cover child spawn, runtime boot and
// the worker's require() of jsdom/officeparser/pdf-parse before any parsing
// happens. For small inputs that startup cost dominates, and it is paid in full
// on a cold process: measured on Windows/Electron 41, the first run of the
// parser suite took 35.2s where warm runs took ~3s. The previous 20s budget
// therefore failed outright on a cold start — reliably so on CI, which is never
// warm. 60s leaves headroom on slower runners. This is an upper bound on a
// failure path only; concurrency is already bounded by maxActive, so a generous
// deadline costs nothing in normal operation.
function createParserRunner({ timeoutMs = 60000, maxActive = 2, workerPath = path.join(__dirname, 'document-worker.cjs') } = {}) {
  let active = 0;
  return function parseDocument(kind, bytes, baseUrl) {
    if (!['.pdf', '.docx', '.xlsx', '.pptx', 'html'].includes(kind) || !Buffer.isBuffer(bytes)) return Promise.reject(new Error('Unsupported parser input.'));
    if (bytes.length > MAX_INPUT_BYTES || (kind === 'html' && bytes.length > 4 * 1024 * 1024)) return Promise.reject(Object.assign(new Error('Parser input exceeds the size limit.'), { status: 413 }));
    if (active >= maxActive) return Promise.reject(Object.assign(new Error('Document processing is busy. Please retry shortly.'), { status: 429 }));
    active++;
    return new Promise((resolve, reject) => {
      let child, timer, settled = false, released = false;
      const release = () => { if (!released) { released = true; active--; } };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const deliver = () => { if (error) reject(error); else resolve(result); };
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          child.once('exit', deliver);
          child.kill();
        } else { release(); deliver(); }
      };
      try {
        child = fork(workerPath, [], {
          execPath: process.execPath, execArgv: ['--max-old-space-size=192'],
          env: parserEnvironment(), serialization: 'advanced',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
        });
        activeChildren.add(child);
        child.once('error', error => { release(); finish(error); });
        child.once('exit', () => { activeChildren.delete(child); release(); finish(new Error('Document parser stopped unexpectedly. The file may exceed processing limits.')); });
        child.once('close', () => activeChildren.delete(child));
        child.once('message', message => {
          if (!message || message.error) return finish(new Error(message?.error || 'Invalid parser response.'));
          if (typeof message.text !== 'string' || message.text.length > CHAR_CAP ||
              typeof message.title !== 'string' || message.title.length > 512 ||
              !Number.isSafeInteger(message.charCount) || message.charCount < message.text.length ||
              !Number.isSafeInteger(message.pageCount) || message.pageCount < 0) return finish(new Error('Invalid parser response.'));
          finish(null, message);
        });
        // Report the configured budget — a hardcoded figure lies as soon as
        // timeoutMs is overridden, which the tests do.
        const limitLabel = `${Math.round(timeoutMs / 1000)} second`;
        timer = setTimeout(() => finish(Object.assign(new Error(`Document processing timed out (${limitLabel} limit).`), { status: 408 })), timeoutMs);
        child.send({ kind, bytes, baseUrl }, error => { if (error) finish(error); });
      } catch (error) { finish(error); }
    });
  };
}

module.exports = { parseDocument: createParserRunner(), createParserRunner, parserEnvironment, stopParsers, CHAR_CAP, MAX_INPUT_BYTES };
