import { useEffect, useState } from 'react';
import { Bot, Wrench, FileEdit, Code2 } from 'lucide-react';
import AgentBuilder from './AgentBuilder';
import SkillBuilder from './SkillBuilder';
import IdeEditor from './IdeEditor';
import { ensureBuiltInAgents, listAgents, type AgentDef } from '../lib/agents';
import { loadBoard } from '../lib/kanban';

type Kind = 'agents' | 'skills';
type Mode = 'form' | 'editor';

interface Props { onAgentsChange?: (agents: AgentDef[]) => void; }

// Left pane of the Orchestra tab. Hosts the Agent and Skill creators behind two
// toggles: which thing you're authoring (Agents | Skills) and how (Form, the
// guided builder · Editor, a Monaco/VS-Code-style file editor over the item's
// .claude folder).
export default function CreatorPanel({ onAgentsChange }: Props) {
  const [kind, setKind] = useState<Kind>('agents');
  const [mode, setMode] = useState<Mode>('form');
  const [baseDir, setBaseDir] = useState('');

  // Seed the board's agent list + the editor's default working dir once, so the
  // Kanban board stays populated even when the user is on the Skills/Editor view
  // (where AgentBuilder — which normally reports the list — is unmounted).
  useEffect(() => {
    ensureBuiltInAgents().then(listAgents).then(list => onAgentsChange?.(list)).catch(() => {});
    loadBoard().then(b => setBaseDir(prev => prev || b.projectRoot?.trim() || '')).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accent: 'indigo' | 'emerald' = kind === 'agents' ? 'indigo' : 'emerald';

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      {/* Toggle bar */}
      <div className="h-9 px-2 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
        <Segmented
          value={kind}
          onChange={(v) => setKind(v as Kind)}
          options={[
            { value: 'agents', label: 'Agents', icon: <Bot className="w-3 h-3" /> },
            { value: 'skills', label: 'Skills', icon: <Wrench className="w-3 h-3" /> },
          ]}
          activeClass={kind === 'agents' ? 'bg-indigo-600/30 text-indigo-100 border-indigo-500/50' : 'bg-emerald-600/30 text-emerald-100 border-emerald-500/50'}
        />
        <div className="ml-auto">
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as Mode)}
            options={[
              { value: 'form', label: 'Form', icon: <FileEdit className="w-3 h-3" /> },
              { value: 'editor', label: 'Editor', icon: <Code2 className="w-3 h-3" /> },
            ]}
            activeClass="bg-zinc-700 text-zinc-100 border-zinc-600"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {mode === 'editor' ? (
          <IdeEditor
            baseDir={baseDir}
            sub={kind}
            onChangeBaseDir={setBaseDir}
            accent={accent}
          />
        ) : kind === 'agents' ? (
          <AgentBuilder onAgentsChange={onAgentsChange} />
        ) : (
          <SkillBuilder />
        )}
      </div>
    </div>
  );
}

function Segmented({ value, onChange, options, activeClass }: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; icon: React.ReactNode }>;
  activeClass: string;
}) {
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-zinc-950/60 border border-zinc-800">
      {options.map(opt => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border transition-colors ${
              on ? activeClass : 'border-transparent text-zinc-500 hover:text-zinc-200'
            }`}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
