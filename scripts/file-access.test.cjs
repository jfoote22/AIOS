const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { FileAccessPolicy, fileAccess, absolutePath } = require('../electron/file-access.cjs');
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aios-path-test-')));
  const policy = new FileAccessPolicy();
  const editor = path.join(root, '.claude');
  await fs.mkdir(editor);
  return { root, editor, policy };
}
test('editor/project paths require grants and stay in approved scopes', async () => {
  const { root, editor, policy } = await fixture();
  await assert.rejects(policy.write(editor, 'test.md', 'denied'), { status: 403 });
  await policy.grantWorkspace(root);
  await assert.rejects(policy.write(editor, '../outside.md', 'denied'), { status: 403 });
  await assert.rejects(policy.write(root, 'outside.md', 'denied'), { status: 403 });
  await assert.rejects(policy.write(root, '.aios/other.json', '{}', { scope: 'project' }), { status: 403 });
  await policy.write(root, '.aios/project.json', '{"ok":true}', { scope: 'project' });
  assert.equal((await policy.read(root, '.aios/project.json', { scope: 'project' })).toString(), '{"ok":true}');
  await assert.rejects(policy.grantWorkspace(path.parse(root).root), { status: 403 });
});
test('bounded writes, no-clobber creation/rename, atomic replacement, and recoverable deletion', async () => {
  const { root, editor, policy } = await fixture();
  await policy.grantWorkspace(root);
  await policy.write(editor, 'one.md', 'original');
  await assert.rejects(policy.write(editor, 'one.md', 'lost', { exclusive: true }), { code: 'EEXIST' });
  await assert.rejects(policy.write(editor, 'one.md', 'toolong', { maxBytes: 2 }), { status: 413 });
  assert.equal((await policy.read(editor, 'one.md')).toString(), 'original');
  await assert.rejects(policy.read(editor, 'one.md', { maxBytes: 2 }), { status: 413 });
  await policy.write(editor, 'one.md', 'replacement');
  await policy.write(editor, 'two.md', 'other');
  await assert.rejects(policy.rename(editor, 'one.md', 'two.md'), { status: 409 });
  await policy.rename(editor, 'one.md', 'nested/renamed.md');
  const trash = await policy.trash(editor, 'nested');
  assert.equal((await fs.readFile(path.join(trash, 'renamed.md'), 'utf8')), 'replacement');
  await assert.rejects(fs.stat(path.join(editor, 'nested')), { code: 'ENOENT' });
  await assert.rejects(policy.trash(editor, ''), { status: 403 });
});
test('junction/symlink escapes, hard links, and replaced roots are denied', async () => {
  const { root, editor, policy } = await fixture();
  const other = await fixture();
  await policy.grantWorkspace(root);
  await fs.writeFile(path.join(other.root, 'secret.md'), 'synthetic secret');
  await fs.symlink(other.root, path.join(editor, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(policy.read(editor, 'escape/secret.md'), { status: 403 });
  await assert.rejects(policy.write(editor, 'escape/secret.md', 'bad'), { status: 403 });
  await assert.rejects(policy.trash(editor, 'escape'), { status: 403 });
  await fs.link(path.join(other.root, 'secret.md'), path.join(editor, 'hard.md'));
  await assert.rejects(policy.read(editor, 'hard.md'), { status: 403 });
  await assert.rejects(policy.write(editor, 'hard.md', 'bad'), { status: 403 });
  assert.equal(await fs.readFile(path.join(other.root, 'secret.md'), 'utf8'), 'synthetic secret');
  await fs.rename(root, root + '-retained');
  await fs.mkdir(root);
  await assert.rejects(policy.assertWorkspace(root), { status: 403 });
});
test('attachment authority is distinct, selected bytes are bounded and changed files need reselection', async () => {
  const { root, policy } = await fixture();
  const file = path.join(root, 'note.txt');
  await fs.writeFile(file, 'hello');
  await policy.grantWorkspace(root);
  await assert.rejects(policy.readAttachment(file), { status: 403 });
  await policy.grantFile(file);
  assert.equal((await policy.readAttachment(file)).toString(), 'hello');
  await assert.rejects(policy.readAttachment(file, 2), { status: 413 });
  await fs.writeFile(file, 'changed content');
  await assert.rejects(policy.readAttachment(file), { status: 403 });
  await policy.grantFile(file);
  assert.equal((await policy.readAttachment(file)).toString(), 'changed content');
  await assert.rejects(new FileAccessPolicy().readAttachment(file), { status: 403 });
});
test('unsupported/binary files and unselected images never reach vision', async () => {
  const { root } = await fixture();
  const { extractFile } = require('../electron/extract.cjs');
  let calls = 0;
  const vision = async () => { calls++; return 'synthetic OCR'; };
  const image = path.join(root, 'image.png');
  await fs.writeFile(image, 'fixture image');
  await assert.rejects(extractFile(image, vision), { status: 403 });
  assert.equal(calls, 0);
  await fileAccess.grantFile(image);
  assert.equal((await extractFile(image, vision)).text, 'synthetic OCR');
  assert.equal(calls, 1);
  for (const [name, contents, pattern] of [['old.xls', 'fixture', /Legacy/], ['program.exe', 'fixture', /Unsupported/], ['binary.txt', '\0binary', /Binary/]]) {
    const file = path.join(root, name);
    await fs.writeFile(file, contents);
    await fileAccess.grantFile(file);
    await assert.rejects(extractFile(file), pattern);
  }
});
test('Windows device, network, alternate-stream, and ambiguous paths fail closed', { skip: process.platform !== 'win32' }, () => {
  for (const value of ['\\\\server\\share\\file', '\\\\?\\C:\\file', 'C:\\file:stream', 'C:\\NUL.txt', 'C:\\folder.\\file']) assert.throws(() => absolutePath(value), { status: 403 });
});
test('attachment backpressure applies before reading or invoking vision', async () => {
  const { root } = await fixture();
  const image = path.join(root, 'queued.png');
  await fs.writeFile(image, 'synthetic fixture');
  await fileAccess.grantFile(image);
  const { extractFile } = require('../electron/extract.cjs');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = extractFile(image, () => gate);
  const second = extractFile(image, () => gate);
  try { await assert.rejects(extractFile(image, () => gate), { status: 429 }); }
  finally { release('processed'); }
  await Promise.all([first, second]);
  assert.equal((await extractFile(image, async () => 'retry')).text, 'retry');
});
