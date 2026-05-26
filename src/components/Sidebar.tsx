import { motion } from 'motion/react';
import { Compass, Scissors, Brain, Feather, Settings, ChevronLeft, ChevronRight, Camera, KanbanSquare, Terminal as TerminalIcon } from 'lucide-react';

export type TabId = 'deepdives' | 'snipping' | 'secondbrain' | 'terminal' | 'kanban' | 'hermes' | 'settings';

interface TabDef { id: TabId; label: string; icon: React.ComponentType<{ className?: string }>; }
const MAIN_TABS: TabDef[] = [
  { id: 'deepdives',     label: 'DeepDives',     icon: Compass },
  { id: 'snipping',      label: 'Snipping',      icon: Scissors },
  { id: 'secondbrain',   label: 'Second Brain',  icon: Brain },
  { id: 'terminal',      label: 'Terminal',      icon: TerminalIcon },
  { id: 'kanban',        label: 'Orchestrator',  icon: KanbanSquare },
  { id: 'hermes',        label: 'Hermes',        icon: Feather },
];

const SETTINGS_TAB: TabDef = { id: 'settings', label: 'Settings', icon: Settings };

interface Props {
  active: TabId;
  onSelect: (id: TabId) => void;
  collapsed: boolean;
  onToggle: () => void;
  onQuickSnip: () => void;
}

export default function Sidebar({ active, onSelect, collapsed, onToggle, onQuickSnip }: Props) {
  const renderTab = (t: TabDef) => {
    const Icon = t.icon;
    const isActive = t.id === active;
    return (
      <button
        key={t.id}
        onClick={() => onSelect(t.id)}
        title={collapsed ? t.label : undefined}
        className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-3 px-3'} py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30' : 'text-zinc-400 hover:text-white hover:bg-zinc-800/60 border border-transparent'}`}
      >
        <Icon className="w-4 h-4 shrink-0" />
        {!collapsed && <span className="truncate">{t.label}</span>}
      </button>
    );
  };

  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 240 }}
      transition={{ type: 'spring', stiffness: 260, damping: 28 }}
      className="h-full bg-zinc-900/60 border-r border-zinc-800 flex flex-col select-none"
    >
      <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between'} px-4 h-16 border-b border-zinc-800`}>
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center">
              <Camera className="w-4 h-4 text-white" />
            </div>
            <span className="text-sm font-bold tracking-tight">AIOS</span>
          </div>
        )}
        <button
          onClick={onToggle}
          className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>

      <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto scrollbar-hide">
        {MAIN_TABS.map(renderTab)}
      </nav>

      {/* Settings sits just above the Snip CTA so prefs are always within reach */}
      <div className="px-2 py-2 border-t border-zinc-800/60">
        {renderTab(SETTINGS_TAB)}
      </div>

      <div className="p-2 border-t border-zinc-800">
        <button
          onClick={onQuickSnip}
          title="Quick snip (Ctrl+Shift+S)"
          className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-2 px-3'} py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-wider transition-all active:scale-95 shadow-lg shadow-indigo-600/10`}
        >
          <Scissors className="w-3.5 h-3.5 shrink-0" />
          {!collapsed && <span>Snip</span>}
        </button>
      </div>
    </motion.aside>
  );
}
