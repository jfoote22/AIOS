import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredentialStorage, validateCreds } from '../mobile/src/store/credentialStorage.ts';

const sample = { url: 'http://192.168.1.2:8766', token: 'test-token' };
function fixture({ failWrite = false, failReadback = false } = {}) {
  let secure: string | null = null;
  let legacy: string | null = JSON.stringify(sample);
  const operations: string[] = [];
  const storage = createCredentialStorage({
    readSecure: async () => failReadback ? null : secure,
    writeSecure: async value => { operations.push('write'); if (failWrite) throw new Error('locked'); secure = value; },
    deleteSecure: async () => { operations.push('delete-secure'); secure = null; },
    readLegacy: async () => legacy,
    deleteLegacy: async () => { operations.push('delete-legacy'); legacy = null; },
  });
  return { storage, operations, state: () => ({ secure, legacy }) };
}

test('mobile migrates plaintext credentials only after verified secure storage', async () => {
  const f = fixture();
  assert.deepEqual(await f.storage.read(), sample);
  assert.equal(f.state().legacy, null);
  assert.deepEqual(JSON.parse(f.state().secure!), sample);
  assert.deepEqual(f.operations, ['write', 'delete-legacy']);
});

test('failed or unverifiable migration preserves legacy credentials for recovery', async () => {
  for (const options of [{ failWrite: true }, { failReadback: true }]) {
    const f = fixture(options);
    await assert.rejects(f.storage.read());
    assert.notEqual(f.state().legacy, null);
    assert.equal(f.operations.includes('delete-legacy'), false);
  }
});

test('unpair removes migration source before secure credentials', async () => {
  const f = fixture();
  await f.storage.clear();
  assert.deepEqual(f.operations, ['delete-legacy', 'delete-secure']);
  assert.equal(await f.storage.read(), null);
});

test('pairing rejects credentials in URLs and non-web protocols', () => {
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.com', 'https://example.com/path', 'http://example.com/?token=x']) {
    assert.throws(() => validateCreds({ ...sample, url }));
  }
  assert.deepEqual(validateCreds({ ...sample, url: sample.url + '/' }), sample);
});
