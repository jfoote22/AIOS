// Multi-provider registry. Phase 1: Gemini wired for snippet analysis;
// OpenAI/Anthropic/Grok/Ollama placeholders ready for Phase 2 (DeepDive chat).

export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'grok' | 'deepgram' | 'replicate' | 'ollama';

export interface ProviderDef {
  id: ProviderId;
  label: string;
  keyHint: string;
  /** True if the "key" is actually a URL (e.g. Ollama). */
  isUrl?: boolean;
  /** Where to get a key. */
  url?: string;
  /** Default model to surface in UI. */
  defaultModel?: string;
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'gemini',    label: 'Google Gemini',   keyHint: 'AIza…',  url: 'https://aistudio.google.com/apikey',      defaultModel: 'gemini-2.5-flash' },
  { id: 'openai',    label: 'OpenAI',          keyHint: 'sk-…',   url: 'https://platform.openai.com/api-keys',    defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic',       keyHint: 'sk-ant-', url: 'https://console.anthropic.com/settings/keys', defaultModel: 'claude-sonnet-4-6' },
  { id: 'grok',      label: 'xAI Grok',        keyHint: 'xai-…',  url: 'https://console.x.ai/',                   defaultModel: 'grok-2' },
  { id: 'deepgram',  label: 'Deepgram',        keyHint: 'dg_…',   url: 'https://console.deepgram.com/',           defaultModel: 'nova-2' },
  { id: 'replicate', label: 'Replicate',       keyHint: 'r8_…',   url: 'https://replicate.com/account/api-tokens' },
  { id: 'ollama',    label: 'Ollama (local)',  keyHint: 'http://localhost:11434', isUrl: true, url: 'https://ollama.com', defaultModel: 'llama3.2' },
];

export function getProvider(id: ProviderId): ProviderDef | undefined {
  return PROVIDERS.find(p => p.id === id);
}

// --- Renderer-side cache of which providers have credentials configured. ---
let configured: Set<ProviderId> = new Set();
const listeners = new Set<(set: Set<ProviderId>) => void>();

export function getConfigured(): Set<ProviderId> {
  return new Set(configured);
}

export function isConfigured(id: ProviderId): boolean {
  return configured.has(id);
}

export function setConfigured(ids: ProviderId[]): void {
  configured = new Set(ids);
  for (const fn of listeners) fn(new Set(configured));
}

export function onConfiguredChange(fn: (set: Set<ProviderId>) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export async function refreshConfigured(): Promise<void> {
  if (!window.aios?.listProviders) return;
  try {
    const list = (await window.aios.listProviders()) as ProviderId[];
    setConfigured(list);
  } catch (e) {
    console.error('Failed to list configured providers:', e);
  }
}
