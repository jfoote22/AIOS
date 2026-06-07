import { useEffect, useState } from 'react';
import { Sliders, KeyRound, Check, Trash2, ExternalLink, Lock, Cpu, RotateCcw, ShieldCheck, Terminal } from 'lucide-react';
import { PROVIDERS, type ProviderId, refreshConfigured, getConfigured, onConfiguredChange } from '../lib/providers';
import { setGeminiKey } from '../lib/ai';
import { type ModelSlot, SLOT_LABELS, getCachedModels, getDefaults, onModelsChange, refreshModels, saveModel, resetModel } from '../lib/models';
import {
  getAnthropicAuthMode, setAnthropicAuthMode, onAnthropicAuthModeChange,
  getOpenAIAuthMode, setOpenAIAuthMode, onOpenAIAuthModeChange,
  getGrokAuthMode, setGrokAuthMode, onGrokAuthModeChange,
  getGeminiAuthMode, setGeminiAuthMode, onGeminiAuthModeChange,
  type AnthropicAuthMode, type AuthMode,
} from '../lib/authMode';

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
    setRows(prev => {
      const current = prev[id] ?? { draft: '', saving: false, masked: '' };
      return { ...prev, [id]: { ...current, ...patch } };
    });

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

        <AnthropicAuthEditor />

        <OpenAIAuthEditor />

        <GrokAuthEditor />

        <GeminiAuthEditor />

        <ModelIdEditor />
      </div>
    </div>
  );
}

