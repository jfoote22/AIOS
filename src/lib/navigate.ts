// Programmatic tab switching. Lets non-sibling components (e.g. SecondBrain
// asking to jump into DeepDives) trigger navigation without prop-drilling.

export type NavTarget = 'home' | 'deepdives' | 'snipping' | 'secondbrain' | 'terminal' | 'kanban' | 'hermes' | 'settings';

type Listener = (target: NavTarget) => void;
const listeners = new Set<Listener>();

export function navigateTo(target: NavTarget): void {
  for (const fn of listeners) fn(target);
}

export function onNavigate(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
