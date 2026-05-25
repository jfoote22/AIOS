import { Feather } from 'lucide-react';

export default function HermesTab() {
  return (
    <div className="flex-1 flex flex-col">
      <header className="h-16 border-b border-zinc-800 px-6 flex items-center bg-zinc-900/10 backdrop-blur-md shrink-0">
        <h2 className="text-sm font-bold text-zinc-400 uppercase tracking-widest">Hermes</h2>
      </header>
      <div className="flex-1 flex items-center justify-center p-12">
        <div className="max-w-md text-center space-y-5">
          <div className="w-20 h-20 mx-auto rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <Feather className="w-9 h-9 text-indigo-400" />
          </div>
          <h3 className="text-2xl font-bold">Hermes agent</h3>
          <p className="text-sm text-zinc-500 leading-relaxed">
            Reserved space for your Hermes agent. Layout, connection, and capabilities will be defined together — say the word and we'll wire it up.
          </p>
          <div className="text-[10px] text-zinc-600 uppercase tracking-widest pt-2">Phase 3</div>
        </div>
      </div>
    </div>
  );
}
