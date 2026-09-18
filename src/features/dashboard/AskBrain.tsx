import { useRef, useState } from "react";
import { Brain, Telescope, ArrowUpRight, Search, Sparkles } from "lucide-react";
import { Button, Badge, Spinner, cn } from "@/ui";
import * as db from "@/lib/db";
import * as ai from "@/lib/ai";
import { setSeed } from "@/lib/deepdiveSeed";
import { navigateTo } from "@/lib/navigate";
import { useExternalInputSync } from "@/lib/useExternalInputSync";
import { colorFor } from "./data";

interface NeuronFull {
  id: string;
  title?: string;
  summary?: string;
  category?: string;
  tags?: string[];
  extractedText?: string;
  embedding?: number[];
  timestamp?: number;
  source?: string;
  status?: string;
}
interface Result extends NeuronFull {
  sim: number;
}

const TOP_K = 6;
const MIN_SIM = 0.4; // matches the Second Brain Ask threshold

/**
 * Ask the brain — REAL retrieval + grounded answer. Embeds the question, ranks
 * every neuron by cosine similarity over its stored embedding (same pipeline as
 * the Second Brain Ask), synthesizes a grounded answer from the top neurons via
 * chatWithVault, and lets you select any retrieved neuron to drill into a
 * DeepDive seeded with that neuron + your question. (Needs a Gemini key.)
 */
export default function AskBrain() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [askedFor, setAskedFor] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Adopt text injected by dictation tools (e.g. Wispr Flow) that write the
  // DOM value directly and bypass React's onChange.
  useExternalInputSync(inputRef, q, setQ);

  const ask = async () => {
    // Read the live DOM value, not just state — a dictation tool may have
    // injected text moments ago that the sync hook hasn't adopted yet.
    const query = (inputRef.current?.value ?? q).trim();
    if (!query) return;
    if (!ai.isGeminiReady()) {
      setResults(null);
      setAnswer(null);
      setErr("Add your Gemini key in Settings → Models so the brain can search by meaning.");
      return;
    }
    setBusy(true);
    setErr(null);
    setAnswer(null);

    let scored: Result[] = [];
    try {
      const [qvec, snippets] = await Promise.all([
        ai.embedText(query),
        db.getAllSnippets<NeuronFull>(),
      ]);
      scored = snippets
        .filter((s) => s.embedding && s.embedding.length === qvec.length && s.status !== "error")
        .map((s) => ({ ...s, sim: ai.cosineSimilarity(qvec, s.embedding!) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, TOP_K)
        .filter((r) => r.sim >= MIN_SIM);
      setAskedFor(query);
      setResults(scored);
      if (!scored.length) setErr("No related neurons yet — capture or ingest more, then ask again.");
    } catch (e) {
      setResults(null);
      setErr((e as Error)?.message || String(e));
      setBusy(false);
      return;
    }
    setBusy(false);

    // Grounded answer from the retrieved neurons (same generator the tab uses).
    if (scored.length) {
      const context: ai.VaultContextItem[] = scored.map((r) => ({
        id: `snip:${r.id}`,
        title: r.title || "",
        summary: r.summary || "",
        category: r.category || "",
        source: r.source || "",
        tags: r.tags || [],
        extractedText: r.extractedText || "",
        timestamp: r.timestamp || 0,
      }));
      setAnswering(true);
      setAnswer("");
      try {
        let acc = "";
        for await (const ch of ai.chatWithVault([], query, context)) {
          acc += ch;
          setAnswer(acc);
        }
      } catch (e) {
        setAnswer(`(couldn't synthesize an answer — ${(e as Error)?.message || String(e)})`);
      } finally {
        setAnswering(false);
      }
    }
  };

  const drill = (r: Result) => {
    const body = (r.extractedText || r.summary || r.title || "").slice(0, 6000);
    setSeed({
      title: r.title || "Neuron",
      source: `Brain · ${r.category || "neuron"}`,
      body: `Context from my Second Brain:\n\n${body}\n\nQuestion: ${askedFor || q.trim()}`,
    });
    navigateTo("deepdives");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3 pointer-events-none" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ask();
              }
            }}
            placeholder="Ask your brain — e.g. “what do I know about vector databases?”"
            className="w-full h-10 pl-9 pr-3 rounded-[var(--radius-md)] bg-surface-2 border border-line text-sm text-ink placeholder:text-ink-4 focus-ring focus:border-accent transition-colors"
          />
        </div>
        <Button variant="primary" onClick={ask} loading={busy} leftIcon={<Brain className="w-4 h-4" />}>
          Ask
        </Button>
      </div>

      {busy && (
        <div className="py-6 flex justify-center">
          <Spinner label="Searching your neurons by meaning…" />
        </div>
      )}

      {!busy && err && (
        <div className="text-xs text-ink-3 bg-surface-2 border border-line rounded-[var(--radius-md)] px-3 py-2.5">
          {err}
        </div>
      )}

      {/* Grounded answer */}
      {answer !== null && (
        <div className="rounded-[var(--radius-lg)] border border-accent-line bg-accent-soft/40 p-3.5">
          <div className="flex items-center gap-1.5 mb-1.5 text-[11px] font-medium text-accent">
            <Sparkles className="w-3.5 h-3.5" />
            From your brain
          </div>
          <div className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed">
            {answer}
            {answering && <span className="inline-block w-1.5 h-4 align-middle bg-accent/70 ml-0.5 animate-pulse" />}
          </div>
        </div>
      )}

      {/* Cited neurons → drill into a DeepDive */}
      {!busy && results && results.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] text-ink-3">
            {results.length} relevant {results.length === 1 ? "neuron" : "neurons"} — select one to drill into a DeepDive
          </div>
          {results.map((r) => (
            <div key={r.id} className="group rounded-[var(--radius-lg)] border border-line bg-surface-2 hover:border-line-strong p-3 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorFor(r.category || "Uncategorized") }} />
                  <span className="text-sm font-medium text-ink truncate">{r.title || "(untitled neuron)"}</span>
                </div>
                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-accent tabular-nums" title="semantic match">
                  <Sparkles className="w-3 h-3" />
                  {Math.round(r.sim * 100)}%
                </span>
              </div>
              {(r.summary || r.extractedText) && (
                <p className="mt-1 text-xs text-ink-3 line-clamp-2 leading-relaxed">{r.summary || r.extractedText}</p>
              )}
              <div className="mt-2 flex items-center justify-between gap-2">
                <Badge tone="neutral" variant="soft">{r.category || "Uncategorized"}</Badge>
                <div className="flex items-center gap-1.5">
                  <Button size="xs" variant="ghost" leftIcon={<ArrowUpRight className="w-3.5 h-3.5" />} onClick={() => navigateTo("secondbrain", { focusId: `snip:${r.id}` })}>
                    In brain
                  </Button>
                  <Button size="xs" variant="secondary" leftIcon={<Telescope className="w-3.5 h-3.5" />} onClick={() => drill(r)}>
                    Deep dive
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
