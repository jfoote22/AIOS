import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Bot, Plus, Trash2, Sparkles, Loader2, AlertCircle, FolderOpen, FileText, X, Save,
} from 'lucide-react';
import {
  listAgents, saveAgent, deleteAgent, newAgent, draftAgentField, slugify,
  TOOL_CATALOG, DEFAULT_TOOLS,
  type AgentDef, type DraftField,
} from '../lib/agents';
import { onAnthropicAuthModeChange } from '../lib/authMode';

interface Props { onAgentsChange?: (agents: AgentDef[]) => void; }

export default function AgentBuilder({ onAgentsChange }: Props) {
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDef | null>(null);
  const [drafting, setDrafting] = useState<DraftField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_authTick, setAuthTick] = useState(0);

  useEffect(() => onAnthropicAuthModeChange(() => setAuthTick(t => t + 1)), []);
  useEffect(() => { refresh(); }, []);

  const refresh = async () => {
    const list = await listAgents();
    setAgents(list);
    onAgentsChange?.(list);
  };

  const startNew = () => {
    const fresh = newAgent({
      name: '',
      description: '',
      systemPrompt: '',
      allowedTools: [...DEFAULT_TOOLS],
      workingDir: '',
    });
    setDraft(fresh);
    setSelectedId(null);
    setError(null);
  };

  const editExisting = (a: AgentDef) => {
    setDraft({ ...a });
    setSelectedId(a.id);
    setError(null);
  };

  const onChange = <K extends keyof AgentDef>(key: K, value: AgentDef[K]) => {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
  };

  const onNameChange = (name: string) => {
    if (!draft) return;
    // Auto-slug only if user hasn't manually overridden (i.e. slug still matches old name)
    const oldAuto = slugify(draft.name);
    const newSlug = draft.slug === oldAuto ? slugify(name) : draft.slug;
    setDraft({ ...draft, name, slug: newSlug });
  };

  const toggleTool = (tool: string) => {
    if (!draft) return;
    const set = new Set(draft.allowedTools);
    if (set.has(tool)) set.delete(tool); else set.add(tool);
    setDraft({ ...draft, allowedTools: Array.from(set) });
  };

  const runDraft = async (field: DraftField, hint?: string) => {
    if (!draft) return;
    setDrafting(field); setError(null);
    try {
      const { value } = await draftAgentField({
        field,
        currentValue: field === 'tools' ? JSON.stringify(draft.allowedTools) :
                      field === 'description' ? draft.description :
                      field === 'systemPrompt' ? draft.systemPrompt : '',
        hint,
        agent: draft,
      });
      if (field === 'tools') {
        try {
          const arr = JSON.parse(value);
          if (Array.isArray(arr)) setDraft({ ...draft, allowedTools: arr.filter(t => typeof t === 'string') });
        } catch { setError('AI returned a non-JSON tools value; left tools unchanged.'); }
      } else if (field === 'all') {
        try {
          const obj = JSON.parse(value);
          setDraft({
            ...draft,
            description: typeof obj.description === 'string' ? obj.description : draft.description,
            systemPrompt: typeof obj.systemPrompt === 'string' ? obj.systemPrompt : draft.systemPrompt,
            allowedTools: Array.isArray(obj.tools) ? obj.tools.filter((t: any) => typeof t === 'string') : draft.allowedTools,
          });
        } catch { setError('AI returned non-JSON for full draft.'); }
      } else if (field === 'description') {
        setDraft({ ...draft, description: value });
      } else if (field === 'systemPrompt') {
        setDraft({ ...draft, systemPrompt: value });
      }
      setToast(`Drafted ${field}`);
      setTimeout(() => setToast(null), 1500);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setDrafting(null);
    }
  };

  const onSave = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { setError('Name is required.'); return; }
    setError(null);
    const { filePath, warning } = await saveAgent(draft);
    if (warning) setError(warning);
    if (filePath) setToast(`Saved to ${shortPath(filePath)}`);
    else if (!warning) setToast('Saved');
    setTimeout(() => setToast(null), 2500);
    await refresh();
    setSelectedId(draft.id);
  };

  const onDelete = async () => {
    if (!draft) return;
    if (!confirm(`Delete agent "${draft.name}"? This also removes the .md file.`)) return;
    await deleteAgent(draft.id, {
      alsoDeleteFile: true,
      workingDir: draft.workingDir,
      slug: draft.slug,
    });
    setDraft(null);
    setSelectedId(null);
    await refresh();
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <header className="h-10 px-3 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <Bot className="w-3.5 h-3.5 text-indigo-400" />
        <span className="text-[11px] uppercase tracking-widest text-zinc-300">Agents</span>
        <button
          onClick={startNew}
          title="New agent"
          className="ml-auto p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex-1 min-h-0 flex">
        {/* Agent list (left rail) */}
        <aside className="w-40 shrink-0 border-r border-zinc-800/60 overflow-y-auto p-1.5 space-y-1">
          {agents.length === 0 && !draft && (
            <button
              onClick={startNew}
              className="w-full py-4 text-[11px] text-zinc-500 hover:text-white border border-dashed border-zinc-800 rounded"
            >
              + New agent
            </button>
          )}
          {agents.map(a => (
            <button
              key={a.id}
              onClick={() => editExisting(a)}
              className={`w-full text-left px-2 py-1.5 rounded text-[11px] truncate transition-colors ${
                selectedId === a.id ? 'bg-indigo-600/20 text-indigo-200 border border-indigo-500/30' : 'text-zinc-400 hover:text-white hover:bg-zinc-900 border border-transparent'
              }`}
              title={a.description || a.name}
            >
              {a.name || a.slug}
            </button>
          ))}
        </aside>

        {/* Editor */}
        <div className="flex-1 min-w-0 overflow-y-auto p-3 space-y-3">
          {!draft ? (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-3 py-12">
              <Bot className="w-8 h-8 text-zinc-700" />
              <p className="text-[12px] text-zinc-500">Pick an agent or create a new one.</p>
            </div>
          ) : (
            <>
              <Row label="Name">
                <input
                  value={draft.name}
                  onChange={e => onNameChange(e.target.value)}
                  placeholder="e.g. Code Reviewer"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60"
                />
                <div className="text-[10px] text-zinc-600 mt-1">
                  slug: <code className="text-zinc-400">{draft.slug}</code>
                </div>
              </Row>

              <Row label="Description" assist={() => runDraft('description')} busy={drafting === 'description'}>
                <textarea
                  value={draft.description}
                  onChange={e => onChange('description', e.target.value)}
                  rows={2}
                  placeholder="What this agent does and when to use it"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 resize-none"
                />
              </Row>

              <Row label="System prompt" assist={() => runDraft('systemPrompt')} busy={drafting === 'systemPrompt'}>
                <textarea
                  value={draft.systemPrompt}
                  onChange={e => onChange('systemPrompt', e.target.value)}
                  rows={8}
                  placeholder="You are a specialized agent that…"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 resize-y font-mono"
                />
              </Row>

              <Row label="Allowed tools" assist={() => runDraft('tools')} busy={drafting === 'tools'}>
                <div className="grid grid-cols-2 gap-1">
                  {TOOL_CATALOG.map(t => {
                    const on = draft.allowedTools.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        onClick={() => toggleTool(t.id)}
                        title={t.description}
                        className={`text-left px-2 py-1 rounded text-[11px] border transition-colors ${
                          on
                            ? t.danger
                              ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                              : 'bg-indigo-500/15 border-indigo-500/40 text-indigo-200'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-white'
                        }`}
                      >
                        {t.label}
                        {t.danger && on && <span className="ml-1 text-[9px]">⚠</span>}
                      </button>
                    );
                  })}
                </div>
                {draft.allowedTools.some(t => TOOL_CATALOG.find(x => x.id === t)?.danger) && (
                  <div className="text-[10px] text-amber-400/80 mt-1">⚠ Includes write/exec tools. Use a sandbox working dir.</div>
                )}
              </Row>

              <div className="grid grid-cols-2 gap-2">
                <Row label="Model">
                  <select
                    value={draft.model}
                    onChange={e => onChange('model', e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-100 focus:outline-none focus:border-indigo-500/60"
                  >
                    <option value="inherit">inherit (use Models tab default)</option>
                    <option value="claude-opus-4-7">claude-opus-4-7</option>
                    <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                    <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
                  </select>
                </Row>

                <Row label="Working directory">
                  <div className="flex gap-1">
                    <input
                      value={draft.workingDir}
                      onChange={e => onChange('workingDir', e.target.value)}
                      placeholder="Leave blank to inherit from board's project root"
                      className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/60 font-mono"
                    />
                    <button
                      onClick={async () => {
                        const picked = await window.aios?.pickFolder({
                          title: `Working dir for ${draft.name || 'agent'}`,
                          defaultPath: draft.workingDir || undefined,
                        });
                        if (picked) onChange('workingDir', picked);
                      }}
                      title="Pick a folder. Overrides the board's project root for this agent."
                      className="p-1.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="text-[10px] text-zinc-600 mt-1">
                    Empty = inherit board project root. Card-level overrides win over both.
                  </div>
                </Row>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-[11px]">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span className="flex-1">{error}</span>
                  <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200"><X className="w-3 h-3" /></button>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => runDraft('all', 'Generate a complete first-pass agent definition based on the name')}
                  disabled={!!drafting || !draft.name.trim()}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-[11px]"
                  title="Have Claude draft everything based on the name"
                >
                  {drafting === 'all' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-indigo-400" />}
                  Draft from name
                </button>
                <button
                  onClick={onSave}
                  disabled={!draft.name.trim()}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-[11px] font-bold uppercase tracking-wider"
                >
                  <Save className="w-3 h-3" />
                  Save agent
                </button>
                {selectedId && (
                  <button
                    onClick={onDelete}
                    title="Delete this agent"
                    className="p-1.5 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {draft.workingDir && (
                <div className="text-[10px] text-zinc-600 flex items-center gap-1">
                  <FileText className="w-3 h-3" />
                  Will write{' '}
                  <code className="text-zinc-400">{draft.workingDir.replace(/\\/g, '/')}/.claude/agents/{draft.slug}.md</code>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {toast && (
        <motion.div
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[11px] z-10 pointer-events-none"
        >
          {toast}
        </motion.div>
      )}
    </div>
  );
}

function Row({ label, children, assist, busy }: {
  label: string;
  children: React.ReactNode;
  assist?: () => void;
  busy?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center mb-1">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
        {assist && (
          <button
            onClick={assist}
            disabled={busy}
            title="Ask Claude to fill / refine this field"
            className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-indigo-400 hover:text-indigo-200 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            <span className="uppercase tracking-wider">{busy ? 'Asking…' : 'Ask Claude'}</span>
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function shortPath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  return norm.length > 60 ? '…' + norm.slice(-58) : norm;
}
