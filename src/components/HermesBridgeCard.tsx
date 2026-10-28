// Settings → Hermes: connect Hermes Agent to AIOS's model team. Shows the
// config.yaml block (MCP server URL + token) and the SOUL.md lines that make
// Hermes delegate like a chief of staff. See electron/hermes-bridge.cjs.

import { useEffect, useState } from 'react';
import { Check, Copy, Network, RefreshCw } from 'lucide-react';
import { apiUrl, initApiBase } from '../lib/apiBase';

interface BridgeView {
  gatewayEnabled: boolean;
  gatewayRunning: boolean;
  port: number;
  urls: { url: string; tailscale: boolean }[];
  token: string;
}

const SOUL_LINES = `## Chief of staff
You run a team of specialist models through the "aios" tools. For any request
bigger than a quick answer: split it into pieces, hand each to the right
specialist with delegate (coding → code work, general → research/writing/
analysis, planning → organizing and planning), check what comes back, and give
me a short, decision-ready report: what was done, the result, and what needs my
call. Give specialists full context — they can't see our conversation.`;

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{label}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
          className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-400 hover:text-white"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-all bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-[11px] font-mono text-zinc-400">{text}</pre>
    </div>
  );
}

export default function HermesBridgeCard() {
  const [view, setView] = useState<BridgeView | null>(null);
  const [urlIndex, setUrlIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = async (method: 'GET' | 'POST' = 'GET') => {
    try {
      await initApiBase();
      const res = await fetch(apiUrl(method === 'GET' ? '/api/hermes/bridge' : '/api/hermes/bridge/regenerate'), { method });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setView(data);
      setError(null);
    } catch (e: any) { setError(e?.message || 'Could not load the bridge settings.'); }
  };

  useEffect(() => { load(); }, []);

  if (!view) {
    return <div className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl text-xs text-zinc-500">{error || 'Loading…'}</div>;
  }

  const url = view.urls[urlIndex]?.url || `http://<this-pc>:${view.port}/mcp`;
  const config = `mcp_servers:
  aios:
    url: ${url}
    headers:
      Authorization: "Bearer ${view.token}"
    timeout: 900`;

  return (
    <div className="p-5 bg-zinc-900/50 border border-zinc-800 rounded-2xl space-y-4">
      <div className="flex items-start gap-3">
        <Network className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
        <div>
          <h3 className="text-sm font-bold">Hermes as chief of staff</h3>
          <p className="text-[11px] text-zinc-500">
            Lets Hermes hand work to your other models — coding, general work and planning go to the models set for
            those roles in Settings → Models — then review the results and report back to you.
          </p>
        </div>
      </div>

      {!view.gatewayRunning && (
        <p className="text-[11px] text-amber-400">
          Turn on the Mobile gateway below — Hermes reaches AIOS through it.
        </p>
      )}

      <div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Address Hermes uses to reach this PC</p>
        <select
          value={urlIndex}
          onChange={(e) => setUrlIndex(Number(e.target.value))}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
        >
          {view.urls.map((u, i) => (
            <option key={u.url} value={i}>{u.url}{u.tailscale ? '  (Tailscale — works away from home)' : '  (home network)'}</option>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-zinc-600">Use Tailscale only if the Mac is on your tailnet; otherwise pick the home-network address.</p>
      </div>

      <CopyBlock label="1 · Add to ~/.hermes/config.yaml on the Mac" text={config} />
      <CopyBlock label="2 · Add to ~/.hermes/SOUL.md" text={SOUL_LINES} />
      <p className="text-[11px] text-zinc-500">3 · Restart Hermes. Ask it to “list the aios models” to check the connection.</p>

      <div className="flex items-center justify-between pt-1">
        <p className="text-[10px] text-zinc-600">The token lets Hermes run your models. Regenerating it disconnects Hermes until you paste the new config.</p>
        <button
          onClick={() => { if (confirm('Regenerate the Hermes token? Hermes will need the new config.')) load('POST'); }}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-200"
        >
          <RefreshCw className="w-3.5 h-3.5" /> New token
        </button>
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
