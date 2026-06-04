// Cross-component change bus for captured snippets.
// Emitted when a snippet is captured, edited, or deleted so other tabs (e.g.
// Second Brain) reload reactively instead of relying on a manual refresh.
// Mirrors onDeepDivesChange / emitDeepDivesChange in lib/deepdiveStore.
//
// The optional `newId` detail carries the id of a freshly captured snippet so a
// listener (Second Brain) can auto-focus it once the graph rebuilds.

export interface SnippetsChangeDetail {
  /** Id of a freshly captured snippet, so a listener can auto-focus it. */
  newId?: string;
  /** Which tab emitted this, so a tab can ignore its own writes (avoids a
   *  self-triggered vault reload racing an in-flight operation). */
  source?: 'snipping' | 'secondbrain';
}
type Listener = (detail?: SnippetsChangeDetail) => void;
const snippetListeners = new Set<Listener>();

export function onSnippetsChange(fn: Listener): () => void {
  snippetListeners.add(fn);
  return () => { snippetListeners.delete(fn); };
}

export function emitSnippetsChange(detail?: SnippetsChangeDetail): void {
  for (const fn of snippetListeners) {
    try { fn(detail); } catch (e) { console.error('snippet change listener failed', e); }
  }
}