function OpenAIAuthEditor() {
  const [mode, setMode] = useState<AuthMode>('api');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    getOpenAIAuthMode().then(setMode).catch(() => {});
    return onOpenAIAuthModeChange(setMode);
  }, []);

  const choose = async (next: AuthMode) => {
    if (next === mode) return;
    setSaving(true); setMsg(null);
    try {
      await setOpenAIAuthMode(next);
      setMsg({ kind: 'ok', text: next === 'subscription' ? 'Switched to ChatGPT subscription auth.' : 'Switched to API key auth.' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || 'Failed to save.' });
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-10">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg"><ShieldCheck className="w-4 h-4 text-indigo-400" /></div>
        <div>
          <h3 className="text-lg font-bold">ChatGPT / OpenAI auth mode</h3>
          <p className="text-[11px] text-zinc-500">How AIOS authenticates the OpenAI button in DeepDives.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          onClick={() => choose('api')}
          disabled={saving}
          className={`text-left p-4 rounded-2xl border transition-colors ${
            mode === 'api'
              ? 'bg-indigo-600/10 border-indigo-500/40'
              : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className={`w-4 h-4 ${mode === 'api' ? 'text-indigo-400' : 'text-zinc-500'}`} />
            <p className={`text-sm font-bold ${mode === 'api' ? 'text-indigo-300' : 'text-zinc-200'}`}>API key</p>
            {mode === 'api' && <span className="ml-auto text-[10px] uppercase tracking-widest text-indigo-400 font-bold">Active</span>}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Uses the OpenAI API key above. Pay-per-token billing via <span className="font-mono">platform.openai.com</span>. Works without Codex CLI installed.
          </p>
        </button>

        <button
          onClick={() => choose('subscription')}
          disabled={saving}
          className={`text-left p-4 rounded-2xl border transition-colors ${
            mode === 'subscription'
              ? 'bg-indigo-600/10 border-indigo-500/40'
              : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <Terminal className={`w-4 h-4 ${mode === 'subscription' ? 'text-indigo-400' : 'text-zinc-500'}`} />
            <p className={`text-sm font-bold ${mode === 'subscription' ? 'text-indigo-300' : 'text-zinc-200'}`}>ChatGPT subscription</p>
            {mode === 'subscription' && <span className="ml-auto text-[10px] uppercase tracking-widest text-indigo-400 font-bold">Active</span>}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Uses your local <span className="font-mono">codex</span> CLI auth (ChatGPT Plus / Pro / Business / Enterprise). No API key needed; billed against your ChatGPT plan. Requires Codex CLI installed and signed in (<span className="font-mono">codex login</span>).
          </p>
        </button>
      </div>

      {msg && (
        <p className={`mt-3 text-[11px] ${msg.kind === 'err' ? 'text-red-400' : 'text-emerald-400'}`}>{msg.text}</p>
      )}

      {mode === 'subscription' && (
        <p className="mt-3 text-[10px] text-zinc-600 leading-relaxed">
          AIOS routes the OpenAI button through the Codex SDK, which picks up the auth from your <span className="font-mono">codex</span> CLI login. If responses fail, check that <span className="font-mono">codex --version</span> works and that you're signed into a plan that includes Codex (Plus / Pro / Business / Enterprise).
        </p>
      )}
    </div>
  );
}

function GrokAuthEditor() {
  const [mode, setMode] = useState<AuthMode>('api');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    getGrokAuthMode().then(setMode).catch(() => {});
    return onGrokAuthModeChange(setMode);
  }, []);

  const choose = async (next: AuthMode) => {
    if (next === mode) return;
    setSaving(true); setMsg(null);
    try {
      await setGrokAuthMode(next);
      setMsg({ kind: 'ok', text: next === 'subscription' ? 'Switched to Grok CLI subscription auth.' : 'Switched to xAI API key auth.' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || 'Failed to save.' });
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-10">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg"><ShieldCheck className="w-4 h-4 text-indigo-400" /></div>
        <div>
          <h3 className="text-lg font-bold">Grok auth mode</h3>
          <p className="text-[11px] text-zinc-500">How AIOS authenticates the Grok button in DeepDives.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          onClick={() => choose('api')}
          disabled={saving}
          className={`text-left p-4 rounded-2xl border transition-colors ${
            mode === 'api'
              ? 'bg-indigo-600/10 border-indigo-500/40'
              : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className={`w-4 h-4 ${mode === 'api' ? 'text-indigo-400' : 'text-zinc-500'}`} />
            <p className={`text-sm font-bold ${mode === 'api' ? 'text-indigo-300' : 'text-zinc-200'}`}>API key</p>
            {mode === 'api' && <span className="ml-auto text-[10px] uppercase tracking-widest text-indigo-400 font-bold">Active</span>}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Uses the xAI Grok API key above. Pay-per-token billing via <span className="font-mono">console.x.ai</span>. Works without the Grok CLI installed.
          </p>
        </button>

        <button
          onClick={() => choose('subscription')}
          disabled={saving}
          className={`text-left p-4 rounded-2xl border transition-colors ${
            mode === 'subscription'
              ? 'bg-indigo-600/10 border-indigo-500/40'
              : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <Terminal className={`w-4 h-4 ${mode === 'subscription' ? 'text-indigo-400' : 'text-zinc-500'}`} />
            <p className={`text-sm font-bold ${mode === 'subscription' ? 'text-indigo-300' : 'text-zinc-200'}`}>Grok subscription</p>
            {mode === 'subscription' && <span className="ml-auto text-[10px] uppercase tracking-widest text-indigo-400 font-bold">Active</span>}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Uses your local <span className="font-mono">grok</span> CLI auth (Grok Build). No API key needed; billed against your grok.com plan. Requires Grok Build installed and signed in (<span className="font-mono">grok login</span>).
          </p>
        </button>
      </div>

      {msg && (
        <p className={`mt-3 text-[11px] ${msg.kind === 'err' ? 'text-red-400' : 'text-emerald-400'}`}>{msg.text}</p>
      )}

      {mode === 'subscription' && (
        <p className="mt-3 text-[10px] text-zinc-600 leading-relaxed">
          AIOS routes the Grok button through the <span className="font-mono">grok</span> CLI headless mode, which picks up the auth from your Grok Build login. If responses fail, check that <span className="font-mono">grok --version</span> works in your terminal and that <span className="font-mono">grok models</span> shows you signed in. Override the binary path with <span className="font-mono">AIOS_GROK_BIN</span> or the model with <span className="font-mono">AIOS_GROK_MODEL</span>.
        </p>
      )}
    </div>
  );
}

function GeminiAuthEditor() {
  const [mode, setMode] = useState<AuthMode>('subscription');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    getGeminiAuthMode().then(setMode).catch(() => {});
    return onGeminiAuthModeChange(setMode);
  }, []);

  const choose = async (next: AuthMode) => {
    if (next === mode) return;
    setSaving(true); setMsg(null);
    try {
      await setGeminiAuthMode(next);
      setMsg({ kind: 'ok', text: next === 'subscription' ? 'Switched to Gemini CLI (Google login) auth.' : 'Switched to Gemini API key auth.' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || 'Failed to save.' });
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-10">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg"><ShieldCheck className="w-4 h-4 text-indigo-400" /></div>
        <div>
          <h3 className="text-lg font-bold">Gemini auth mode</h3>
          <p className="text-[11px] text-zinc-500">How AIOS authenticates the Gemini button in DeepDives.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          onClick={() => choose('api')}
          disabled={saving}
          className={`text-left p-4 rounded-2xl border transition-colors ${
            mode === 'api'
              ? 'bg-indigo-600/10 border-indigo-500/40'
              : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className={`w-4 h-4 ${mode === 'api' ? 'text-indigo-400' : 'text-zinc-500'}`} />
            <p className={`text-sm font-bold ${mode === 'api' ? 'text-indigo-300' : 'text-zinc-200'}`}>API key</p>
            {mode === 'api' && <span className="ml-auto text-[10px] uppercase tracking-widest text-indigo-400 font-bold">Active</span>}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Uses the Google Gemini API key above. Pay-per-token billing via <span className="font-mono">aistudio.google.com</span>. Works without the Gemini CLI installed.
          </p>
        </button>

        <button
          onClick={() => choose('subscription')}
          disabled={saving}
          className={`text-left p-4 rounded-2xl border transition-colors ${
            mode === 'subscription'
              ? 'bg-indigo-600/10 border-indigo-500/40'
              : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <Terminal className={`w-4 h-4 ${mode === 'subscription' ? 'text-indigo-400' : 'text-zinc-500'}`} />
            <p className={`text-sm font-bold ${mode === 'subscription' ? 'text-indigo-300' : 'text-zinc-200'}`}>Google login (CLI)</p>
            {mode === 'subscription' && <span className="ml-auto text-[10px] uppercase tracking-widest text-indigo-400 font-bold">Active</span>}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Uses your local <span className="font-mono">gemini</span> CLI auth (free with a personal Google account, or a paid Gemini plan for higher limits). No API key needed. Requires the Gemini CLI installed (<span className="font-mono">npm i -g @google/gemini-cli</span>) and signed in (run <span className="font-mono">gemini</span> once).
          </p>
        </button>
      </div>

      {msg && (
        <p className={`mt-3 text-[11px] ${msg.kind === 'err' ? 'text-red-400' : 'text-emerald-400'}`}>{msg.text}</p>
      )}

      {mode === 'subscription' && (
        <p className="mt-3 text-[10px] text-zinc-600 leading-relaxed">
          AIOS routes the Gemini button through the <span className="font-mono">gemini</span> CLI in non-interactive mode, which picks up the auth from your Google login. The model is chosen by your Google plan (the free tier currently routes to Gemini 3.x Flash); the Model ID field below only applies to <strong>API key</strong> mode. To force a specific CLI model use <span className="font-mono">AIOS_GEMINI_MODEL</span> (e.g. <span className="font-mono">gemini-3-flash-preview</span>, <span className="font-mono">gemini-2.5-flash</span>) — note the CLI's OAuth tier rejects API-only names like <span className="font-mono">gemini-flash-latest</span>. If responses fail, check that <span className="font-mono">gemini --version</span> works; override the binary path with <span className="font-mono">AIOS_GEMINI_BIN</span>.
        </p>
      )}
    </div>
  );
}

function AnthropicAuthEditor() {
  const [mode, setMode] = useState<AnthropicAuthMode>('api');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    getAnthropicAuthMode().then(setMode).catch(() => {});
    return onAnthropicAuthModeChange(setMode);
  }, []);

  const choose = async (next: AnthropicAuthMode) => {
    if (next === mode) return;
    setSaving(true); setMsg(null);
    try {
      await setAnthropicAuthMode(next);
      setMsg({ kind: 'ok', text: next === 'subscription' ? 'Switched to Claude Pro / Max subscription auth.' : 'Switched to API key auth.' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || 'Failed to save.' });
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-10">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg"><ShieldCheck className="w-4 h-4 text-indigo-400" /></div>
        <div>
          <h3 className="text-lg font-bold">Claude auth mode</h3>
          <p className="text-[11px] text-zinc-500">How AIOS authenticates the Claude Opus and Sonnet buttons in DeepDives.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          onClick={() => choose('api')}
          disabled={saving}
          className={`text-left p-4 rounded-2xl border transition-colors ${
            mode === 'api'
              ? 'bg-indigo-600/10 border-indigo-500/40'
              : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className={`w-4 h-4 ${mode === 'api' ? 'text-indigo-400' : 'text-zinc-500'}`} />
            <p className={`text-sm font-bold ${mode === 'api' ? 'text-indigo-300' : 'text-zinc-200'}`}>API key</p>
            {mode === 'api' && <span className="ml-auto text-[10px] uppercase tracking-widest text-indigo-400 font-bold">Active</span>}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Uses the Anthropic API key above. Pay-per-token billing via <span className="font-mono">console.anthropic.com</span>. Works without Claude Code installed.
          </p>
        </button>

        <button
          onClick={() => choose('subscription')}
          disabled={saving}
          className={`text-left p-4 rounded-2xl border transition-colors ${
            mode === 'subscription'
              ? 'bg-indigo-600/10 border-indigo-500/40'
              : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <div className="flex items-center gap-2 mb-2">
            <Terminal className={`w-4 h-4 ${mode === 'subscription' ? 'text-indigo-400' : 'text-zinc-500'}`} />
            <p className={`text-sm font-bold ${mode === 'subscription' ? 'text-indigo-300' : 'text-zinc-200'}`}>Claude subscription</p>
            {mode === 'subscription' && <span className="ml-auto text-[10px] uppercase tracking-widest text-indigo-400 font-bold">Active</span>}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Uses your local <span className="font-mono">claude</span> CLI auth (Claude Pro / Max). No API key needed; rate-limited by your subscription. Requires Claude Code installed and signed in (<span className="font-mono">claude /login</span>).
          </p>
        </button>
      </div>

      {msg && (
        <p className={`mt-3 text-[11px] ${msg.kind === 'err' ? 'text-red-400' : 'text-emerald-400'}`}>{msg.text}</p>
      )}

      {mode === 'subscription' && (
        <p className="mt-3 text-[10px] text-zinc-600 leading-relaxed">
          AIOS routes Claude Opus and Sonnet messages through the Claude Agent SDK, which picks up the auth from your <span className="font-mono">claude</span> CLI login. If responses fail, check that <span className="font-mono">claude --version</span> works in your terminal and that you're signed into a plan that includes Claude Code.
        </p>
      )}
    </div>
  );
}

function ModelIdEditor() {
  const [models, setModels] = useState<Record<ModelSlot, string>>(getCachedModels());
  const [defaults, setDefaults] = useState<Record<ModelSlot, string>>(getDefaults());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingSlot, setSavingSlot] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, { kind: 'ok' | 'err'; text: string }>>({});

  useEffect(() => {
    refreshModels().then(() => { setModels(getCachedModels()); setDefaults(getDefaults()); });
    const unsub = onModelsChange((c) => setModels(c));
    return unsub;
  }, []);

  const slots: ModelSlot[] = ['openai', 'claude', 'anthropic', 'grok', 'gemini'];

  const handleSave = async (slot: ModelSlot) => {
    const draft = (drafts[slot] ?? '').trim();
    if (!draft || draft === models[slot]) return;
    setSavingSlot(slot);
    setMsg(m => ({ ...m, [slot]: undefined as any }));
    try {
      await saveModel(slot, draft);
      setDrafts(d => ({ ...d, [slot]: '' }));
      setMsg(m => ({ ...m, [slot]: { kind: 'ok', text: 'Saved.' } }));
    } catch (e: any) {
      setMsg(m => ({ ...m, [slot]: { kind: 'err', text: e?.message || 'Failed to save.' } }));
    } finally { setSavingSlot(null); }
  };

  const handleReset = async (slot: ModelSlot) => {
    try {
      await resetModel(slot);
      setDrafts(d => ({ ...d, [slot]: '' }));
      setMsg(m => ({ ...m, [slot]: { kind: 'ok', text: 'Reset to default.' } }));
    } catch (e: any) {
      setMsg(m => ({ ...m, [slot]: { kind: 'err', text: e?.message || 'Failed to reset.' } }));
    }
  };

  return (
    <div className="mt-10">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg"><Cpu className="w-4 h-4 text-indigo-400" /></div>
        <div>
          <h3 className="text-lg font-bold">Model IDs</h3>
          <p className="text-[11px] text-zinc-500">Override the model used for each DeepDive chat button. Paste the literal model ID your provider expects.</p>
        </div>
      </div>
      <div className="space-y-3">
        {slots.map(slot => {
          const meta = SLOT_LABELS[slot];
          const current = models[slot] || '';
          const def = defaults[slot] || '';
          const draft = drafts[slot] ?? '';
          const m = msg[slot];
          const dirty = draft.trim() && draft.trim() !== current;
          return (
            <div key={slot} className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{meta.emoji}</span>
                  <div>
                    <p className="text-xs font-bold">{meta.provider} · <span className="text-indigo-300">{meta.variant}</span></p>
                    <p className="text-[10px] text-zinc-500">Current: <span className="font-mono text-zinc-300">{current || '(unset)'}</span>{def && current !== def && <span className="ml-2 text-zinc-600">default: <span className="font-mono">{def}</span></span>}</p>
                  </div>
                </div>
                {current && def && current !== def && (
                  <button onClick={() => handleReset(slot)} className="text-[10px] text-zinc-500 hover:text-indigo-400 flex items-center gap-1 uppercase tracking-widest">
                    <RotateCcw className="w-3 h-3" />Reset
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type="text" autoComplete="off" spellCheck={false}
                  value={draft}
                  onChange={(e) => { setDrafts(d => ({ ...d, [slot]: e.target.value })); setMsg(mm => ({ ...mm, [slot]: undefined as any })); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSave(slot); }}
                  placeholder={`New model ID (e.g. ${def || 'model-name'})`}
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                />
                <button
                  onClick={() => handleSave(slot)}
                  disabled={!dirty || savingSlot === slot}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-white text-xs font-bold uppercase tracking-wider transition-colors">
                  {savingSlot === slot ? 'Saving…' : 'Save'}
                </button>
              </div>
              {m && <p className={`mt-2 text-[11px] ${m.kind === 'err' ? 'text-red-400' : 'text-emerald-400'}`}>{m.text}</p>}
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-[10px] text-zinc-600 leading-relaxed">
        Model IDs are stored unencrypted at <span className="font-mono">%APPDATA%/AIOS/provider-models.json</span> (they aren't secrets). Changes apply on next message — no restart needed.
      </p>
    </div>
  );
}
