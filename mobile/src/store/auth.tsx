import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { decode as atob } from 'base-64';
import { setCreds, rawPing, type Creds } from '../api/client';

const STORAGE_KEY = 'aios.creds.v1';

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
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const c = JSON.parse(raw) as Creds;
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
    // Verify the token actually works before saving.
    await rawPing(c.url, c.token);
    setCreds(c);
    setCredsState(c);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  }, []);

  const pairWithCode = useCallback(async (code: string) => {
    await persist(decodePairingCode(code));
  }, [persist]);

  const pairWithUrl = useCallback(async (url: string, token: string) => {
    if (!url.trim() || !token.trim()) throw new Error('Enter both a URL and a token.');
    await persist({ url: url.trim(), token: token.trim() });
  }, [persist]);

  const unpair = useCallback(async () => {
    setCreds(null);
    setCredsState(null);
    await AsyncStorage.removeItem(STORAGE_KEY);
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
