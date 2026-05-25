// Shared encrypted key store used by main.cjs and api-server.cjs.
// Keys are stored encrypted via Electron safeStorage (DPAPI on Windows).

const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

function getKeysFilePath() {
  return path.join(app.getPath('userData'), 'provider-keys.json');
}

function readKeyStore() {
  try {
    const file = getKeysFilePath();
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.error('Failed to read key store:', e);
    return {};
  }
}

function writeKeyStore(store) {
  fs.writeFileSync(getKeysFilePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function getProviderKey(providerId) {
  if (!safeStorage.isEncryptionAvailable()) return '';
  const store = readKeyStore();
  const encB64 = store[providerId];
  if (!encB64) return '';
  try {
    const buf = Buffer.from(encB64, 'base64');
    return safeStorage.decryptString(buf);
  } catch (e) {
    console.error(`Failed to decrypt key for ${providerId}:`, e);
    return '';
  }
}

function setProviderKey(providerId, key) {
  const store = readKeyStore();
  if (!key) {
    delete store[providerId];
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system.');
    }
    const enc = safeStorage.encryptString(key);
    store[providerId] = enc.toString('base64');
  }
  writeKeyStore(store);
}

function listConfiguredProviders() {
  return Object.keys(readKeyStore());
}

module.exports = { getProviderKey, setProviderKey, listConfiguredProviders };
