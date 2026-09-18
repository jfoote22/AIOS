import { useState } from 'react';
import { Settings as SettingsIcon, Sliders, CreditCard, Download, Server } from 'lucide-react';
import ModelsTab from './ModelsTab';
import SubscriptionsTab from './SubscriptionsTab';
import ImportsTab from './ImportsTab';
import HermesSettingsTab from './HermesSettingsTab';

type SettingsSection = 'models' | 'hermes' | 'subscriptions' | 'imports';

interface SectionDef {
  id: SettingsSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SECTIONS: SectionDef[] = [
  { id: 'models',        label: 'Models',        icon: Sliders },
  { id: 'hermes',        label: 'Hermes',        icon: Server },
  { id: 'subscriptions', label: 'Subscriptions', icon: CreditCard },
  { id: 'imports',       label: 'Imports',       icon: Download },
];

function Panel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col" style={{ display: active ? 'flex' : 'none' }}>
      {children}
    </div>
  );
}

export default function SettingsTab() {
  const [section, setSection] = useState<SettingsSection>('models');

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center gap-4 bg-zinc-900/10 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-zinc-800 rounded-md"><SettingsIcon className="w-4 h-4 text-indigo-400" /></div>
          <h1 className="text-sm font-bold uppercase tracking-widest text-zinc-100">Settings</h1>
        </div>

        <div className="flex items-center gap-1 bg-zinc-900/60 p-1 rounded-lg border border-zinc-800">
          {SECTIONS.map(s => {
            const Icon = s.icon;
            const isActive = s.id === section;
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-bold uppercase tracking-wider transition-colors ${
                  isActive ? 'bg-indigo-600/20 text-indigo-300' : 'text-zinc-500 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {s.label}
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex-1 min-w-0 overflow-hidden flex flex-col relative">
        {/* Keep all sections mounted so in-progress drafts (e.g. a half-typed key or
            subscription entry) survive switching between Models and Subscriptions. */}
        <Panel active={section === 'models'}><ModelsTab /></Panel>
        <Panel active={section === 'hermes'}><HermesSettingsTab /></Panel>
        <Panel active={section === 'subscriptions'}><SubscriptionsTab /></Panel>
        <Panel active={section === 'imports'}><ImportsTab /></Panel>
      </div>
    </div>
  );
}
