import { useEffect, useState } from 'react';
import Sidebar, { type TabId } from './components/Sidebar';
import SnippingTab from './tabs/SnippingTab';
import DeepDivesTab from './tabs/DeepDivesTab';
import SecondBrainTab from './tabs/SecondBrainTab';
import HermesTab from './tabs/HermesTab';
import KanbanTab from './tabs/KanbanTab';
import TerminalTab from './tabs/TerminalTab';
import SettingsTab from './tabs/SettingsTab';
import { refreshConfigured, isConfigured } from './lib/providers';
import { setGeminiKey } from './lib/ai';
import { initApiBase } from './lib/apiBase';
import { refreshModels } from './lib/models';
import { onNavigate } from './lib/navigate';
import ErrorBoundary from './components/ErrorBoundary';

function TabPanel({ active, label, children }: { active: boolean; label: string; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col" style={{ display: active ? 'flex' : 'none' }}>
      <ErrorBoundary label={label}>{children}</ErrorBoundary>
    </div>
  );
}

export default function App() {
  const [active, setActive] = useState<TabId>('deepdives');
  const [collapsed, setCollapsed] = useState(false);
  const [apiReady, setApiReady] = useState(false);

  // On boot: resolve API base URL, load configured providers, hydrate Gemini key.
  useEffect(() => {
    (async () => {
      await initApiBase();
      setApiReady(true);
      await Promise.all([refreshConfigured(), refreshModels()]);
      if (isConfigured('gemini') && window.aios?.getProviderKey) {
        try {
          const k = await window.aios.getProviderKey('gemini');
          if (k) setGeminiKey(k);
        } catch (e) { console.error('Failed to hydrate Gemini key:', e); }
      }
    })();
  }, []);

  useEffect(() => onNavigate(setActive), []);

  const quickSnip = () => {
    if (window.aios?.isElectron) window.aios.requestCapture();
    else alert('Global snipping is only available in the desktop app.');
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100 font-sans selection:bg-indigo-500/30">
      <Sidebar
        active={active}
        onSelect={setActive}
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
        onQuickSnip={quickSnip}
      />
      <main className="flex-1 min-w-0 overflow-hidden flex flex-col relative">
        {/* All tabs stay mounted so in-progress state (e.g. an active DeepDive
            chat) survives sidebar navigation. Inactive tabs are hidden, not
            unmounted. */}
        <TabPanel active={active === 'deepdives'} label="DeepDives"><DeepDivesTab /></TabPanel>
        <TabPanel active={active === 'snipping'} label="Snipping"><SnippingTab /></TabPanel>
        <TabPanel active={active === 'secondbrain'} label="Second Brain"><SecondBrainTab active={active === 'secondbrain'} /></TabPanel>
        <TabPanel active={active === 'hermes'} label="Hermes"><HermesTab /></TabPanel>
        <TabPanel active={active === 'terminal'} label="Terminal"><TerminalTab active={active === 'terminal'} /></TabPanel>
        <TabPanel active={active === 'kanban'} label="Kanban"><KanbanTab /></TabPanel>
        <TabPanel active={active === 'settings'} label="Settings"><SettingsTab /></TabPanel>
      </main>
    </div>
  );
}
