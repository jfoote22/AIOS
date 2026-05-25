import { useEffect, useState } from 'react';
import Sidebar, { type TabId } from './components/Sidebar';
import SnippingTab from './tabs/SnippingTab';
import DeepDivesTab from './tabs/DeepDivesTab';
import SecondBrainTab from './tabs/SecondBrainTab';
import HermesTab from './tabs/HermesTab';
import ModelsTab from './tabs/ModelsTab';
import SubscriptionsTab from './tabs/SubscriptionsTab';
import { refreshConfigured, isConfigured } from './lib/providers';
import { setGeminiKey } from './lib/ai';
import { initApiBase } from './lib/apiBase';

export default function App() {
  const [active, setActive] = useState<TabId>('deepdives');
  const [collapsed, setCollapsed] = useState(false);
  const [apiReady, setApiReady] = useState(false);

  // On boot: resolve API base URL, load configured providers, hydrate Gemini key.
  useEffect(() => {
    (async () => {
      await initApiBase();
      setApiReady(true);
      await refreshConfigured();
      if (isConfigured('gemini') && window.aios?.getProviderKey) {
        try {
          const k = await window.aios.getProviderKey('gemini');
          if (k) setGeminiKey(k);
        } catch (e) { console.error('Failed to hydrate Gemini key:', e); }
      }
    })();
  }, []);

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
      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {active === 'deepdives' && <DeepDivesTab />}
        {active === 'snipping' && <SnippingTab />}
        {active === 'secondbrain' && <SecondBrainTab />}
        {active === 'hermes' && <HermesTab />}
        {active === 'models' && <ModelsTab />}
        {active === 'subscriptions' && <SubscriptionsTab />}
      </main>
    </div>
  );
}
