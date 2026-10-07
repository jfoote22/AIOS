const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function denied(message = 'Select or approve this folder in AIOS before accessing it.') {
  return Object.assign(new Error(message), { status: 403 });
}
function absolutePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) throw denied('An absolute local path is required.');
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')) throw denied('Network, device, and alternate-stream paths are not supported.');
    for (const segment of value.slice(3).split(/[\\/]/)) {
      if (segment === '.' || segment === '..' || !segment) continue;
      if (/[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) throw denied('Ambiguous or reserved Windows path.');
    }
  }
  return path.resolve(value);
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function sameFile(a, b) {
  // Windows path-stat can report dev=0 while handle-stat reports the volume ID.
  // Compare full-width file IDs; paths are already constrained to local drives.
  const sameDevice = a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0n || b.dev === 0n));
  return sameDevice && a.ino === b.ino;
}

// Inspect EVERY existing path component, not just the final file. On Windows
// lstat detects junctions as links. Missing suffixes are allowed only for writes.
async function inspectPath(value, allowMissing = false) {
  const target = absolutePath(value);
  const parsed = path.parse(target);
  let current = parsed.root;
  let last = await fs.lstat(current, { bigint: true });
  const segments = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    try { last = await fs.lstat(current, { bigint: true }); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return { target, stat: null };
      throw error;
    }
    if (last.isSymbolicLink()) throw denied('Symbolic links and junctions are not allowed in AIOS file operations.');
    if (i < segments.length - 1 && !last.isDirectory()) throw denied('A path component is not a directory.');
  }
  if (last.isFile() && last.nlink > 1) throw denied('Hard-linked files are not supported here.');
  return { target, stat: last };
}

async function boundedRead(target, maxBytes, expected) {
  const before = await inspectPath(target);
  if (!before.stat.isFile()) throw denied('Only regular files can be read.');
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink > 1 || !sameFile(before.stat, stat) ||
        (expected && (!sameFile(expected, stat) || expected.size !== stat.size || expected.mtimeNs !== stat.mtimeNs))) {
      throw denied('The selected file changed. Select it again.');
    }
    if (stat.size > maxBytes) throw Object.assign(new Error(`File exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB limit.`), { status: 413 });
    const chunks = [];
    let length = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, maxBytes + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > maxBytes) throw Object.assign(new Error('File grew beyond the size limit.'), { status: 413 });
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await inspectPath(target);
    const final = await handle.stat({ bigint: true });
    if (!sameFile(stat, after.stat) || stat.size !== final.size || stat.mtimeNs !== final.mtimeNs) throw denied('File changed while reading; select it again.');
    return Buffer.concat(chunks, length);
  } finally { await handle.close(); }
}

class FileAccessPolicy {
  constructor() { this.workspaces = new Map(); this.files = new Map(); }
  async grantWorkspace(value) {
    const { target, stat } = await inspectPath(value);
    if (!stat.isDirectory() || target === path.parse(target).root) throw denied('Select a project folder, not a filesystem root.');
    this.workspaces.set(target, stat);
    return target;
  }
  async assertWorkspace(value) {
    const target = absolutePath(value);
    const entry = [...this.workspaces.entries()].filter(([root]) => inside(root, target)).sort((a, b) => b[0].length - a[0].length)[0];
    if (!entry) throw denied();
    const [root, granted] = entry;
    const current = await inspectPath(root);
    if (!current.stat.isDirectory() || !sameFile(granted, current.stat)) throw denied('Approved folder changed; approve it again.');
    await inspectPath(target, true);
    return target;
  }
  async grantFile(value) {
    const { target, stat } = await inspectPath(value);
    if (!stat.isFile()) throw denied('Select a regular file.');
    this.files.set(target, stat);
    return target;
  }
  async readAttachment(value, maxBytes = 50 * 1024 * 1024) {
    const target = absolutePath(value);
    const granted = this.files.get(target);
    if (!granted) throw denied('Select this attachment using the AIOS file picker first.');
    return boundedRead(target, maxBytes, granted);
  }
  async target(rootValue, relative = '', scope = 'claude') {
    const root = await this.assertWorkspace(rootValue);
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw denied('A relative path is required.');
    const target = absolutePath(path.resolve(root, relative));
    if (!inside(root, target)) throw denied('Path escapes the approved root.');
    if (scope === 'claude' && !target.split(/[\\/]/).includes('.claude')) throw denied('Editor operations must stay within .claude.');
    if (scope === 'project' && target !== path.join(root, '.aios', 'project.json')) throw denied('Invalid project snapshot path.');
    await inspectPath(target, true);
    return target;
  }
  async read(root, relative, { scope = 'claude', maxBytes = 2 * 1024 * 1024 } = {}) {
    const target = await this.target(root, relative, scope);
    return boundedRead(target, maxBytes);
  }
  async mkdir(root, relative) {
    const target = await this.target(root, relative);
    await fs.mkdir(target, { recursive: true });
    await this.target(root, relative);
    return target;
  }
  async write(root, relative, content, { scope = 'claude', exclusive = false, maxBytes = 2 * 1024 * 1024 } = {}) {
    if (typeof content !== 'string') throw Object.assign(new Error('Text content is required.'), { status: 400 });
    if (Buffer.byteLength(content) > maxBytes) throw Object.assign(new Error('Content exceeds the write limit.'), { status: 413 });
    const target = await this.target(root, relative, scope);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.target(root, relative, scope);
    const temporary = path.join(path.dirname(target), `.aios-write-${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await this.target(root, relative, scope);
      if (exclusive) {
        // link is an atomic no-replace publication; unlinking the temp restores
        // a single link. Existing files are never truncated by Create.
        await fs.link(temporary, target);
        await fs.unlink(temporary);
      } else await fs.rename(temporary, target);
    } catch (error) {
      // Leave a failed write recoverable. Do not unlink a path after its parent
      // may have been replaced by another process.
      throw error;
    }
    return target;
  }
  async trash(root, relative) {
    const target = await this.target(root, relative);
    if (target === absolutePath(root)) throw denied('Cannot delete the editor root.');
    try { await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const workspace = [...this.workspaces.keys()].filter(item => inside(item, target)).sort((a, b) => b.length - a.length)[0];
    const trash = path.join(workspace, '.aios-trash');
    await inspectPath(trash, true);
    await fs.mkdir(trash, { recursive: true });
    await inspectPath(trash);
    await this.target(root, relative);
    const destination = path.join(trash, `${crypto.randomUUID()}-${path.basename(target)}`);
    await fs.rename(target, destination);
    return destination;
  }
  async rename(root, from, to) {
    const source = await this.target(root, from);
    const destination = await this.target(root, to);
    if (source === absolutePath(root) || destination === absolutePath(root)) throw denied('Cannot rename the editor root.');
    try { await fs.lstat(destination); throw Object.assign(new Error('Destination already exists.'), { status: 409 }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await this.target(root, from); await this.target(root, to);
    await fs.rename(source, destination);
    return destination;
  }
}

module.exports = { FileAccessPolicy, fileAccess: new FileAccessPolicy(), inspectPath, absolutePath, inside };
