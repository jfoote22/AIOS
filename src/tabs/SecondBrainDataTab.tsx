import { useRef, useState } from 'react';
import {
  Brain, Download, Upload, AlertCircle, CheckCircle2, X, Loader2,
} from 'lucide-react';
import {
  exportSecondBrain, importSecondBrain, type BackupCounts,
} from '../lib/secondBrainBackup';

function summarize(c: BackupCounts): string {
  const parts: string[] = [];
  if (c.snippets) parts.push(`${c.snippets} neuron${c.snippets === 1 ? '' : 's'}`);
  if (c.threads) parts.push(`${c.threads} deep dive${c.threads === 1 ? '' : 's'}`);
  if (c.imports) parts.push(`${c.imports} conversation${c.imports === 1 ? '' : 's'}`);
  if (c.importChunks) parts.push(`${c.importChunks} indexed chunk${c.importChunks === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'no data';
}

export default function SecondBrainDataTab() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const onExport = async () => {
    setBusy('export'); setError(null); setNote(null);
    try {
      const { counts, filename } = await exportSecondBrain();
      setNote(`Exported ${summarize(counts)} → ${filename}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy('import'); setError(null); setNote(null);
    try {
      const counts = await importSecondBrain(file);
      setNote(`Imported ${summarize(counts)}. Your Second Brain has been updated.`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="h-14 border-b border-zinc-800 px-6 flex items-center gap-3 bg-zinc-900/10 backdrop-blur-md shrink-0">
        <div className="p-1.5 bg-zinc-800 rounded-md"><Brain className="w-4 h-4 text-indigo-400" /></div>
        <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-100">Second Brain Data</h2>
        <span className="text-[11px] text-zinc-500">Back up or restore everything in your Second Brain</span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
        <div className="max-w-xl space-y-4">
          {(error || note) && (
            <div>
              {error && (
                <div className="flex items-start gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-300 text-[12px]">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span className="flex-1">{error}</span>
                  <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              {note && (
                <div className="flex items-start gap-2 p-3 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[12px]">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                  <span className="flex-1">{note}</span>
                  <button onClick={() => setNote(null)} className="text-emerald-300/70 hover:text-emerald-200">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Export */}
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-md bg-indigo-500/15 border border-indigo-500/30 shrink-0">
                <Download className="w-4 h-4 text-indigo-300" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[13px] font-semibold text-zinc-100">Export</h3>
                <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
                  Save every neuron, deep dive, imported conversation, indexed chunk,
                  and your view preferences into a single JSON file you can keep or move
                  to another machine.
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={onExport}
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-[11px] font-bold uppercase tracking-wider transition-colors"
              >
                {busy === 'export' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                {busy === 'export' ? 'Exporting…' : 'Export all data'}
              </button>
            </div>
          </section>

          {/* Import */}
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-md bg-zinc-800 border border-zinc-700 shrink-0">
                <Upload className="w-4 h-4 text-zinc-300" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[13px] font-semibold text-zinc-100">Import</h3>
                <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
                  Load a backup file. It merges into your current Second Brain —
                  matching entries are updated and nothing existing is deleted.
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 disabled:cursor-not-allowed text-zinc-100 text-[11px] font-bold uppercase tracking-wider transition-colors"
              >
                {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {busy === 'import' ? 'Importing…' : 'Import backup'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={e => onImportFile(e.target.files?.[0])}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
