import { useEffect } from 'react';

/**
 * Dictation/automation compatibility (e.g. Wispr Flow): voice tools insert
 * their transcribed text by writing the field's value directly through OS
 * accessibility APIs or a simulated clipboard paste (Ctrl+V), bypassing or
 * racing React's synthetic event system. With a controlled input, React state
 * never learns about the injected text — the next render visibly wipes it,
 * and "send" reads an empty string.
 *
 * On top of value syncing, this hook defends FOCUS. Dictation overlays grab
 * OS focus while recording; when they close (hotkey release), Chromium can
 * return focus to <body> instead of the field the user was dictating into —
 * the field visibly "unselects" and the simulated paste has no target. We
 * remember the last chat field the user focused and put the cursor back
 * whenever focus is lost to nothing — unless a real user click moved it
 * somewhere on purpose.
 *
 * (Pair this with `app.setAccessibilitySupportEnabled(true)` in the Electron
 * main process — without it, Chromium's accessibility tree is built lazily
 * and the first focus after launch has nothing for the dictation tool to
 * target.)
 */

type TextEl = HTMLInputElement | HTMLTextAreaElement;

// Diagnostic logging. Mirrored to a file by the main process (console-message
// tap in electron/main.cjs → userData/dictation-debug.log).
const DEBUG = true;
function dbg(msg: string) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log(`[dictation] ${msg} | winFocus=${document.hasFocus()} active=${describe(document.activeElement)}`);
}
function describe(n: Element | null): string {
  if (!n) return 'null';
  const el = n as HTMLElement;
  return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ')[0] || ''}`;
}

// The chat input that most recently had focus — shared across all instances
// so the window-level handlers know where the cursor belongs.
let lastFocusedInput: TextEl | null = null;
// Timestamp of the last real pointer interaction. Blurs that closely follow a
// pointerdown are user-intent ("I clicked elsewhere"); blurs without one are
// programmatic (dictation overlay, accessibility action) and get reverted.
let lastPointerDownAt = 0;
let globalHandlersInstalled = false;

function caretToEnd(el: TextEl) {
  try {
    const end = el.value.length;
    el.setSelectionRange(end, end);
  } catch { /* not all input types support selection */ }
}

function restoreFocusIfLost(reason: string) {
  const el = lastFocusedInput;
  if (!el || !el.isConnected || el.disabled) { dbg(`restore(${reason}): skipped — el missing/disabled`); return; }
  const active = document.activeElement;
  if (active === el) { dbg(`restore(${reason}): no-op — already focused`); return; }
  // Only reclaim focus that fell to nothing — never steal from another control.
  if (active && active !== document.body && active !== document.documentElement) {
    dbg(`restore(${reason}): skipped — focus is on ${describe(active)}`);
    return;
  }
  el.focus();
  caretToEnd(el);
  dbg(`restore(${reason}): refocused field`);
}

function installGlobalHandlers() {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;
  window.addEventListener('pointerdown', () => { lastPointerDownAt = Date.now(); }, true);
  // When the app window regains OS focus (e.g. a dictation overlay closing),
  // Chromium sometimes lands focus on <body> instead of the field the user
  // was in. Put the cursor back where it was.
  window.addEventListener('focus', () => {
    dbg('window FOCUS');
    setTimeout(() => restoreFocusIfLost('window-focus'), 0);
  });
  window.addEventListener('blur', () => dbg('window BLUR'));
  document.addEventListener('paste', (e) => {
    const len = e.clipboardData?.getData('text')?.length ?? -1;
    dbg(`document PASTE (${len} chars) target=${describe(e.target as Element)}`);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) dbg(`Ctrl+V keydown target=${describe(e.target as Element)}`);
  }, true);
}

export function useExternalInputSync(
  ref: React.RefObject<TextEl | null>,
  value: string,
  setValue: (v: string) => void,
) {
  useEffect(() => {
    installGlobalHandlers();

    const sync = (origin: string) => {
      const el = ref.current;
      if (!el) return;
      if (el.value !== value) {
        dbg(`adopt(${origin}): "${value.slice(0, 30)}"(${value.length}) -> "${el.value.slice(0, 30)}"(${el.value.length})`);
        setValue(el.value);
      }
    };

    const onFocus = () => {
      const el = ref.current;
      if (!el) return;
      lastFocusedInput = el;
      dbg(`field FOCUS ${describe(el)}`);
      sync('focus');
      // Nudge the caret to the end. Emits a text-selection accessibility
      // event, prompting dictation tools to (re)target this field now rather
      // than on the next focus change.
      caretToEnd(el);
    };

    const onBlur = (evt: Event) => {
      const e = evt as FocusEvent;
      const sincePointer = Date.now() - lastPointerDownAt;
      dbg(`field BLUR -> ${describe(e.relatedTarget as Element)} (pointer ${sincePointer}ms ago)`);
      // Capture any text that landed just before focus was pulled away.
      sync('blur');
      // A blur with no recent pointer interaction wasn't the user clicking
      // away — it's a dictation overlay or accessibility action stealing
      // focus. Give the dust a moment to settle, then reclaim the cursor if
      // focus ended up on nothing.
      if (sincePointer > 500) {
        setTimeout(() => restoreFocusIfLost('post-blur'), 60);
      }
    };

    const onInput = () => sync('input-event');

    const el = ref.current;
    el?.addEventListener('input', onInput);
    el?.addEventListener('focus', onFocus);
    el?.addEventListener('blur', onBlur);

    // Fallback for injection paths that fire no DOM events at all. Also runs
    // when the field is the remembered target but focus was knocked off it —
    // dictation tools may still write into the unfocused element.
    const id = window.setInterval(() => {
      const current = ref.current;
      if (!current) return;
      if (document.activeElement === current || lastFocusedInput === current) sync('poll');
    }, 100);

    return () => {
      el?.removeEventListener('input', onInput);
      el?.removeEventListener('focus', onFocus);
      el?.removeEventListener('blur', onBlur);
      window.clearInterval(id);
    };
  }, [ref, value, setValue]);
}
