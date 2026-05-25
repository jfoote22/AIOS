import { CreditCard } from 'lucide-react';

export default function SubscriptionsTab() {
  return (
    <div className="flex-1 flex flex-col">
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center bg-zinc-900/10 backdrop-blur-md shrink-0">
        <h2 className="text-sm font-bold text-zinc-400 uppercase tracking-widest">AI Subscriptions</h2>
      </header>
      <div className="flex-1 flex items-center justify-center p-12">
        <div className="max-w-md text-center space-y-5">
          <div className="w-20 h-20 mx-auto rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <CreditCard className="w-9 h-9 text-indigo-400" />
          </div>
          <h3 className="text-2xl font-bold">AI subscriptions dashboard</h3>
          <p className="text-sm text-zinc-500 leading-relaxed">
            Track which AI services you subscribe to, monthly cost, usage, and renewal dates. Pulls from manual entries first; can later integrate with provider billing APIs where available.
          </p>
          <div className="text-[10px] text-zinc-600 uppercase tracking-widest pt-2">Phase 3</div>
        </div>
      </div>
    </div>
  );
}
