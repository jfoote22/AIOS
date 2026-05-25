import { useEffect, useState } from 'react';
import { Sliders, KeyRound, Check, Trash2, ExternalLink, Lock } from 'lucide-react';
import { PROVIDERS, type ProviderId, refreshConfigured, getConfigured, onConfiguredChange } from '../lib/providers';
import { setGeminiKey } from '../lib/ai';

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

interface RowState {
  draft: string;
  saving: boolean;
  message?: { kind: 'ok' | 'err'; text: string };
  masked: string;
}

export default function ModelsTab() {
  const [configured, setConfigured] = useState<Set<ProviderId>>(getConfigured());
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [secureAvailable, setSecureAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const unsub = onConfiguredChange(setConfigured);
    refreshConfigured();
    (async () => {
      if (window.aios?.isSecureStorageAvailable) {
        try { setSecureAvailable(await window.aios.isSecureStorageAvailable()); }
        catch { setSecureAvailable(false); }
      } else setSecureAvailable(false);
    })();
    return unsub;
  }, []);

  // Hydrate masked previews for configured providers.
  useEffect(() => {
    (async () => {
      if (!window.aios?.getProviderKey) return;
      const updates: Record<string, RowState> = {};
      for (const p of PROVIDERS) {
        if (!configured.has(p.id)) continue;
        try {
          const k = await window.aios.getProviderKey(p.id);
          updates[p.id] = { draft: '', saving: false, masked: maskKey(k) };
        } catch {}
      }
      setRows(prev => ({ ...prev, ...updates }));
    })();
  }, [configured]);

  const updateRow = (id: ProviderId, patch: Partial<RowState>) =>
    setRows(prev => ({ ...prev, [id]: { draft: '', saving: false, masked: '', ...prev[id], ...patch } }));

  const save = async (id: ProviderId) => {
    const row = rows[id];
    const draft = row?.draft?.trim();
    if (!draft) return;
    if (!window.aios?.setProviderKey) {
      updateRow(id, { message: { kind: 'err', text: 'Secure storage requires the desktop app.' } });
      return;
    }
    updateRow(id, { saving: true, message: undefined });
    try {
      await window.aios.setProviderKey(id, draft);
      if (id === 'gemini') setGeminiKey(draft);
      await refreshConfigured();
      updateRow(id, { saving: false, draft: '', masked: maskKey(draft), message: { kind: 'ok', text: 'Saved.' } });
    } catch (e: any) {
      updateRow(id, { saving: false, message: { kind: 'err', text: e?.message || 'Failed to save.' } });
    }
  };

  const clear = async (id: ProviderId) => {
    if (!confirm(`Remove the stored ${id} credential from this machine?`)) return;
    try {
      await window.aios?.clearProviderKey(id);
      if (id === 'gemini') setGeminiKey('');
      await refreshConfigured();
      updateRow(id, { masked: '', message: { kind: 'ok', text: 'Removed.' } });
    } catch (e: any) {
      updateRow(id, { message: { kind: 'err', text: e?.message || 'Failed to clear.' } });
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-2xl"><Sliders className="w-6 h-6 text-indigo-500" /></div>
          <div>
            <h2 className="text-3xl font-bold">Models</h2>
            <p className="text-xs text-zinc-500">Add a credential to activate a model across AIOS. Keys are encrypted with the OS keychain (DPAPI on Windows) and never leave this machine.</p>
          </div>
        </div>

        {secureAvailable === false && (
          <div className="mb-6 p-4 bg-amber-600/10 border border-amber-500/20 rounded-xl text-amber-300 text-xs">
            Secure storage isn't available in this environment. Keys cannot be saved until you launch via the desktop app.
          </div>
        )}

        <div className="space-y-4">
          {PROVIDERS.map(p => {
            const isOn = configured.has(p.id);
            const row = rows[p.id] ?? { draft: '', saving: false, masked: '' };
            return (
              <div key={p.id} className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${isOn ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-500 border border-zinc-700'}`}>
                      {isOn ? <Check className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />}
                    </div>
                    <div>
                      <p className="font-bold text-sm">{p.label}</p>
                      <p className="text-[11px] text-zinc-500">
                        {isOn
                          ? <>Configured · {row.masked || '••••'}{p.defaultModel ? ` · ${p.defaultModel}` : ''}</>
                          : p.isUrl ? `URL: ${p.keyHint}` : `Key format: ${p.keyHint}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noreferrer" className="text-[10px] text-zinc-500 hover:text-indigo-400 flex items-center gap-1 uppercase tracking-widest">
                        Get key <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    <div className={`px-2.5 py-1 rounded-md font-bold text-[10px] uppercase tracking-widest border ${isOn ? 'bg-emerald-600/10 border-emerald-500/20 text-emerald-400' : 'bg-zinc-800 border-zinc-700 text-zinc-500'}`}>
                      {isOn ? 'On' : 'Off'}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600" />
                    <input
                      type={p.isUrl ? 'text' : 'password'}
                      autoComplete="off" spellCheck={false}
                      value={row.draft}
                      onChange={(e) => updateRow(p.id, { draft: e.target.value, message: undefined })}
                      onKeyDown={(e) => { if (e.key === 'Enter') save(p.id); }}
                      placeholder={p.isUrl ? 'http://localhost:11434' : `Paste ${p.label} key (${p.keyHint})`}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 pl-9 pr-3 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                    />
                  </div>
                  <button
                    onClick={() => save(p.id)}
                    disabled={!row.draft?.trim() || row.saving || secureAvailable === false}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-white text-xs font-bold uppercase tracking-wider transition-colors">
                    {row.saving ? 'Saving…' : 'Save'}
                  </button>
                  {isOn && (
                    <button onClick={() => clear(p.id)} className="px-3 py-2 bg-zinc-800 hover:bg-red-600/30 rounded-lg text-zinc-400 hover:text-red-400 transition-colors" title="Remove key">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {row.message && (
                  <p className={`mt-2 text-[11px] ${row.message.kind === 'err' ? 'text-red-400' : 'text-emerald-400'}`}>{row.message.text}</p>
                )}
              </div>
            );
          })}
        </div>

        <p className="mt-8 text-[10px] text-zinc-600 leading-relaxed max-w-2xl">
          Credentials are stored encrypted at rest via Electron's safeStorage (Windows DPAPI). They're decrypted in the main process only and never exposed to the renderer in plaintext beyond the moment you paste them. AIOS never bundles or transmits your keys.
        </p>
      </div>
    </div>
  );
}
