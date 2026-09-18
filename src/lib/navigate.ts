// Programmatic tab switching. Lets non-sibling components (e.g. SecondBrain
// asking to jump into DeepDives) trigger navigation without prop-drilling.

export type NavTarget = 'home' | 'deepdives' | 'snipping' | 'secondbrain' | 'terminal' | 'kanban' | 'hermes' | 'settings';

/** Optional payload carried alongside a navigation. `focusId` lets the caller
 *  ask the destination tab to select a specific node — e.g. jumping into Second
 *  Brain and highlighting a particular neuron (id in graph form: `snip:<id>`). */
export interface NavOptions { focusId?: string; }

type Listener = (target: NavTarget, opts?: NavOptions) => void;
const listeners = new Set<Listener>();

export function navigateTo(target: NavTarget, opts?: NavOptions): void {
  for (const fn of listeners) fn(target, opts);
}

export function onNavigate(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
