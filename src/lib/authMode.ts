import * as db from './db';

export type AuthMode = 'api' | 'subscription';
// Backwards-compat alias — earlier callers imported this name.
export type AnthropicAuthMode = AuthMode;

export const ANTHROPIC_AUTH_MODE_KEY = 'anthropic-auth-mode';
export const OPENAI_AUTH_MODE_KEY = 'openai-auth-mode';
export const GROK_AUTH_MODE_KEY = 'grok-auth-mode';
export const GEMINI_AUTH_MODE_KEY = 'gemini-auth-mode';

type Listener = (mode: AuthMode) => void;
const anthropicListeners = new Set<Listener>();
const openaiListeners = new Set<Listener>();
const grokListeners = new Set<Listener>();
const geminiListeners = new Set<Listener>();

async function readMode(key: string, fallback: AuthMode = 'api'): Promise<AuthMode> {
  try {
    const v = await db.getMeta<AuthMode>(key);
    if (v === 'subscription') return 'subscription';
    if (v === 'api') return 'api';
    return fallback;
  } catch {
    return fallback;
  }
}

async function writeMode(key: string, mode: AuthMode, listeners: Set<Listener>): Promise<void> {
  await db.setMeta(key, mode);
  listeners.forEach(fn => { try { fn(mode); } catch {} });
}

export const getAnthropicAuthMode = () => readMode(ANTHROPIC_AUTH_MODE_KEY);
export const setAnthropicAuthMode = (mode: AuthMode) => writeMode(ANTHROPIC_AUTH_MODE_KEY, mode, anthropicListeners);
export function onAnthropicAuthModeChange(fn: Listener): () => void {
  anthropicListeners.add(fn);
  return () => { anthropicListeners.delete(fn); };
}

export const getOpenAIAuthMode = () => readMode(OPENAI_AUTH_MODE_KEY);
export const setOpenAIAuthMode = (mode: AuthMode) => writeMode(OPENAI_AUTH_MODE_KEY, mode, openaiListeners);
export function onOpenAIAuthModeChange(fn: Listener): () => void {
  openaiListeners.add(fn);
  return () => { openaiListeners.delete(fn); };
}

export const getGrokAuthMode = () => readMode(GROK_AUTH_MODE_KEY);
export const setGrokAuthMode = (mode: AuthMode) => writeMode(GROK_AUTH_MODE_KEY, mode, grokListeners);
export function onGrokAuthModeChange(fn: Listener): () => void {
  grokListeners.add(fn);
  return () => { grokListeners.delete(fn); };
}

// Gemini defaults to subscription (the free `gemini` CLI Google-account login)
// since that's the lowest-friction path — no API key required to get started.
export const getGeminiAuthMode = () => readMode(GEMINI_AUTH_MODE_KEY, 'subscription');
export const setGeminiAuthMode = (mode: AuthMode) => writeMode(GEMINI_AUTH_MODE_KEY, mode, geminiListeners);
export function onGeminiAuthModeChange(fn: Listener): () => void {
  geminiListeners.add(fn);
  return () => { geminiListeners.delete(fn); };
}
