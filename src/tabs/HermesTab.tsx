import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Bot, CheckCircle2, ChevronLeft, ChevronRight, Clock, Loader2,
  Pause, Play, Plus, RefreshCw, Save, Send, Trash2, XCircle, Zap,
} from 'lucide-react';
import { apiUrl, initApiBase } from '../lib/apiBase';

type StatusKind = 'idle' | 'ok' | 'err';

interface HermesConfig {
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyPreview: string;
  model: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface CronJob {
  id?: string;
  name?: string;
  prompt?: string;
  schedule?: string;
  skills?: string[];
  deliver?: string;
  repeat?: number | null;
  state?: string;
  next_run?: string | null;
  next_run_at?: string | null;
  run_count?: number;
  created_at?: string | null;
  provider?: string | null;
  model?: string | null;
  script?: string | null;
  workdir?: string | null;
}

const EMPTY_JOB: CronJob = {
  name: '',
  prompt: '',
  schedule: 'every 1d',
  skills: [],
  deliver: 'local',
  repeat: null,
  provider: null,
  model: null,
  script: null,
  workdir: null,
};

function statusClasses(kind: StatusKind) {
  if (kind === 'ok') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (kind === 'err') return 'border-red-500/30 bg-red-500/10 text-red-300';
  return 'border-zinc-800 bg-zinc-900/50 text-zinc-400';
}

function prettyDate(value?: string | null) {
  if (!value) return 'Not scheduled';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function compactJson(value: unknown) {
  if (!value) return '';
  try {
    return JSON.stringify(value, null, 2).slice(0, 2400);
  } catch {
    return String(value);
  }
}

function extractJsonObject(text: string) {
  const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export default function HermesTab() {
  const [baseUrl, setBaseUrl] = useState('http://192.168.1.185:8642/v1');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [model, setModel] = useState('hermes-mac');
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{ kind: StatusKind; text: string; detail?: unknown }>({
    kind: 'idle',
    text: 'Not checked yet.',
  });
  const [models, setModels] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [cronCollapsed, setCronCollapsed] = useState(false);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobDraft, setJobDraft] = useState<CronJob>(EMPTY_JOB);
  const [cronLoading, setCronLoading] = useState(false);
  const [cronSaving, setCronSaving] = useState(false);
  const [cronMessage, setCronMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const canUse = useMemo(() => baseUrl.trim() && hasApiKey, [baseUrl, hasApiKey]);
  const selectedJob = useMemo(() => cronJobs.find(j => j.id === selectedJobId) || null, [cronJobs, selectedJobId]);

  const loadConfig = useCallback(async () => {
    try {
      await initApiBase();
      const res = await fetch(apiUrl('/api/hermes/config'));
      const cfg = (await res.json()) as HermesConfig;
      if (cfg.baseUrl) setBaseUrl(cfg.baseUrl);
      if (cfg.model) setModel(cfg.model);
      setHasApiKey(!!cfg.hasApiKey);
    } catch (e) {
      console.error('Failed to load Hermes config:', e);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    window.addEventListener('aios:hermes-config-changed', loadConfig);
    return () => window.removeEventListener('aios:hermes-config-changed', loadConfig);
  }, [loadConfig]);

  useEffect(() => {
    const onFocus = () => loadConfig();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadConfig]);

  const checkConnection = async () => {
    setChecking(true);
    setStatus({ kind: 'idle', text: 'Checking Hermes Gateway...' });
    setModels([]);
    try {
      await initApiBase();
      await loadConfig();
      const [healthRes, modelsRes] = await Promise.all([
        fetch(apiUrl('/api/hermes/health')),
        fetch(apiUrl('/api/hermes/models')),
      ]);
      const health = await healthRes.json();
      const modelData = await modelsRes.json();
      if (!healthRes.ok) throw new Error(health?.error || 'Hermes health check failed.');
      if (!modelsRes.ok) throw new Error(modelData?.error || 'Hermes models check failed.');
      const ids = Array.isArray(modelData?.data)
        ? modelData.data.map((m: any) => m?.id).filter(Boolean)
        : [];
      setModels(ids);
      setStatus({ kind: 'ok', text: `Connected to Hermes Gateway. ${ids.length || 0} model(s) reported.`, detail: health });
    } catch (e: any) {
      setStatus({ kind: 'err', text: e?.message || 'Hermes connection failed.' });
    } finally {
      setChecking(false);
    }
  };

  const loadCronJobs = useCallback(async () => {
    if (!hasApiKey) return;
    setCronLoading(true);
    setCronMessage(null);
    try {
      await initApiBase();
      const res = await fetch(apiUrl('/api/hermes/cron/jobs'));
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 404) {
          const fallback = await fetch(apiUrl('/api/hermes/chat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: model.trim(),
              messages: [
                { role: 'system', content: 'Use the Hermes cronjob tool if available. Return ONLY JSON.' },
                {
                  role: 'user',
                  content: [
                    'Call cronjob(action="list") and return only JSON in this shape:',
                    '{ "jobs": [ { "id": string, "name": string, "prompt": string, "schedule": string, "skills": string[], "deliver": string, "repeat": number|null, "state": string, "next_run": string|null, "next_run_at": string|null, "run_count": number, "created_at": string|null, "provider": string|null, "model": string|null, "script": string|null, "workdir": string|null } ] }',
                  ].join('\n'),
                },
              ],
            }),
          });
          const fallbackData = await fallback.json();
          if (!fallback.ok) throw new Error(fallbackData?.error || 'Failed to load cron jobs.');
          const parsed = extractJsonObject(fallbackData?.content || '');
          if (!parsed || !Array.isArray(parsed.jobs)) throw new Error('Hermes returned no parsable cron job list.');
          setCronJobs(parsed.jobs);
          setCronMessage({ kind: 'ok', text: 'Loaded cron jobs. Restart AIOS to enable direct edit controls.' });
          return;
        }
        throw new Error(data?.error || 'Failed to load cron jobs.');
      }
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      setCronJobs(jobs);
    } catch (e: any) {
      setCronMessage({ kind: 'err', text: e?.message || 'Failed to load cron jobs.' });
    } finally {
      setCronLoading(false);
    }
  }, [hasApiKey]);

