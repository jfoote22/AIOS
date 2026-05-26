// Cross-component handoff: Second Brain → DeepDives.
// When the user clicks "DeepDive" on a neuron's detail panel, a seed is set;
// DeepDivesTab consumes it on mount / on change and pre-fills the chat input.

export interface DeepDiveSeed {
  title: string;        // short label for the source node (used in the prompt header)
  source: string;       // human-readable origin ("Imported ChatGPT chat", "Snippet", etc.)
  body: string;         // the content to drop into context (already truncated)
}

let current: DeepDiveSeed | null = null;
type Listener = (seed: DeepDiveSeed | null) => void;
const listeners = new Set<Listener>();

export function setSeed(seed: DeepDiveSeed): void {
  current = seed;
  for (const fn of listeners) fn(seed);
}

export function consumeSeed(): DeepDiveSeed | null {
  const s = current;
  current = null;
  return s;
}

export function peekSeed(): DeepDiveSeed | null {
  return current;
}

export function onSeedChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
