import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Wrench, Plus, Trash2, Sparkles, Loader2, AlertCircle, FolderOpen, FileText, X, Save,
} from 'lucide-react';
import {
  listSkills, saveSkill, deleteSkill, newSkill, draftSkillField, slugify,
  onSkillsChanged, SKILL_TOOL_CATALOG, DEFAULT_SKILL_TOOLS,
  type SkillDef, type SkillDraftField,
} from '../lib/skills';
import { loadBoard } from '../lib/kanban';
import { onAnthropicAuthModeChange } from '../lib/authMode';

interface Props { onSkillsChange?: (skills: SkillDef[]) => void; }

export default function SkillBuilder({ onSkillsChange }: Props) {
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SkillDef | null>(null);
  const [drafting, setDrafting] = useState<SkillDraftField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [boardProjectRoot, setBoardProjectRoot] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_authTick, setAuthTick] = useState(0);

  useEffect(() => onAnthropicAuthModeChange(() => setAuthTick(t => t + 1)), []);
  useEffect(() => {
    refresh();
    loadBoard().then(board => setBoardProjectRoot(board.projectRoot?.trim() || '')).catch(() => setBoardProjectRoot(''));
  }, []);
  useEffect(() => onSkillsChanged(() => {
    refresh();
    loadBoard().then(board => setBoardProjectRoot(board.projectRoot?.trim() || '')).catch(() => {});
  }), []);

  const refresh = async () => {
    const list = await listSkills();
    setSkills(list);
    onSkillsChange?.(list);
  };

  const startNew = () => {
    const fresh = newSkill({
      name: '',
      description: '',
      instructions: '',
      allowedTools: [...DEFAULT_SKILL_TOOLS],
      workingDir: '',
    });
    setDraft(fresh);
    setSelectedId(null);
    setError(null);
  };

  const editExisting = (s: SkillDef) => {
    setDraft({ ...s });
    setSelectedId(s.id);
    setError(null);
  };

  const onChange = <K extends keyof SkillDef>(key: K, value: SkillDef[K]) => {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
  };

  const onNameChange = (name: string) => {
    if (!draft) return;
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

  const runDraft = async (field: SkillDraftField, hint?: string) => {
    if (!draft) return;
    setDrafting(field); setError(null);
    try {
      const { value } = await draftSkillField({
        field,
        currentValue: field === 'tools' ? JSON.stringify(draft.allowedTools) :
                      field === 'description' ? draft.description :
                      field === 'instructions' ? draft.instructions : '',
        hint,
        skill: draft,
      });
      if (field === 'tools') {
        try {
          const arr = JSON.parse(value);
          if (Array.isArray(arr)) setDraft({ ...draft, allowedTools: arr.filter((t: any) => typeof t === 'string') });
        } catch { setError('AI returned a non-JSON tools value; left tools unchanged.'); }
      } else if (field === 'all') {
        try {
          const obj = JSON.parse(value);
          setDraft({
            ...draft,
            description: typeof obj.description === 'string' ? obj.description : draft.description,
            instructions: typeof obj.instructions === 'string' ? obj.instructions : draft.instructions,
            allowedTools: Array.isArray(obj.tools) ? obj.tools.filter((t: any) => typeof t === 'string') : draft.allowedTools,
          });
        } catch { setError('AI returned non-JSON for full draft.'); }
      } else if (field === 'description') {
        setDraft({ ...draft, description: value });
      } else if (field === 'instructions') {
        setDraft({ ...draft, instructions: value });
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
    const latestBoard = await loadBoard().catch(() => null);
    const latestProjectRoot = latestBoard?.projectRoot?.trim() || boardProjectRoot;
    setBoardProjectRoot(latestProjectRoot);
    const { filePath, warning } = await saveSkill(draft, { fallbackWorkingDir: latestProjectRoot });
    if (warning) setError(warning);
    if (filePath) setToast(`Saved to ${shortPath(filePath)}`);
    else if (!warning) setToast('Saved');
    setTimeout(() => setToast(null), 2500);
    await refresh();
    setSelectedId(draft.id);
  };

  const onDelete = async () => {
    if (!draft) return;
    if (!confirm(`Delete skill "${draft.name}"? This also removes its .claude/skills/${draft.slug}/ folder.`)) return;
    const latestBoard = await loadBoard().catch(() => null);
    await deleteSkill(draft.id, {
      alsoDeleteFiles: true,
      workingDir: draft.workingDir || latestBoard?.projectRoot?.trim() || boardProjectRoot,
      slug: draft.slug,
    });
    setDraft(null);
    setSelectedId(null);
    await refresh();
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <header className="h-10 px-3 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <Wrench className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-[11px] uppercase tracking-widest text-zinc-300">Skills</span>
        <button
          onClick={startNew}
          title="New skill"
          className="ml-auto p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex-1 min-h-0 flex">
        {/* Skill list (left rail) */}
        <aside className="w-40 shrink-0 border-r border-zinc-800/60 overflow-y-auto p-1.5 space-y-1">
          {skills.length === 0 && !draft && (
            <button
              onClick={startNew}
              className="w-full py-4 text-[11px] text-zinc-500 hover:text-white border border-dashed border-zinc-800 rounded"
            >
              + New skill
            </button>
          )}
          {skills.map(s => (
            <button
              key={s.id}
              onClick={() => editExisting(s)}
              className={`w-full text-left px-2 py-1.5 rounded text-[11px] truncate transition-colors ${
                selectedId === s.id ? 'bg-emerald-600/20 text-emerald-200 border border-emerald-500/30' : 'text-zinc-400 hover:text-white hover:bg-zinc-900 border border-transparent'
              }`}
              title={s.description || s.name}
            >
              {s.name || s.slug}
            </button>
          ))}
        </aside>

        {/* Editor */}
        <div className="flex-1 min-w-0 overflow-y-auto p-3 space-y-3">
          {!draft ? (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-3 py-12">
              <Wrench className="w-8 h-8 text-zinc-700" />
              <p className="text-[12px] text-zinc-500">Pick a skill or create a new one.</p>
            </div>
          ) : (
            <>
              <Row label="Name">
                <input
                  value={draft.name}
                  onChange={e => onNameChange(e.target.value)}
                  placeholder="e.g. PDF Form Filler"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/60"
                />
                <div className="text-[10px] text-zinc-600 mt-1">
                  slug: <code className="text-zinc-400">{draft.slug}</code>
                </div>
              </Row>

              <Row label="Description (what + when to use)" assist={() => runDraft('description')} busy={drafting === 'description'}>
                <textarea
                  value={draft.description}
                  onChange={e => onChange('description', e.target.value)}
                  rows={2}
                  placeholder="What this skill does and the conditions under which Claude should use it"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/60 resize-none"
                />
              </Row>

              <Row label="Instructions (SKILL.md body)" assist={() => runDraft('instructions')} busy={drafting === 'instructions'}>
                <textarea
                  value={draft.instructions}
                  onChange={e => onChange('instructions', e.target.value)}
                  rows={10}
                  placeholder={'# How to use this skill\n\nStep-by-step guidance Claude should follow when this skill is active…'}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/60 resize-y font-mono"
                />
              </Row>

              <Row label="Allowed tools (optional)" assist={() => runDraft('tools')} busy={drafting === 'tools'}>
                <div className="grid grid-cols-2 gap-1">
                  {SKILL_TOOL_CATALOG.map(t => {
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
                              : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-white'
                        }`}
                      >
                        {t.label}
                        {t.danger && on && <span className="ml-1 text-[9px]">⚠</span>}
                      </button>
                    );
                  })}
                </div>
                <div className="text-[10px] text-zinc-600 mt-1">
                  Leave all off to let the skill inherit the session's tools.
                </div>
              </Row>

              <Row label="Working directory">
                <div className="flex gap-1">
                  <input
                    value={draft.workingDir}
                    onChange={e => onChange('workingDir', e.target.value)}
                    placeholder="Leave blank to inherit from board's project root"
                    className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/60 font-mono"
                  />
                  <button
                    onClick={async () => {
                      const picked = await window.aios?.pickFolder({
                        title: `Working dir for ${draft.name || 'skill'}`,
                        defaultPath: draft.workingDir || boardProjectRoot || undefined,
                      });
                      if (picked) onChange('workingDir', picked);
                    }}
                    title="Pick a folder. Overrides the board's project root for this skill."
                    className="p-1.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="text-[10px] text-zinc-600 mt-1">
                  Empty = inherit board project root.
                </div>
              </Row>

              {error && (
                <div className="flex items-start gap-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-[11px]">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span className="flex-1">{error}</span>
                  <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200"><X className="w-3 h-3" /></button>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => runDraft('all', 'Generate a complete first-pass skill definition based on the name')}
                  disabled={!!drafting || !draft.name.trim()}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-[11px]"
                  title="Have Claude draft everything based on the name"
                >
                  {drafting === 'all' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-emerald-400" />}
                  Draft from name
                </button>
                <button
                  onClick={onSave}
                  disabled={!draft.name.trim()}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[11px] font-bold uppercase tracking-wider"
                >
                  <Save className="w-3 h-3" />
                  Save skill
                </button>
                {selectedId && (
                  <button
                    onClick={onDelete}
                    title="Delete this skill"
                    className="p-1.5 rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {(draft.workingDir || boardProjectRoot) && (
                <div className="text-[10px] text-zinc-600 flex items-center gap-1">
                  <FileText className="w-3 h-3" />
                  Will write{' '}
                  <code className="text-zinc-400">{(draft.workingDir || boardProjectRoot).replace(/\\/g, '/')}/.claude/skills/{draft.slug}/SKILL.md</code>
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
            className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-emerald-400 hover:text-emerald-200 disabled:opacity-50"
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
