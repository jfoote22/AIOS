import { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, Save, Server, XCircle } from 'lucide-react';
import { apiUrl, initApiBase } from '../lib/apiBase';

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
    })();
  }, []);

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
      </div>
    </div>
  );
}
