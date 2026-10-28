// Settings → Models: pick one default model for everything, optionally a
// different model per task, the embeddings provider, and add OpenAI-compatible
// connections (Ollama, LM Studio, OpenRouter, DeepSeek, Hugging Face, ...).
// Backed by electron/model-router.cjs via src/lib/modelRouting.ts.

import { useEffect, useState } from 'react';
import { Check, Loader2, Plus, Route, Search, Star, Trash2, X, Zap } from 'lucide-react';
import {
  type AiTask, type Connection, type RoutingView,
  getRouting, onRoutingChange, refreshRouting, saveRouting,
  saveConnection, removeConnection, detectModels, testModel,
} from '../lib/modelRouting';

const PRESETS = [
  { label: 'Ollama', id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, hint: 'Local models. Run `ollama pull qwen3` first.' },
  { label: 'LM Studio', id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', needsKey: false, hint: 'Start the local server in LM Studio first.' },
  { label: 'OpenRouter', id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, hint: 'One key for hundreds of models, including free ones.' },
  { label: 'DeepSeek', id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true, hint: 'Models: deepseek-chat, deepseek-reasoner.' },
  { label: 'Hugging Face', id: 'huggingface', baseUrl: 'https://router.huggingface.co/v1', needsKey: true, hint: 'Use a Hugging Face access token.' },
  { label: 'Other', id: '', baseUrl: '', needsKey: false, hint: 'Any server with an OpenAI-compatible /v1 API.' },
];

const selectClass = 'w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500';
const inputClass = 'w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500';

function authLabel(c: Connection): string {
  if (!c.available) return 'Not set up';
  if (c.auth === 'subscription') return 'Subscription login';
  if (c.auth === 'api') return 'API key';
  return c.custom ? c.baseUrl || 'Custom' : 'Connected';
}

/** <option>s for every connection's models, grouped; unusable ones disabled. */
function ModelOptions({ connections, vision = false }: { connections: Connection[]; vision?: boolean }) {
  return (
    <>
      {connections.map((c) => (
        <optgroup key={c.id} label={`${c.label}${c.available ? '' : ' — not set up'}`}>
          {c.models.map((m) => {
            const unusable = !c.available || (vision && !c.vision);
            return (
              <option key={`${c.id}:${m.id}`} value={`${c.id}:${m.id}`} disabled={unusable}>
                {c.label} · {m.label || m.id}{vision && !c.vision ? ' (can’t read images)' : ''}
              </option>
            );
          })}
        </optgroup>
      ))}
    </>
  );
}

function refLabel(view: RoutingView, ref: string): string {
  const i = ref.indexOf(':');
  const conn = view.connections.find((c) => c.id === (i < 0 ? ref : ref.slice(0, i)));
  if (!conn) return ref;
  const model = conn.models.find((m) => m.id === ref.slice(i + 1));
  return model ? `${conn.label} · ${model.label || model.id}` : conn.label;
}

export default function ModelRoutingPanel() {
  const [view, setView] = useState<RoutingView | null>(getRouting());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onRoutingChange(setView);
    refreshRouting();
    return unsub;
  }, []);

  const save = async (patch: Parameters<typeof saveRouting>[0]) => {
    setError(null);
    try { await saveRouting(patch); } catch (e: any) { setError(e?.message || 'Could not save.'); }
  };

  if (!view) {
    return <div className="mb-8 p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl text-xs text-zinc-500">Loading model settings…</div>;
  }

  const connected = view.connections.filter((c) => c.available);
  const automatic = connected[0] ? `${connected[0].label} (first connected)` : 'nothing connected yet';
  const defaultName = view.default ? refLabel(view, view.default) : automatic;

  return (
    <div className="mb-10 space-y-4">
      <div className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl">
        <div className="flex items-center gap-2 mb-1">
          <Route className="w-4 h-4 text-indigo-400" />
          <h3 className="text-sm font-bold">Which model does what</h3>
        </div>
        <p className="text-[11px] text-zinc-500 mb-4">
          One model can run everything. Pick a default, and only change a task if you want a different model for it.
        </p>

        <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1.5">Default model</label>
        <select className={selectClass} value={view.default} onChange={(e) => save({ default: e.target.value })}>
          <option value="">Automatic — {automatic}</option>
          <ModelOptions connections={view.connections} />
        </select>

        <div className="mt-5 divide-y divide-zinc-800/80 border-t border-zinc-800/80">
          {view.taskList.map((t) => (
            <div key={t.id} className="flex items-center gap-3 py-2.5">
              <div className="w-48 shrink-0">
                <p className="text-xs text-zinc-200">{t.label}</p>
                {!view.ready[t.id] && <p className="text-[10px] text-amber-400">No usable model</p>}
                {t.id === 'research' && <p className="text-[10px] text-zinc-600">Web search still needs a Gemini key</p>}
              </div>
              <select
                className={selectClass}
                value={view.tasks[t.id] || ''}
                onChange={(e) => save({ tasks: { [t.id]: e.target.value } as Partial<Record<AiTask, string>> })}
              >
                <option value="">Use default — {defaultName}</option>
                <ModelOptions connections={view.connections} vision={t.id === 'ocr'} />
              </select>
            </div>
          ))}
          <div className="flex items-center gap-3 py-2.5">
            <div className="w-48 shrink-0">
              <p className="text-xs text-zinc-200">Search & graph links</p>
              <p className="text-[10px] text-zinc-600">Embeddings</p>
            </div>
            <select className={selectClass} value={view.embeddings} onChange={(e) => save({ embeddings: e.target.value })}>
              <option value="local">Built-in — runs on this computer, free</option>
              <option value="gemini" disabled={!view.connections.find((c) => c.id === 'gemini' && c.auth === 'api' && c.available)}>
                Gemini (API key)
              </option>
              {view.connections.filter((c) => c.custom).map((c) => (
                <optgroup key={c.id} label={c.label}>
                  {c.models.map((m) => <option key={m.id} value={`${c.id}:${m.id}`}>{c.label} · {m.id}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer select-none">
          <input type="checkbox" checked={view.fallback} onChange={(e) => save({ fallback: e.target.checked })} />
          If a model fails, try my other connected models
        </label>
        <p className="mt-2 text-[10px] text-zinc-600">
          Changing the embeddings provider makes existing links stale; use “Embed missing” in Second Brain → Physics to rebuild them.
          DeepDive chat keeps its own model picker.
        </p>
        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
      </div>

      <ConnectionsCard view={view} />
    </div>
  );
}

function ConnectionsCard({ view }: { view: RoutingView }) {
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [editing, setEditing] = useState<Connection | 'new' | null>(null);

  const test = async (c: Connection) => {
    const ref = `${c.id}:${c.models[0]?.id ?? ''}`;
    setTesting(c.id);
    try {
      const reply = await testModel(ref);
      setResults((r) => ({ ...r, [c.id]: { ok: true, text: `Replied: “${reply}”` } }));
    } catch (e: any) {
      setResults((r) => ({ ...r, [c.id]: { ok: false, text: e?.message || 'Failed.' } }));
    } finally { setTesting(null); }
  };

  return (
    <div className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-bold">Connections</h3>
          <p className="text-[11px] text-zinc-500">Click a model's star to make it the default. Subscriptions and keys are set up below; add local or hosted open models here.</p>
        </div>
        <button onClick={() => setEditing('new')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold uppercase tracking-wider">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      <div className="space-y-1.5">
        {view.connections.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-zinc-950/40 border border-zinc-800/60">
            <div className={`w-2 h-2 rounded-full shrink-0 ${c.available ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-zinc-200">
                {c.label}
                <span className="ml-2 text-[10px] text-zinc-500">{authLabel(c)}{c.vision ? ' · reads images' : ''}</span>
              </p>
              {results[c.id] || !c.available ? (
                <p className={`text-[10px] truncate ${results[c.id] ? (results[c.id].ok ? 'text-emerald-400' : 'text-red-400') : 'text-zinc-600'}`}>
                  {results[c.id]?.text || c.reason}
                </p>
              ) : (
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.models.map((m) => {
                    const ref = `${c.id}:${m.id}`;
                    const isDefault = view.default === ref;
                    return (
                      <button
                        key={ref}
                        onClick={() => { if (!isDefault) saveRouting({ default: ref }); }}
                        title={isDefault ? 'Default model' : 'Make this the default model'}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border transition-colors ${isDefault ? 'border-amber-400/50 bg-amber-400/10 text-amber-300' : 'border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:border-zinc-600'}`}
                      >
                        <Star className={`w-3 h-3 ${isDefault ? 'fill-amber-300' : ''}`} />
                        {m.label || m.id}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {c.available && (
              <button onClick={() => test(c)} disabled={testing !== null} className="px-2 py-1 rounded-md text-[10px] uppercase tracking-wider text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-50" title="Send a one-word test prompt">
                {testing === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Zap className="w-3 h-3 inline mr-1" />Test</>}
              </button>
            )}
            {c.custom && (
              <>
                <button onClick={() => setEditing(c)} className="px-2 py-1 rounded-md text-[10px] uppercase tracking-wider text-zinc-400 hover:text-white hover:bg-zinc-800">Edit</button>
                <button
                  onClick={async () => { if (confirm(`Remove ${c.label}? Tasks using it go back to the default.`)) await removeConnection(c.id); }}
                  className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-600/20" title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {editing && <ConnectionEditor existing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function ConnectionEditor({ existing, onClose }: { existing: Connection | null; onClose: () => void }) {
  const [label, setLabel] = useState(existing?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState((existing?.models ?? []).map((m) => m.id).join(', '));
  const [vision, setVision] = useState(existing?.vision ?? false);
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState<'detect' | 'save' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const id = existing?.id ?? slug(label);

  const preset = (p: typeof PRESETS[number]) => {
    setLabel(p.id ? p.label : '');
    setBaseUrl(p.baseUrl);
    setHint(p.hint);
    setMsg(null);
  };

  const detect = async () => {
    setBusy('detect');
    setMsg(null);
    try {
      const found = await detectModels({ baseUrl, apiKey: apiKey || undefined, id: existing?.id });
      if (!found.length) setMsg({ ok: false, text: 'The server listed no models. Type the model names instead.' });
      else {
        // Local servers list what's installed — take them all; hosted catalogs are huge.
        setModels(found.length <= 25 ? found.join(', ') : models);
        setMsg({ ok: true, text: found.length <= 25 ? `Found ${found.length} model(s).` : `Found ${found.length} models — type the ones you want, e.g. ${found.slice(0, 3).join(', ')}.` });
      }
    } catch (e: any) { setMsg({ ok: false, text: e?.message || 'Could not reach the server.' }); }
    finally { setBusy(null); }
  };

  const submit = async () => {
    setBusy('save');
    setMsg(null);
    try {
      await saveConnection({
        id, label: label.trim() || id, baseUrl: baseUrl.trim(), vision,
        models: models.split(',').map((m) => m.trim()).filter(Boolean),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      onClose();
    } catch (e: any) { setMsg({ ok: false, text: e?.message || 'Could not save.' }); setBusy(null); }
  };

  return (
    <div className="mt-4 p-4 rounded-xl border border-indigo-500/30 bg-indigo-500/5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold">{existing ? `Edit ${existing.label}` : 'Add a connection'}</p>
        <button onClick={onClose} className="p-1 rounded text-zinc-500 hover:text-white"><X className="w-4 h-4" /></button>
      </div>
      {!existing && (
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => preset(p)} className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-200">{p.label}</button>
          ))}
        </div>
      )}
      {hint && <p className="text-[11px] text-zinc-400">{hint}</p>}
      <div className="grid grid-cols-2 gap-2">
        <input className={inputClass} placeholder="Name (e.g. Ollama)" value={label} onChange={(e) => setLabel(e.target.value)} disabled={!!existing} />
        <input className={inputClass} placeholder="Base URL (…/v1)" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </div>
      <input
        className={inputClass} type="password" autoComplete="off"
        placeholder={existing?.hasKey ? 'API key saved — type to replace' : 'API key (leave empty for local servers)'}
        value={apiKey} onChange={(e) => setApiKey(e.target.value)}
      />
      <div className="flex gap-2">
        <input className={inputClass} placeholder="Model names, comma-separated (e.g. qwen3:8b, deepseek-r1)" value={models} onChange={(e) => setModels(e.target.value)} />
        <button onClick={detect} disabled={!baseUrl.trim() || busy !== null} className="shrink-0 flex items-center gap-1.5 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-[11px] text-zinc-200">
          {busy === 'detect' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} Detect
        </button>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer select-none">
        <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
        These models can read images (needed for screenshot OCR)
      </label>
      {msg && <p className={`text-[11px] ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</p>}
      <div className="flex justify-end">
        <button onClick={submit} disabled={!id || !baseUrl.trim() || !models.trim() || busy !== null} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-[11px] font-bold uppercase tracking-wider">
          {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
        </button>
      </div>
    </div>
  );
}
