// The Hermes Agent web dashboard (`hermes dashboard`), shown inside the Hermes
// tab. The page itself lives in a native view owned by Electron
// (electron/hermes-view.cjs); this component only reserves the space, keeps the
// view's bounds in sync with it, and hides the view whenever it isn't visible.
// Native views paint above the DOM, so anything that must overlay this area
// (menus, dialogs) has to hide the view first.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, Play, RefreshCw } from 'lucide-react';
import { getMeta, setMeta } from '../lib/db';

const URL_KEY = 'hermes:dashboard-url';
const DASHBOARD_PORT = 9119;

/** The dashboard on the same host as the configured Hermes API, else local. */
export function defaultDashboardUrl(apiBaseUrl: string): string {
  try {
    const host = new URL(apiBaseUrl).hostname;
    if (host) return `http://${host}:${DASHBOARD_PORT}`;
  } catch { /* fall through */ }
  return `http://127.0.0.1:${DASHBOARD_PORT}`;
}

interface Props {
  /** True when the Hermes tab is showing and the dashboard view is selected. */
  visible: boolean;
  apiBaseUrl: string;
}

export default function HermesDashboard({ visible, apiBaseUrl }: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.aios?.hermesView;

  useEffect(() => {
    (async () => {
      const saved = await getMeta<string>(URL_KEY).catch(() => null);
      const initial = saved || defaultDashboardUrl(apiBaseUrl);
      setUrl(initial);
      setDraft(initial);
    })();
    // Only the first config load picks the default; later edits are the user's.
  }, []);

  const bounds = useCallback(() => {
    const r = slotRef.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  }, []);

  // Show/hide the native view with the tab, and load the current URL.
  useEffect(() => {
    if (!bridge) return;
    if (!visible || !url) { bridge.hide(); return; }
    const b = bounds();
    if (!b) return;
    setLoading(true);
    setError(null);
    bridge.show(url, b)
      // On failure hide the view so the help text underneath is readable.
      .then((r) => { if (!r.ok) { bridge.hide(); setError(r.error || 'Could not load the dashboard.'); } })
      .catch((e) => { bridge.hide(); setError(e?.message || 'Could not load the dashboard.'); })
      .finally(() => setLoading(false));
  }, [bridge, visible, url, bounds]);

  // Keep the view glued to the slot as the window or sidebar resizes.
  useEffect(() => {
    if (!bridge || !visible || !slotRef.current) return;
    const sync = () => { const b = bounds(); if (b) bridge.setBounds(b); };
    const ro = new ResizeObserver(sync);
    ro.observe(slotRef.current);
    window.addEventListener('resize', sync);
    return () => { ro.disconnect(); window.removeEventListener('resize', sync); };
  }, [bridge, visible, bounds]);

  // Never leave the view floating over another tab after unmount.
  useEffect(() => () => bridge?.hide(), [bridge]);

  const open = () => {
    const next = draft.trim();
    try { new URL(next); } catch { setError('Enter a full URL, e.g. http://127.0.0.1:9119'); return; }
    setUrl(next);
    setMeta(URL_KEY, next).catch(() => {});
  };

  if (!bridge) {
    return <div className="p-6 text-sm text-zinc-500">The embedded dashboard is only available in the desktop app.</div>;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="h-12 px-4 border-b border-zinc-800 flex items-center gap-2 shrink-0">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
          spellCheck={false}
          className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-indigo-500/60"
          placeholder="http://127.0.0.1:9119"
        />
        <button onClick={open} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white" title="Open">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        </button>
        <button onClick={() => bridge.reload()} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white" title="Reload">
          <RefreshCw className="w-4 h-4" />
        </button>
        <button onClick={() => window.open(url, '_blank')} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white" title="Open in browser">
          <ExternalLink className="w-4 h-4" />
        </button>
      </div>
      {/* The native view is laid over this slot; the message shows through
          only until (or if) the dashboard fails to load. */}
      <div ref={slotRef} className="flex-1 min-h-0 relative">
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <div className="max-w-md text-sm text-zinc-400 space-y-2">
              <p className="text-red-300">Couldn't reach the Hermes dashboard at {url}.</p>
              <p className="text-xs text-zinc-500">{error}</p>
              <p className="text-xs text-zinc-500">
                Start it on that machine with <code className="text-zinc-300">hermes dashboard --no-open</code>.
                To reach it from another computer, bind it to that machine's address with
                {' '}<code className="text-zinc-300">--host</code> and set a dashboard password first (Hermes requires one off-localhost).
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
