// Renderer-side cache of user-configured model IDs.
// Slots match ThreadedChat's ModelProvider semantics.

export type ModelSlot = 'openai' | 'claude' | 'anthropic' | 'grok' | 'hermes';

export const SLOT_LABELS: Record<ModelSlot, { provider: string; variant: string; emoji: string }> = {
  openai:    { provider: 'OpenAI',    variant: 'ChatGPT', emoji: '🧠' },
  claude:    { provider: 'Anthropic', variant: 'Opus',    emoji: '🤖' },
  anthropic: { provider: 'Anthropic', variant: 'Sonnet',  emoji: '🎯' },
  grok:      { provider: 'xAI',       variant: 'Grok',    emoji: '⚡' },
  hermes:    { provider: 'Hermes',    variant: 'Gateway', emoji: 'H' },
};

let cache: Record<ModelSlot, string> = { openai: '', claude: '', anthropic: '', grok: '', hermes: '' };
let defaults: Record<ModelSlot, string> = { openai: '', claude: '', anthropic: '', grok: '', hermes: '' };
const listeners = new Set<(c: Record<ModelSlot, string>) => void>();

export function getCachedModels(): Record<ModelSlot, string> {
  return { ...cache };
}

export function getDefaults(): Record<ModelSlot, string> {
  return { ...defaults };
}

export function onModelsChange(fn: (c: Record<ModelSlot, string>) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notify() {
  for (const fn of listeners) fn(getCachedModels());
}

export async function refreshModels(): Promise<void> {
  if (!window.aios?.getModels) return;
  try {
    const [m, d] = await Promise.all([
      window.aios.getModels(),
      window.aios.getModelDefaults?.() ?? Promise.resolve({}),
    ]);
    cache = { ...cache, ...(m as any) };
    defaults = { ...defaults, ...(d as any) };
    notify();
  } catch (e) {
    console.error('Failed to load model IDs:', e);
  }
}

export async function saveModel(slot: ModelSlot, modelId: string): Promise<void> {
  if (!window.aios?.setModel) throw new Error('Desktop app required.');
  const next = await window.aios.setModel(slot, modelId);
  cache = { ...cache, ...(next as any) };
  notify();
}

export async function resetModel(slot: ModelSlot): Promise<void> {
  if (!window.aios?.resetModel) throw new Error('Desktop app required.');
  const next = await window.aios.resetModel(slot);
  cache = { ...cache, ...(next as any) };
  notify();
}
