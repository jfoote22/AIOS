import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Inbox, KeyRound, Loader2, RefreshCw, Save, Server, XCircle } from 'lucide-react';
import { apiUrl, initApiBase } from '../lib/apiBase';
import type { MemoryIngestStatus } from '../electron';

interface HermesConfig {
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyPreview: string;
  model: string;
}

export default function HermesSettingsTab() {
  const [baseUrl, setBaseUrl] = useState('http://192.168.1.185:8642/v1');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyPreview, setApiKeyPreview] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [model, setModel] = useState('hermes-mac');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Memory ingest (LAN webhook) state.
  const [mem, setMem] = useState<MemoryIngestStatus | null>(null);
  const [memPort, setMemPort] = useState(8765);
  const [memSaving, setMemSaving] = useState(false);
  const [copied, setCopied] = useState<'url' | 'token' | 'curl' | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await initApiBase();
        const res = await fetch(apiUrl('/api/hermes/config'));
        const cfg = (await res.json()) as HermesConfig;
        if (cfg.baseUrl) setBaseUrl(cfg.baseUrl);
        if (cfg.model) setModel(cfg.model);
        setHasApiKey(!!cfg.hasApiKey);
        setApiKeyPreview(cfg.apiKeyPreview || '');
      } catch (e) {
        console.error('Failed to load Hermes config:', e);
      }
      try {
        const cfg = await window.aios?.memory?.getConfig();
        if (cfg) { setMem(cfg); setMemPort(cfg.port); }
      } catch (e) {
        console.error('Failed to load memory ingest config:', e);
      }
    })();
  }, []);

  const applyMem = async (next: { enabled?: boolean; port?: number }) => {
    setMemSaving(true);
    try {
      const cfg = await window.aios?.memory?.setConfig(next);
      if (cfg) { setMem(cfg); setMemPort(cfg.port); }
    } catch (e) {
      console.error('Failed to update memory ingest config:', e);
    } finally {
      setMemSaving(false);
    }
  };

  const regenerateMemToken = async () => {
    try {
      const cfg = await window.aios?.memory?.regenerateToken();
      if (cfg) setMem(cfg);
    } catch (e) {
      console.error('Failed to regenerate memory ingest token:', e);
    }
  };

  const copyMem = async (text: string, which: 'url' | 'token' | 'curl') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  };

  const ingestUrl = mem ? `http://${mem.address}:${mem.port}/api/memory/ingest` : '';
  const curlSnippet = mem
    ? `curl -X POST ${ingestUrl} \\\n  -H "Authorization: Bearer ${mem.token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"My note","content":"# Markdown body here","jobName":"my-hermes-job"}'`
    : '';

  const saveConfig = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await initApiBase();
      const res = await fetch(apiUrl('/api/hermes/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to save Hermes settings.');
      setApiKey('');
      setHasApiKey(!!data.hasApiKey);
      setApiKeyPreview(data.apiKeyPreview || apiKeyPreview);
      window.dispatchEvent(new Event('aios:hermes-config-changed'));
      setMessage({ kind: 'ok', text: 'Hermes Gateway settings saved.' });
    } catch (e: any) {
      setMessage({ kind: 'err', text: e?.message || 'Failed to save Hermes settings.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <div className="p-3 bg-zinc-900 border border-zinc-800 rounded-2xl">
            <Server className="w-6 h-6 text-indigo-500" />
          </div>
          <div>
            <h2 className="text-3xl font-bold">Hermes Gateway</h2>
            <p className="text-xs text-zinc-500">
              Connect AIOS to the OpenAI-compatible Hermes API server running on your Mac.
            </p>
          </div>
        </div>

        <div className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl">
          <div className="flex items-center gap-3 mb-5">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${hasApiKey ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-500 border border-zinc-700'}`}>
              {hasApiKey ? <CheckCircle2 className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />}
            </div>
            <div>
              <p className="font-bold text-sm">Mac Gateway API Server</p>
              <p className="text-[11px] text-zinc-500">
                {hasApiKey ? `API key saved${apiKeyPreview ? ` (${apiKeyPreview})` : ''}` : 'Paste the API_SERVER_KEY generated on the Mac.'}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <label className="block">
              <span className="text-[11px] uppercase tracking-widest text-zinc-500">OpenAI-compatible base URL</span>
              <input
                value={baseUrl}
                onChange={(e) => { setBaseUrl(e.target.value); setMessage(null); }}
                placeholder="http://192.168.1.185:8642/v1"
                className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </label>

            <label className="block">
              <span className="text-[11px] uppercase tracking-widest text-zinc-500">API key</span>
              <input
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setMessage(null); }}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={hasApiKey ? 'Leave blank to keep the saved key' : 'Paste Hermes API_SERVER_KEY'}
                className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </label>

            <label className="block">
              <span className="text-[11px] uppercase tracking-widest text-zinc-500">Model</span>
              <input
                value={model}
                onChange={(e) => { setModel(e.target.value); setMessage(null); }}
                placeholder="hermes-mac"
                className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </label>

            <button
              onClick={saveConfig}
              disabled={saving || !baseUrl.trim()}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-white text-xs font-bold uppercase tracking-wider transition-colors"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Gateway Settings
            </button>
          </div>

          {message && (
            <div className={`mt-4 flex items-center gap-2 text-xs ${message.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
              {message.kind === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
              {message.text}
            </div>
          )}
        </div>

        {/* Memory ingest: LAN webhook that feeds Hermes markdown into Second Brain. */}
        <div className="mt-6 p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl">
          <div className="flex items-start gap-3 mb-5">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${mem?.running ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-500 border border-zinc-700'}`}>
              <Inbox className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <p className="font-bold text-sm">Second Brain memory ingest</p>
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                Expose a token-gated webhook on your LAN so a Hermes job can POST its markdown
                output straight into Second Brain. Notes are auto-categorized, chunked, and
                embedded like every other neuron. Off by default; only this one route is exposed.
              </p>
            </div>
            <button
              onClick={() => applyMem({ enabled: !mem?.enabled })}
              disabled={memSaving || !window.aios?.memory}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-colors ${mem?.enabled ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'} disabled:opacity-50`}
            >
              {memSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : mem?.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>

          {!window.aios?.memory ? (
            <p className="text-[11px] text-amber-400">Memory ingest requires running inside the AIOS desktop app.</p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="text-[11px] uppercase tracking-widest text-zinc-500">Port</span>
                  <input
                    type="number"
                    value={memPort}
                    onChange={(e) => setMemPort(Number(e.target.value))}
                    onBlur={() => { if (memPort !== mem?.port) applyMem({ port: memPort }); }}
                    className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </label>
                <div className="col-span-2 block">
                  <span className="text-[11px] uppercase tracking-widest text-zinc-500">Ingest URL</span>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 truncate bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-300">{ingestUrl || '—'}</code>
                    <button onClick={() => copyMem(ingestUrl, 'url')} disabled={!ingestUrl} title="Copy URL"
                      className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-zinc-300 disabled:opacity-40">
                      {copied === 'url' ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="block">
                <span className="text-[11px] uppercase tracking-widest text-zinc-500">Bearer token</span>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 truncate bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-300">{mem?.token || '—'}</code>
                  <button onClick={() => mem?.token && copyMem(mem.token, 'token')} disabled={!mem?.token} title="Copy token"
                    className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-zinc-300 disabled:opacity-40">
                    {copied === 'token' ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <button onClick={regenerateMemToken} title="Regenerate token"
                    className="p-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-zinc-300">
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-zinc-600">Regenerating invalidates the old token — update your Hermes job afterward.</p>
              </div>

              <div className="block">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-widest text-zinc-500">Hermes delivery command</span>
                  <button onClick={() => copyMem(curlSnippet, 'curl')} disabled={!curlSnippet}
                    className="flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-40">
                    {copied === 'curl' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    Copy
                  </button>
                </div>
                <pre className="mt-1 bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-[11px] font-mono text-zinc-400 overflow-x-auto whitespace-pre">{curlSnippet || '—'}</pre>
                <p className="mt-1 text-[10px] text-zinc-600 leading-relaxed">
                  Add this as a final step in your Hermes job (the Mac must reach this machine on the LAN).
                  Send <code className="text-zinc-400">content</code> (markdown) plus an optional <code className="text-zinc-400">title</code>/<code className="text-zinc-400">jobName</code>.
                </p>
              </div>

              {mem?.error && (
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <XCircle className="w-4 h-4" />{mem.error}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
