// Shared encrypted key store used by main.cjs and api-server.cjs.
// Keys are stored encrypted via Electron safeStorage (DPAPI on Windows).

const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

function isSecureStorageAvailable() {
  return safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text');
}

function getKeysFilePath() {
  return path.join(app.getPath('userData'), 'provider-keys.json');
}

function readKeyStore() {
  try {
    const file = getKeysFilePath();
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' ||
        Object.values(parsed).some(value => typeof value !== 'string')) {
      throw new Error('Invalid credential store format.');
    }
    return parsed;
  } catch (e) {
    throw new Error('Cannot read the credential store. Restore a backup before saving new credentials.', { cause: e });
  }
}

function writeKeyStore(store) {
  const file = getKeysFilePath();
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function getProviderKey(providerId) {
  if (!isSecureStorageAvailable()) return '';
  try {
    const store = readKeyStore();
    const encB64 = store[providerId];
    if (!encB64) return '';
    const buf = Buffer.from(encB64, 'base64');
    return safeStorage.decryptString(buf);
  } catch (e) {
    // Keep the app usable for recovery without logging the stored material.
    console.error(`Credential unavailable for ${providerId}: ${e.message}`);
    return '';
  }
}

function setProviderKey(providerId, key) {
  const store = readKeyStore();
  if (!key) {
    delete store[providerId];
  } else {
    if (!isSecureStorageAvailable()) {
      throw new Error('Secure storage is not available on this system.');
    }
    const enc = safeStorage.encryptString(key);
    store[providerId] = enc.toString('base64');
  }
  writeKeyStore(store);
}

function listConfiguredProviders() {
  try { return Object.keys(readKeyStore()); }
  catch { return []; } // Reads fail closed; writes still refuse to overwrite corruption.
}

module.exports = { getProviderKey, setProviderKey, listConfiguredProviders, isSecureStorageAvailable };
