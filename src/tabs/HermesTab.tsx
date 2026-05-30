import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Bot, CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, Clock,
  Code2, Folder, Hash, Info, Loader2, Mail, Pause, Play, Plus, RefreshCw,
  Save, Send, Sparkles, Tag, Trash2, X, XCircle, Zap,
} from 'lucide-react';
import { apiUrl, initApiBase } from '../lib/apiBase';
import { getAnthropicAuthMode } from '../lib/authMode';

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

type CronDraftField = 'name' | 'prompt' | 'schedule' | 'skills' | 'all';

const EMPTY_JOB: CronJob = {
  name: '',
  prompt: '',
  schedule: '0 9 * * *',
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

function stateClasses(state?: string) {
  if (state === 'running') return 'bg-sky-500/10 border-sky-500/30 text-sky-300';
  if (state === 'scheduled') return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300';
  if (state === 'paused') return 'bg-amber-500/10 border-amber-500/30 text-amber-300';
  if (state === 'completed') return 'bg-zinc-700/30 border-zinc-600 text-zinc-300';
  return 'bg-zinc-800 border-zinc-700 text-zinc-400';
}

function prettyDate(value?: string | null) {
  if (!value) return 'Not scheduled';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
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

function FieldLabel({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-zinc-500">
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

function AssistButton({ busy, onClick, label = 'Ask Claude' }: { busy: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title="Ask Claude to fill or refine this field"
      className="inline-flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-200 disabled:opacity-50 uppercase tracking-wider"
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
      {busy ? 'Asking...' : label}
    </button>
  );
}

function timeToParts(time: string) {
  const [h, m] = time.split(':').map(v => Number(v));
  return { hour: Number.isFinite(h) ? h : 9, minute: Number.isFinite(m) ? m : 0 };
}

function partsToTime(hour: number, minute: number) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildCron(mode: string, time: string, dayOfWeek: string, dayOfMonth: string, intervalHours: string, custom: string) {
  const { hour, minute } = timeToParts(time);
  if (mode === 'daily') return `${minute} ${hour} * * *`;
  if (mode === 'weekly') return `${minute} ${hour} * * ${dayOfWeek}`;
  if (mode === 'monthly') return `${minute} ${hour} ${dayOfMonth} * *`;
  if (mode === 'hourly') return `0 */${Math.max(1, Number(intervalHours) || 1)} * * *`;
  return custom.trim();
}

function parseCron(value: string) {
  const v = (value || '').trim();
  const parts = v.split(/\s+/);
  if (parts.length !== 5) return { mode: 'custom', time: '09:00', dayOfWeek: '1', dayOfMonth: '1', intervalHours: '2', custom: v };
  const [minute, hour, dom, month, dow] = parts;
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    return { mode: 'hourly', time: '09:00', dayOfWeek: '1', dayOfMonth: '1', intervalHours: hour.slice(2), custom: v };
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && month === '*') {
    const time = partsToTime(Number(hour), Number(minute));
    if (dom === '*' && dow === '*') return { mode: 'daily', time, dayOfWeek: '1', dayOfMonth: '1', intervalHours: '2', custom: v };
    if (dom === '*' && dow !== '*') return { mode: 'weekly', time, dayOfWeek: dow, dayOfMonth: '1', intervalHours: '2', custom: v };
    if (dom !== '*' && dow === '*') return { mode: 'monthly', time, dayOfWeek: '1', dayOfMonth: dom, intervalHours: '2', custom: v };
  }
  return { mode: 'custom', time: '09:00', dayOfWeek: '1', dayOfMonth: '1', intervalHours: '2', custom: v };
}

function ScheduleBuilder({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const initial = useMemo(() => parseCron(value), [value]);
  const [mode, setMode] = useState(initial.mode);
  const [time, setTime] = useState(initial.time);
  const [dayOfWeek, setDayOfWeek] = useState(initial.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(initial.dayOfMonth);
  const [intervalHours, setIntervalHours] = useState(initial.intervalHours);
  const [custom, setCustom] = useState(initial.custom);

  useEffect(() => {
    const next = parseCron(value);
    setMode(next.mode);
    setTime(next.time);
    setDayOfWeek(next.dayOfWeek);
    setDayOfMonth(next.dayOfMonth);
    setIntervalHours(next.intervalHours);
    setCustom(next.custom);
  }, [value]);

  const commit = (next: Partial<{ mode: string; time: string; dayOfWeek: string; dayOfMonth: string; intervalHours: string; custom: string }>) => {
    const merged = {
      mode, time, dayOfWeek, dayOfMonth, intervalHours, custom,
      ...next,
    };
    setMode(merged.mode);
    setTime(merged.time);
    setDayOfWeek(merged.dayOfWeek);
    setDayOfMonth(merged.dayOfMonth);
    setIntervalHours(merged.intervalHours);
    setCustom(merged.custom);
    onChange(buildCron(merged.mode, merged.time, merged.dayOfWeek, merged.dayOfMonth, merged.intervalHours, merged.custom));
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-1 bg-zinc-950 border border-zinc-800 rounded-lg p-1">
        {[
          ['daily', 'Daily'],
          ['weekly', 'Weekly'],
          ['monthly', 'Monthly'],
          ['hourly', 'Every N hours'],
          ['custom', 'Custom'],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => commit({ mode: id })}
            className={`px-2 py-1.5 rounded-md text-[11px] font-semibold transition-colors ${mode === id ? 'bg-indigo-600/20 text-indigo-200' : 'text-zinc-500 hover:text-white hover:bg-zinc-900'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'daily' && (
        <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 items-end">
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Time</span>
            <input type="time" value={time} onChange={e => commit({ time: e.target.value })} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
          </label>
          <p className="pb-2 text-xs text-zinc-500">Runs every day at this time.</p>
        </div>
      )}

      {mode === 'weekly' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Day</span>
            <select value={dayOfWeek} onChange={e => commit({ dayOfWeek: e.target.value })} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500">
              <option value="0">Sunday</option>
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Time</span>
            <input type="time" value={time} onChange={e => commit({ time: e.target.value })} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
          </label>
        </div>
      )}

      {mode === 'monthly' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Day of month</span>
            <input type="number" min={1} max={31} value={dayOfMonth} onChange={e => commit({ dayOfMonth: e.target.value })} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
          </label>
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Time</span>
            <input type="time" value={time} onChange={e => commit({ time: e.target.value })} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
          </label>
        </div>
      )}

      {mode === 'hourly' && (
        <label className="space-y-1.5 block max-w-xs">
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">Run every</span>
          <div className="flex items-center gap-2">
            <input type="number" min={1} max={24} value={intervalHours} onChange={e => commit({ intervalHours: e.target.value })} className="w-24 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
            <span className="text-sm text-zinc-400">hours</span>
          </div>
        </label>
      )}

      {mode === 'custom' && (
        <label className="space-y-1.5 block">
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">Custom cron expression</span>
          <input value={custom} onChange={e => commit({ custom: e.target.value })} placeholder="0 9 * * *" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
        </label>
      )}

      <div className="flex items-center gap-2 text-[11px] text-zinc-600">
        <span>Expression:</span>
        <code className="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-zinc-300">{value || '(empty)'}</code>
      </div>
    </div>
  );
}

export default function HermesTab() {
  const [baseUrl, setBaseUrl] = useState('http://192.168.1.185:8642/v1');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [model, setModel] = useState('hermes-mac');
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({
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
  const [skillDraft, setSkillDraft] = useState('');
  const [cronLoading, setCronLoading] = useState(false);
  const [cronSaving, setCronSaving] = useState(false);
  const [cronDrafting, setCronDrafting] = useState<CronDraftField | null>(null);
  const [cronMessage, setCronMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const canUse = useMemo(() => baseUrl.trim() && hasApiKey, [baseUrl, hasApiKey]);
  const selectedJob = useMemo(() => cronJobs.find(j => j.id === selectedJobId) || null, [cronJobs, selectedJobId]);
  const runningJobs = cronJobs.filter(j => j.state === 'running').length;
  const pausedJobs = cronJobs.filter(j => j.state === 'paused').length;

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
      setStatus({ kind: 'ok', text: `Connected. ${ids.length || 0} model(s) reported.` });
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
          setCronMessage({ kind: 'ok', text: 'Loaded jobs through chat bridge. Restart AIOS for direct edit controls.' });
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
  }, [hasApiKey, model]);

  useEffect(() => {
    if (hasApiKey) loadCronJobs();
  }, [hasApiKey, loadCronJobs]);

  const selectJob = (job: CronJob) => {
    setSelectedJobId(job.id || null);
    setJobDraft({ ...EMPTY_JOB, ...job, skills: Array.isArray(job.skills) ? job.skills : [] });
    setSkillDraft('');
    setCronMessage(null);
  };

  const createJob = () => {
    setSelectedJobId(null);
    setJobDraft({ ...EMPTY_JOB });
    setSkillDraft('');
    setCronCollapsed(false);
    setCronMessage(null);
  };

  const addSkill = () => {
    const value = skillDraft.trim();
    if (!value) return;
    setJobDraft(j => ({
      ...j,
      skills: Array.from(new Set([...(j.skills || []), value])),
    }));
    setSkillDraft('');
  };

  const removeSkill = (skill: string) => {
    setJobDraft(j => ({ ...j, skills: (j.skills || []).filter(s => s !== skill) }));
  };

  const runCronDraft = async (field: CronDraftField, hint?: string) => {
    setCronDrafting(field);
    setCronMessage(null);
    try {
      await initApiBase();
      const authMode = await getAnthropicAuthMode();
      const currentValue =
        field === 'skills' ? JSON.stringify(jobDraft.skills || []) :
        field === 'all' ? JSON.stringify(jobDraft) :
        String((jobDraft as any)[field] || '');
      const res = await fetch(apiUrl('/api/hermes/cron/draft'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, currentValue, hint, job: jobDraft, authMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Claude draft failed.');
      const value = String(data.value || '').trim();
      if (field === 'skills') {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          setJobDraft(j => ({ ...j, skills: parsed.filter(v => typeof v === 'string') }));
        }
      } else if (field === 'all') {
        const parsed = JSON.parse(value);
        setJobDraft(j => ({
          ...j,
          name: typeof parsed.name === 'string' ? parsed.name : j.name,
          prompt: typeof parsed.prompt === 'string' ? parsed.prompt : j.prompt,
          schedule: typeof parsed.schedule === 'string' ? parsed.schedule : j.schedule,
          skills: Array.isArray(parsed.skills) ? parsed.skills.filter((v: any) => typeof v === 'string') : j.skills,
          deliver: typeof parsed.deliver === 'string' ? parsed.deliver : j.deliver,
        }));
      } else {
        setJobDraft(j => ({ ...j, [field]: value }));
      }
      setCronMessage({ kind: 'ok', text: `Claude drafted ${field}.` });
    } catch (e: any) {
      setCronMessage({ kind: 'err', text: e?.message || 'Claude draft failed.' });
    } finally {
      setCronDrafting(null);
    }
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
          <div>
            <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-widest">Hermes</h2>
            <p className="text-[11px] text-zinc-600">Cron automation and agent chat</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(status.kind !== 'idle' || models.length > 0) && (
            <div className={`hidden md:flex items-center gap-2 border rounded-lg px-3 py-2 text-xs ${statusClasses(status.kind)}`}>
              {status.kind === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : status.kind === 'err' ? <XCircle className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
              <span className="max-w-[280px] truncate">{status.text}</span>
            </div>
          )}
          <button
            onClick={checkConnection}
            disabled={checking || !canUse}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-600 text-xs font-bold uppercase tracking-wider transition-colors"
          >
            {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Check
          </button>
        </div>
      </header>

      <div className={`flex-1 min-h-0 grid ${cronCollapsed ? 'grid-cols-[56px_minmax(0,1fr)]' : 'grid-cols-1 2xl:grid-cols-[minmax(720px,1fr)_minmax(460px,1fr)] xl:grid-cols-[minmax(640px,1fr)_minmax(420px,0.9fr)]'}`}>
        <section className="border-r border-zinc-800 overflow-hidden bg-zinc-950/30 min-h-0">
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
                <div className="flex items-center gap-3 min-w-0">
                  <CalendarClock className="w-4 h-4 text-indigo-400 shrink-0" />
                  <div className="min-w-0">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-300">Cron Jobs</h3>
                    <p className="text-[11px] text-zinc-600 truncate">
                      {cronJobs.length} total · {runningJobs} running · {pausedJobs} paused
                    </p>
                  </div>
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

              <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
                <div className="border-r border-zinc-800 min-h-0 overflow-y-auto p-3 space-y-2">
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
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <p className="text-sm font-semibold text-zinc-100 leading-snug line-clamp-2">{job.name || job.id || 'Untitled job'}</p>
                          <span className={`shrink-0 border rounded px-1.5 py-0.5 text-[9px] uppercase tracking-widest ${stateClasses(job.state)}`}>
                            {job.state || 'unknown'}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-500 font-mono truncate">{job.schedule || 'No schedule'}</p>
                        <p className="text-[11px] text-zinc-600 truncate mt-1">Next: {prettyDate(job.next_run || job.next_run_at)}</p>
                        {!!job.skills?.length && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {job.skills.slice(0, 3).map(skill => (
                              <span key={skill} className="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-400">{skill}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="min-h-0 overflow-y-auto p-4">
                  <div className="max-w-3xl mx-auto space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[11px] uppercase tracking-widest text-zinc-500">{selectedJob ? 'Editing' : 'New job'}</p>
                        <h3 className="text-xl font-bold text-zinc-100">{jobDraft.name || 'Untitled cron job'}</h3>
                      </div>
                      {selectedJob?.id && (
                        <div className="flex items-center gap-1">
                          <button onClick={() => runCronAction(selectedJob.id, selectedJob.state === 'paused' ? 'resume' : 'pause')} className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300" title={selectedJob.state === 'paused' ? 'Resume' : 'Pause'}>
                            {selectedJob.state === 'paused' ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                          </button>
                          <button onClick={() => runCronAction(selectedJob.id, 'run')} className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300" title="Run now">
                            <Zap className="w-4 h-4" />
                          </button>
                          <button onClick={() => runCronAction(selectedJob.id, 'remove')} className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-red-600/30 text-zinc-300 hover:text-red-300" title="Remove">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>

                    <section className="border border-zinc-800 rounded-lg bg-zinc-900/40 p-4 space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_220px] gap-3">
                        <label className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <FieldLabel icon={Hash} label="Name" />
                            <AssistButton busy={cronDrafting === 'name'} onClick={() => runCronDraft('name')} />
                          </div>
                          <input value={jobDraft.name || ''} onChange={e => setJobDraft(j => ({ ...j, name: e.target.value }))} placeholder="Daily research briefing" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                        </label>
                        <div className="flex items-end">
                          <button
                            onClick={() => runCronDraft('all', 'Draft a full useful cron job from the current name and any existing notes.')}
                            disabled={!!cronDrafting || cronSaving}
                            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-xs font-bold uppercase tracking-wider"
                            title="Have Claude draft the whole cron job"
                          >
                            {cronDrafting === 'all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-indigo-400" />}
                            Draft Job
                          </button>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <FieldLabel icon={Clock} label="Schedule" />
                          <AssistButton busy={cronDrafting === 'schedule'} onClick={() => runCronDraft('schedule', 'Choose a reasonable schedule based on the job name and prompt.')} />
                        </div>
                        <ScheduleBuilder value={jobDraft.schedule || ''} onChange={schedule => setJobDraft(j => ({ ...j, schedule }))} />
                      </div>

                      <label className="space-y-1.5 block">
                        <div className="flex items-center justify-between gap-2">
                          <FieldLabel icon={Bot} label="Task prompt" />
                          <AssistButton busy={cronDrafting === 'prompt'} onClick={() => runCronDraft('prompt')} />
                        </div>
                        <textarea value={jobDraft.prompt || ''} onChange={e => setJobDraft(j => ({ ...j, prompt: e.target.value }))} placeholder="Describe what Hermes should do each time this job runs." rows={7} className="w-full resize-y min-h-36 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                      </label>
                    </section>

                    <section className="border border-zinc-800 rounded-lg bg-zinc-900/40 p-4 space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <FieldLabel icon={Tag} label="Hermes skills" />
                          <p className="text-[11px] text-zinc-600 mt-1">
                            Attach installed Hermes skill names. Skills live under ~/.hermes/skills and are not Anthropic-specific.
                          </p>
                        </div>
                        <AssistButton busy={cronDrafting === 'skills'} onClick={() => runCronDraft('skills')} />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {(jobDraft.skills || []).length === 0 && <span className="text-xs text-zinc-600">No skills attached.</span>}
                        {(jobDraft.skills || []).map(skill => (
                          <span key={skill} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs">
                            {skill}
                            <button onClick={() => removeSkill(skill)} className="text-indigo-300/70 hover:text-red-300" title="Remove skill">
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <input value={skillDraft} onChange={e => setSkillDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSkill(); } }} placeholder="himalaya, github-pr-workflow, plan..." className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                        <button onClick={addSkill} className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-bold uppercase tracking-wider text-zinc-200">Add</button>
                      </div>
                    </section>

                    <section className="border border-zinc-800 rounded-lg bg-zinc-900/40 p-4 space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <label className="space-y-1.5">
                          <FieldLabel icon={Mail} label="Delivery" />
                          <input value={jobDraft.deliver || ''} onChange={e => setJobDraft(j => ({ ...j, deliver: e.target.value }))} placeholder="local or origin" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                        </label>
                        <label className="space-y-1.5">
                          <FieldLabel icon={RefreshCw} label="Repeat limit" />
                          <input value={jobDraft.repeat ?? ''} onChange={e => setJobDraft(j => ({ ...j, repeat: e.target.value ? Number(e.target.value) : null }))} placeholder="blank = unlimited" type="number" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                        </label>
                        <label className="space-y-1.5">
                          <FieldLabel icon={Bot} label="Provider override" />
                          <input value={jobDraft.provider || ''} onChange={e => setJobDraft(j => ({ ...j, provider: e.target.value || null }))} placeholder="optional" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                        </label>
                        <label className="space-y-1.5">
                          <FieldLabel icon={Bot} label="Model override" />
                          <input value={jobDraft.model || ''} onChange={e => setJobDraft(j => ({ ...j, model: e.target.value || null }))} placeholder="optional" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                        </label>
                      </div>
                      <label className="space-y-1.5 block">
                        <FieldLabel icon={Folder} label="Working directory" />
                        <input value={jobDraft.workdir || ''} onChange={e => setJobDraft(j => ({ ...j, workdir: e.target.value || null }))} placeholder="/Users/justinfoote/project" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                      </label>
                      <label className="space-y-1.5 block">
                        <FieldLabel icon={Code2} label="Script" />
                        <textarea value={jobDraft.script || ''} onChange={e => setJobDraft(j => ({ ...j, script: e.target.value || null }))} placeholder="optional script or entrypoint" rows={3} className="w-full resize-y bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                      </label>
                    </section>

                    <div className="sticky bottom-0 bg-zinc-950/90 backdrop-blur border border-zinc-800 rounded-lg p-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        {cronMessage ? (
                          <p className={`text-xs truncate ${cronMessage.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>{cronMessage.text}</p>
                        ) : (
                          <p className="text-xs text-zinc-600 truncate">Save changes to send them to Hermes.</p>
                        )}
                      </div>
                      <button onClick={saveCronJob} disabled={cronSaving || !hasApiKey} className="shrink-0 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-bold uppercase tracking-wider">
                        {cronSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save Job
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        <main className="flex flex-col min-h-0">
          <div className="h-14 px-4 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-zinc-950/40">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-indigo-400" />
              <div>
                <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-300">Agent Chat</h3>
                <p className="text-[11px] text-zinc-600">Model: <span className="font-mono">{model}</span></p>
              </div>
            </div>
            {!hasApiKey && (
              <div className="flex items-center gap-2 text-[11px] text-amber-300">
                <Info className="w-3.5 h-3.5" />
                Configure Gateway in Settings
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 ? (
              <div className="h-full flex items-center justify-center text-center">
                <div className="max-w-md">
                  <div className="w-16 h-16 mx-auto rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
                    <Bot className="w-7 h-7 text-indigo-400" />
                  </div>
                  <h3 className="text-xl font-bold text-zinc-100 mb-2">Hermes Agent Chat</h3>
                  <p className="text-sm text-zinc-500 leading-relaxed">
                    Chat with the same Hermes Gateway that powers cron job management.
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
