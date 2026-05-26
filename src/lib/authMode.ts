import * as db from './db';

export type AuthMode = 'api' | 'subscription';
// Backwards-compat alias — earlier callers imported this name.
export type AnthropicAuthMode = AuthMode;

export const ANTHROPIC_AUTH_MODE_KEY = 'anthropic-auth-mode';
export const OPENAI_AUTH_MODE_KEY = 'openai-auth-mode';

type Listener = (mode: AuthMode) => void;
const anthropicListeners = new Set<Listener>();
const openaiListeners = new Set<Listener>();

async function readMode(key: string): Promise<AuthMode> {
  try {
    const v = await db.getMeta<AuthMode>(key);
    return v === 'subscription' ? 'subscription' : 'api';
  } catch {
    return 'api';
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
