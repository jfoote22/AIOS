// Settings → Hermes quick setup: paste the Mac's address once (Tailscale IP,
// hostname or URL) and AIOS points the API server (port 8642) and the
// dashboard (port 9119) at it. The dashboard login is saved encrypted and used
// to sign in to the embedded dashboard automatically (electron/hermes-view.cjs).

import { useEffect, useState } from 'react';
import { CheckCircle2, Link2, Loader2, Save } from 'lucide-react';
import { apiUrl, initApiBase } from '../lib/apiBase';

interface ConnectionState {
  baseUrl: string;
  dashboardUrl: string;
  dashboardUser: string;
  hasDashboardPassword: boolean;
}

const inputClass = 'w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500';

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

export default function HermesConnectionCard() {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    try {
      await initApiBase();
      const cfg = await (await fetch(apiUrl('/api/hermes/config'))).json();
      setState(cfg);
      setHost((h) => h || hostOf(cfg.dashboardUrl || cfg.baseUrl || ''));
      setUser((u) => u || cfg.dashboardUser || '');
    } catch { /* the card stays in its loading state */ }
  };
  useEffect(() => { load(); }, []);

  const save = async (body: Record<string, unknown>, done: string) => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl('/api/hermes/connection'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not save.');
      setState((s) => ({ ...(s as ConnectionState), ...data }));
      setPassword('');
      window.dispatchEvent(new Event('aios:hermes-config-changed'));
      setMsg({ ok: true, text: done });
    } catch (e: any) { setMsg({ ok: false, text: e?.message || 'Could not save.' }); }
    finally { setSaving(false); }
  };

  return (
    <div className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl space-y-3">
      <div className="flex items-start gap-3">
        <Link2 className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
        <div>
          <h3 className="text-sm font-bold">Connect to Hermes</h3>
          <p className="text-[11px] text-zinc-500">
            Paste the Mac's address once — its Tailscale IP works at home and away. AIOS uses it for the API server
            (port 8642) and the dashboard (port 9119).
          </p>
        </div>
      </div>

      <div>
        <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Mac address</label>
        <input className={inputClass} value={host} onChange={(e) => setHost(e.target.value)} placeholder="100.97.211.120" spellCheck={false} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Dashboard username</label>
          <input className={inputClass} value={user} onChange={(e) => setUser(e.target.value)} placeholder="justin" autoComplete="off" spellCheck={false} />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Dashboard password</label>
          <input
            className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off"
            placeholder={state?.hasDashboardPassword ? 'Saved — type to replace' : 'Signs you in automatically'}
          />
        </div>
      </div>

      {state && (
        <p className="text-[10px] text-zinc-600 font-mono break-all">
          API server: {state.baseUrl || '—'} · Dashboard: {state.dashboardUrl || '—'}
        </p>
      )}
      {msg && (
        <p className={`flex items-center gap-1.5 text-[11px] ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {msg.ok && <CheckCircle2 className="w-3.5 h-3.5" />}{msg.text}
        </p>
      )}

      <div className="flex items-center justify-between">
        {state?.hasDashboardPassword ? (
          <button
            onClick={() => save({ clearDashboardLogin: true }, 'Dashboard login removed.')}
            disabled={saving}
            className="text-[11px] text-zinc-500 hover:text-red-400"
          >
            Forget dashboard login
          </button>
        ) : <span />}
        <button
          onClick={() => save({ host: host.trim(), dashboardUser: user.trim(), dashboardPassword: password }, 'Saved. The Hermes tab and Howie now use this address.')}
          disabled={saving || !host.trim()}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-[11px] font-bold uppercase tracking-wider"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
        </button>
      </div>
    </div>
  );
}
