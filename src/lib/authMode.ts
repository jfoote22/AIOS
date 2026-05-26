import * as db from './db';

export type AnthropicAuthMode = 'api' | 'subscription';
export const ANTHROPIC_AUTH_MODE_KEY = 'anthropic-auth-mode';

type Listener = (mode: AnthropicAuthMode) => void;
const listeners = new Set<Listener>();

export async function getAnthropicAuthMode(): Promise<AnthropicAuthMode> {
  try {
    const v = await db.getMeta<AnthropicAuthMode>(ANTHROPIC_AUTH_MODE_KEY);
    return v === 'subscription' ? 'subscription' : 'api';
  } catch {
    return 'api';
  }
}

export async function setAnthropicAuthMode(mode: AnthropicAuthMode): Promise<void> {
  await db.setMeta(ANTHROPIC_AUTH_MODE_KEY, mode);
  listeners.forEach(fn => { try { fn(mode); } catch {} });
}

export function onAnthropicAuthModeChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
