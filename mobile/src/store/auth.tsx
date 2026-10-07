import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { decode as atob } from 'base-64';
import { setCreds, rawPing, type Creds } from '../api/client';
import { createCredentialStorage, validateCreds } from './credentialStorage';

const STORAGE_KEY = 'aios.creds.v1';
const SECURE_KEY = 'aios.creds.v2';
const SECURE_OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const credentialStorage = createCredentialStorage({
  readSecure: () => SecureStore.getItemAsync(SECURE_KEY, SECURE_OPTIONS),
  writeSecure: value => SecureStore.setItemAsync(SECURE_KEY, value, SECURE_OPTIONS),
  deleteSecure: () => SecureStore.deleteItemAsync(SECURE_KEY, SECURE_OPTIONS),
  readLegacy: () => AsyncStorage.getItem(STORAGE_KEY),
  deleteLegacy: () => AsyncStorage.removeItem(STORAGE_KEY),
});

interface AuthState {
  creds: Creds | null;
  ready: boolean;
  pairWithCode: (code: string) => Promise<void>;
  pairWithUrl: (url: string, token: string) => Promise<void>;
  unpair: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

// Decode a pairing code (base64 of JSON {url, token}) produced by the desktop.
function decodePairingCode(code: string): Creds {
  let json: string;
  try {
    json = atob(code.trim());
  } catch {
    throw new Error('That does not look like a valid pairing code.');
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Pairing code is corrupt — copy it again from AIOS.');
  }
  if (!parsed?.url || !parsed?.token) throw new Error('Pairing code is missing the URL or token.');
  return { url: String(parsed.url), token: String(parsed.token) };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [creds, setCredsState] = useState<Creds | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const c = await credentialStorage.read();
        if (c) {
          setCreds(c);
          setCredsState(c);
        }
      } catch (e) {
        console.warn('Failed to load creds', e);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const persist = useCallback(async (c: Creds) => {
    c = validateCreds(c);
    // Verify the token actually works before saving.
    await rawPing(c.url, c.token);
    await credentialStorage.write(c);
    setCreds(c);
    setCredsState(c);
  }, []);

  const pairWithCode = useCallback(async (code: string) => {
    await persist(decodePairingCode(code));
  }, [persist]);

  const pairWithUrl = useCallback(async (url: string, token: string) => {
    if (!url.trim() || !token.trim()) throw new Error('Enter both a URL and a token.');
    await persist({ url: url.trim(), token: token.trim() });
  }, [persist]);

  const unpair = useCallback(async () => {
    await credentialStorage.clear();
    setCreds(null);
    setCredsState(null);
  }, []);

  return (
    <AuthContext.Provider value={{ creds, ready, pairWithCode, pairWithUrl, unpair }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