  useEffect(() => {
    if (hasApiKey) loadCronJobs();
  }, [hasApiKey, loadCronJobs]);

  const selectJob = (job: CronJob) => {
    setSelectedJobId(job.id || null);
    setJobDraft({ ...EMPTY_JOB, ...job, skills: Array.isArray(job.skills) ? job.skills : [] });
    setCronMessage(null);
  };

  const createJob = () => {
    setSelectedJobId(null);
    setJobDraft({ ...EMPTY_JOB });
    setCronCollapsed(false);
    setCronMessage(null);
  };

  const saveCronJob = async () => {
    if (!jobDraft.prompt?.trim() || !jobDraft.schedule?.trim()) {
      setCronMessage({ kind: 'err', text: 'Schedule and prompt are required.' });
      return;
    }
    setCronSaving(true);
    setCronMessage(null);
    try {
      await initApiBase();
      const res = await fetch(apiUrl('/api/hermes/cron/jobs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jobDraft),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) throw new Error(data?.error || data?.message || 'Failed to save cron job.');
      setCronMessage({ kind: 'ok', text: data?.message || 'Cron job saved.' });
      await loadCronJobs();
    } catch (e: any) {
      setCronMessage({ kind: 'err', text: e?.message || 'Failed to save cron job.' });
    } finally {
      setCronSaving(false);
    }
  };

  const runCronAction = async (jobId: string | undefined, action: 'pause' | 'resume' | 'run' | 'remove') => {
    if (!jobId) return;
    if (action === 'remove' && !confirm('Remove this Hermes cron job?')) return;
    setCronLoading(true);
    setCronMessage(null);
    try {
      await initApiBase();
      const res = await fetch(apiUrl(`/api/hermes/cron/jobs/${encodeURIComponent(jobId)}/${action}`), { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data?.ok === false) throw new Error(data?.error || data?.message || `Failed to ${action} cron job.`);
      setCronMessage({ kind: 'ok', text: data?.message || `Cron job ${action} requested.` });
      if (action === 'remove') {
        setSelectedJobId(null);
        setJobDraft({ ...EMPTY_JOB });
      }
      await loadCronJobs();
    } catch (e: any) {
      setCronMessage({ kind: 'err', text: e?.message || `Failed to ${action} cron job.` });
    } finally {
      setCronLoading(false);
    }
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);
    setInput('');
    setSending(true);
    try {
      await initApiBase();
      const res = await fetch(apiUrl('/api/hermes/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.trim(), messages: nextMessages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Hermes chat failed.');
      setMessages([...nextMessages, { role: 'assistant', content: data.content || '(empty response)' }]);
    } catch (e: any) {
      setMessages([...nextMessages, { role: 'assistant', content: `Error: ${e?.message || 'Hermes chat failed.'}` }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center justify-between bg-zinc-900/10 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-3">
          <Bot className="w-5 h-5 text-indigo-400" />
          <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-widest">Hermes</h2>
        </div>
        <button
          onClick={checkConnection}
          disabled={checking || !canUse}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-600 text-xs font-bold uppercase tracking-wider transition-colors"
        >
          {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Check
        </button>
      </header>

      <div className={`flex-1 min-h-0 grid ${cronCollapsed ? 'grid-cols-[56px_minmax(0,1fr)]' : 'grid-cols-1 xl:grid-cols-[420px_minmax(0,1fr)]'}`}>
        <aside className="border-r border-zinc-800 overflow-hidden bg-zinc-950/30">
          {cronCollapsed ? (
            <div className="h-full flex flex-col items-center py-4 gap-3">
              <button
                onClick={() => setCronCollapsed(false)}
                className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800"
                title="Show cron jobs"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <Clock className="w-5 h-5 text-indigo-400" />
              <div className="text-[10px] text-zinc-500 [writing-mode:vertical-rl] uppercase tracking-widest">
                Cron Jobs
              </div>
            </div>
          ) : (
          <div className="h-full flex flex-col min-h-0">
            <div className="h-14 px-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-400" />
                <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-300">Cron Jobs</h3>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={createJob} className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-white" title="New cron job">
                  <Plus className="w-4 h-4" />
                </button>
                <button onClick={loadCronJobs} disabled={cronLoading || !hasApiKey} className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-white disabled:text-zinc-700" title="Refresh jobs">
                  {cronLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                </button>
                <button onClick={() => setCronCollapsed(true)} className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-white" title="Collapse cron jobs">
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
              <div className="space-y-2">
                {!hasApiKey && (
                  <div className="border border-amber-500/20 bg-amber-500/10 text-amber-300 rounded-lg p-3 text-xs">
                    Configure Hermes Gateway in Settings before loading cron jobs.
                  </div>
                )}
                {hasApiKey && cronJobs.length === 0 && !cronLoading && (
                  <div className="border border-zinc-800 bg-zinc-900/50 rounded-lg p-3 text-xs text-zinc-500">
                    No cron jobs reported.
                  </div>
                )}
                {cronJobs.map(job => {
                  const active = selectedJobId === job.id;
                  return (
                    <button
                      key={job.id || job.name}
                      onClick={() => selectJob(job)}
                      className={`w-full text-left rounded-lg border p-3 transition-colors ${
                        active ? 'bg-indigo-600/10 border-indigo-500/40' : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <p className="text-sm font-semibold text-zinc-100 truncate">{job.name || job.id || 'Untitled job'}</p>
                        <span className={`text-[10px] uppercase tracking-widest ${job.state === 'scheduled' ? 'text-emerald-400' : job.state === 'paused' ? 'text-amber-400' : 'text-zinc-500'}`}>
                          {job.state || 'unknown'}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 font-mono truncate">{job.schedule || 'No schedule'}</p>
                      <p className="text-[11px] text-zinc-600 truncate mt-1">Next: {prettyDate(job.next_run || job.next_run_at)}</p>
                    </button>
                  );
                })}
              </div>

              <div className="border border-zinc-800 rounded-xl bg-zinc-900/50 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                    {selectedJob ? 'Edit Job' : 'New Job'}
                  </p>
                  {selectedJob?.id && (
                    <div className="flex items-center gap-1">
                      <button onClick={() => runCronAction(selectedJob.id, selectedJob.state === 'paused' ? 'resume' : 'pause')} className="p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300" title={selectedJob.state === 'paused' ? 'Resume' : 'Pause'}>
                        {selectedJob.state === 'paused' ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                      </button>
                      <button onClick={() => runCronAction(selectedJob.id, 'run')} className="p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300" title="Run now">
                        <Zap className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => runCronAction(selectedJob.id, 'remove')} className="p-1.5 rounded-md bg-zinc-800 hover:bg-red-600/30 text-zinc-300 hover:text-red-300" title="Remove">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                <input value={jobDraft.name || ''} onChange={e => setJobDraft(j => ({ ...j, name: e.target.value }))} placeholder="Name" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <input value={jobDraft.schedule || ''} onChange={e => setJobDraft(j => ({ ...j, schedule: e.target.value }))} placeholder="every 1d, 0 9 * * *, 30m" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <textarea value={jobDraft.prompt || ''} onChange={e => setJobDraft(j => ({ ...j, prompt: e.target.value }))} placeholder="Prompt" rows={5} className="w-full resize-none bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <input value={(jobDraft.skills || []).join(', ')} onChange={e => setJobDraft(j => ({ ...j, skills: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} placeholder="skills, comma separated" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <div className="grid grid-cols-2 gap-2">
                  <input value={jobDraft.deliver || ''} onChange={e => setJobDraft(j => ({ ...j, deliver: e.target.value }))} placeholder="deliver: local" className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  <input value={jobDraft.repeat ?? ''} onChange={e => setJobDraft(j => ({ ...j, repeat: e.target.value ? Number(e.target.value) : null }))} placeholder="repeat" type="number" className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input value={jobDraft.provider || ''} onChange={e => setJobDraft(j => ({ ...j, provider: e.target.value || null }))} placeholder="provider override" className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  <input value={jobDraft.model || ''} onChange={e => setJobDraft(j => ({ ...j, model: e.target.value || null }))} placeholder="model override" className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                </div>
                <input value={jobDraft.workdir || ''} onChange={e => setJobDraft(j => ({ ...j, workdir: e.target.value || null }))} placeholder="absolute workdir" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <textarea value={jobDraft.script || ''} onChange={e => setJobDraft(j => ({ ...j, script: e.target.value || null }))} placeholder="optional pre-run script" rows={3} className="w-full resize-none bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <button onClick={saveCronJob} disabled={cronSaving || !hasApiKey} className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-bold uppercase tracking-wider">
                  {cronSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Job
                </button>
                {cronMessage && <p className={`text-[11px] ${cronMessage.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>{cronMessage.text}</p>}
              </div>
            </div>
          </div>
          )}
        </aside>

        <main className="flex flex-col min-h-0">
          {(status.kind !== 'idle' || models.length > 0) && (
            <div className="border-b border-zinc-800 bg-zinc-950/60 px-4 py-3 shrink-0">
              <div className={`border rounded-lg px-3 py-2 ${statusClasses(status.kind)}`}>
                <div className="flex items-start gap-3">
                  {status.kind === 'ok' ? <CheckCircle2 className="w-4 h-4 mt-0.5" /> : status.kind === 'err' ? <XCircle className="w-4 h-4 mt-0.5" /> : <Activity className="w-4 h-4 mt-0.5" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">{status.text}</p>
                    {models.length > 0 && <p className="mt-1 text-[11px] text-zinc-500">Model: <span className="font-mono text-zinc-300">{model}</span></p>}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 ? (
              <div className="h-full flex items-center justify-center text-center">
                <div className="max-w-md">
                  <div className="w-16 h-16 mx-auto rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
                    <Bot className="w-7 h-7 text-indigo-400" />
                  </div>
                  <h3 className="text-xl font-bold text-zinc-100 mb-2">Hermes Gateway Chat</h3>
                  <p className="text-sm text-zinc-500 leading-relaxed">
                    Messages route through AIOS on Windows to the Hermes Gateway running on your Mac.
                  </p>
                </div>
              </div>
            ) : (
              messages.map((m, index) => (
                <div key={index} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-3xl rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-900 border border-zinc-800 text-zinc-100'
                  }`}>
                    {m.content}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-zinc-800 p-4 bg-zinc-950/70">
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Ask Hermes..."
                rows={2}
                className="flex-1 resize-none bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                onClick={sendMessage}
                disabled={sending || !input.trim() || !canUse}
                className="self-stretch px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white transition-colors"
                title="Send"
              >
                {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
