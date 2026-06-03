// Cross-component change bus for saved DeepDive sessions.
// Emitted when a DeepDive is saved or deleted so other tabs (e.g. Second Brain)
// reload reactively instead of relying on a manual refresh. Mirrors
// onImportsChange / emitImportsChange in lib/imports.

type Listener = () => void;
const deepDiveListeners = new Set<Listener>();

export function onDeepDivesChange(fn: Listener): () => void {
  deepDiveListeners.add(fn);
  return () => deepDiveListeners.delete(fn);
}

export function emitDeepDivesChange(): void {
  for (const fn of deepDiveListeners) {
    try { fn(); } catch (e) { console.error('deepdive change listener failed', e); }
  }
}
