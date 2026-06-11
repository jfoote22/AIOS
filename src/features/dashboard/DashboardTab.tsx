import { useCallback, useEffect, useState } from "react";
import {
  ScanLine, Network, Compass, Telescope, Brain, Github, Star,
  ArrowUpRight, Plus, Sparkles, FileText, MessageSquare, TrendingUp, Layers, Search,
} from "lucide-react";
import { Badge, Button, Spinner, EmptyState, cn, useToast } from "@/ui";
import { navigateTo } from "@/lib/navigate";
import { useDashboardData, colorFor, type TopicStat, type RecentItem } from "./data";
import { searchRepos, type Repo } from "./github";
import { saveRepoToBrain } from "./actions";
import HermesChatCard from "./HermesChatCard";
import BrainHero from "./BrainHero";
import AskBrain from "./AskBrain";
import LoopRing, { type LoopPhase } from "./LoopRing";

function ago(ts: number): string {
  if (!ts) return "";
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function captureNow(toast: ReturnType<typeof useToast>) {
  if (window.aios?.isElectron) window.aios.requestCapture();
  else toast.warning("Capture needs the desktop app.");
}

export default function DashboardTab({ active }: { active: boolean }) {
  const toast = useToast();
  const data = useDashboardData(active);

  const [fuelTopic, setFuelTopic] = useState("");
  const [fuelInput, setFuelInput] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [fuelLoading, setFuelLoading] = useState(false);
  const [fuelError, setFuelError] = useState<string | null>(null);
  const [savedRepos, setSavedRepos] = useState<Set<number>>(new Set());

  const runFuel = useCallback(async (topic: string) => {
    const t = topic.trim();
    if (!t) return;
    setFuelTopic(t);
    setFuelInput(t);
    setFuelLoading(true);
    setFuelError(null);
    try {
      setRepos(await searchRepos(t));
    } catch (e) {
      setFuelError((e as Error)?.message || String(e));
      setRepos([]);
    } finally {
      setFuelLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active && !fuelTopic && data.topics.length) runFuel(data.topics[0].name);
  }, [active, fuelTopic, data.topics, runFuel]);

  const onSaveRepo = async (repo: Repo) => {
    try {
      await saveRepoToBrain(repo, fuelTopic);
      setSavedRepos((s) => new Set(s).add(repo.id));
      toast.success("Added to your brain", { description: repo.fullName });
    } catch (e) {
      toast.error("Save failed", { description: (e as Error)?.message || String(e) });
    }
  };

  const s = data.stats;
  const phases: LoopPhase[] = [
    { key: "capture", label: "Capture", count: s.neurons, hint: "Snip, paste, ingest → feed the brain", color: "#22d3ee", icon: <ScanLine className="w-5 h-5" />, onClick: () => captureNow(toast) },
    { key: "organize", label: "Organize", count: s.clusters, hint: "Clusters & links forming in the brain", color: "#2dd4bf", icon: <Network className="w-5 h-5" />, onClick: () => navigateTo("secondbrain") },
    { key: "explore", label: "Explore", count: s.total, hint: "Browse everything you know", color: "#38bdf8", icon: <Compass className="w-5 h-5" />, onClick: () => navigateTo("secondbrain") },
    { key: "deepen", label: "Deepen", count: s.deepDives, hint: "Ask, drill, deep-dive → back into the brain", color: "#a78bfa", icon: <Telescope className="w-5 h-5" />, onClick: () => navigateTo("deepdives") },
  ];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin bg-canvas">
      <header className="sticky top-0 z-10 px-6 h-14 flex items-center gap-3 border-b border-line bg-canvas/80 backdrop-blur-md">
        <div className="w-8 h-8 rounded-[var(--radius-md)] flex items-center justify-center shrink-0" style={{ backgroundImage: "var(--gradient-brand)" }}>
          <Sparkles className="w-4 h-4 text-white" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-ink leading-none">Home</h1>
          <p className="text-[11px] text-ink-3 mt-0.5">Your knowledge, in motion</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" leftIcon={<ScanLine className="w-4 h-4" />} onClick={() => captureNow(toast)}>Quick capture</Button>
          <Button size="sm" variant="primary" leftIcon={<Brain className="w-4 h-4" />} onClick={() => navigateTo("secondbrain")}>Open brain</Button>
        </div>
      </header>

      <div className="max-w-[1200px] mx-auto px-6 py-6 space-y-6">
        {/* 1 — Hermes */}
        <HermesChatCard />

        {/* 2 — Second Brain + Ask */}
        <section className="rounded-[var(--radius-xl)] border border-line bg-surface p-5">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">Second Brain</h2>
              <p className="text-[11px] text-ink-3 mt-0.5">Ask it anything — answers grounded in your neurons, then drill in</p>
            </div>
            <button onClick={() => navigateTo("secondbrain")} className="focus-ring text-xs text-accent hover:underline shrink-0">Open full →</button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-4">
            <div className="relative rounded-[var(--radius-lg)] border border-line bg-canvas overflow-hidden min-h-[320px]">
              <BrainHero seedColors={data.seedColors} active={active} onOpen={() => navigateTo("secondbrain")} />
              <div className="absolute top-4 left-4 pointer-events-none">
                <div className="text-[11px] font-medium uppercase tracking-wider text-ink-3">Knowledge mass</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-4xl font-bold tabular-nums bg-clip-text text-transparent" style={{ backgroundImage: "var(--gradient-brand)" }}>{s.total}</span>
                  <span className="text-sm text-ink-2">nodes</span>
                </div>
                <div className="mt-1 text-xs text-ink-3">{s.neurons} neurons · {s.deepDives} deep dives · {s.imports} imports</div>
              </div>
              {s.weekGrowth > 0 && (
                <div className="absolute bottom-4 left-4 inline-flex items-center gap-1.5 rounded-full bg-success-soft border border-success/30 px-2.5 py-1 pointer-events-none">
                  <TrendingUp className="w-3.5 h-3.5 text-success" />
                  <span className="text-xs font-medium text-success-ink">+{s.weekGrowth} this week</span>
                </div>
              )}
            </div>
            <AskBrain />
          </div>
        </section>

        {/* 3 — Recent activity */}
        <Panel title="Recent activity" hint="The latest into your brain">
          {data.recent.length === 0 ? (
            <EmptyState size="md" icon={<FileText className="w-5 h-5" />} title="Nothing yet" description="Your captures and deep dives will show up here." />
          ) : (
            <ul className="space-y-1 -mx-1">
              {data.recent.map((r: RecentItem) => (
                <li key={`${r.kind}:${r.id}`}>
                  <button onClick={() => navigateTo(r.kind === "deepdive" ? "deepdives" : "secondbrain")} className="focus-ring w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[var(--radius-md)] hover:bg-surface-2 text-left transition-colors">
                    <span className="shrink-0 text-ink-3">{r.kind === "deepdive" ? <MessageSquare className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}</span>
                    <span className="flex-1 min-w-0 truncate text-sm text-ink-2">{r.title}</span>
                    <Badge tone={r.kind === "deepdive" ? "accent" : "neutral"} variant="soft">{r.category}</Badge>
                    <span className="shrink-0 text-[10px] text-ink-4 tabular-nums w-14 text-right">{ago(r.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* 4 — Fuel */}
        <Panel title="Fuel — tools & repos for your brain" hint="Public GitHub repositories for your topics — save the useful ones straight in">
          <div className="flex items-center gap-2 mb-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3 pointer-events-none" />
              <input
                value={fuelInput}
                onChange={(e) => setFuelInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runFuel(fuelInput); } }}
                placeholder="Find repos & tools for a topic…"
                className="w-full h-9 pl-9 pr-3 rounded-[var(--radius-md)] bg-surface-2 border border-line text-sm text-ink placeholder:text-ink-4 focus-ring focus:border-accent"
              />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {data.topics.slice(0, 4).map((t) => (
                <button key={t.name} onClick={() => runFuel(t.name)} className={cn("text-xs px-2 h-7 rounded-full border transition-colors", fuelTopic === t.name ? "bg-accent-soft text-accent border-accent-line" : "text-ink-3 border-line hover:text-ink hover:bg-surface-2")}>{t.name}</button>
              ))}
            </div>
          </div>
          {fuelLoading ? (
            <div className="py-8 flex justify-center"><Spinner label={`Searching GitHub for "${fuelTopic}"…`} /></div>
          ) : fuelError ? (
            <EmptyState size="md" icon={<Github className="w-5 h-5" />} title="Couldn't reach GitHub" description={fuelError} action={<Button size="sm" variant="secondary" onClick={() => runFuel(fuelTopic || fuelInput)}>Retry</Button>} />
          ) : repos.length === 0 ? (
            <EmptyState size="md" icon={<Github className="w-5 h-5" />} title="No tools loaded yet" description="Search a topic above, or capture something so your brain has topics to match." />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {repos.map((repo) => {
                const saved = savedRepos.has(repo.id);
                return (
                  <div key={repo.id} className="rounded-[var(--radius-lg)] border border-line bg-surface-2 p-3.5 flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <a href={repo.url} target="_blank" rel="noreferrer" className="focus-ring text-sm font-semibold text-ink hover:text-accent inline-flex items-center gap-1 min-w-0">
                        <span className="truncate">{repo.fullName}</span>
                        <ArrowUpRight className="w-3.5 h-3.5 shrink-0" />
                      </a>
                      <span className="shrink-0 inline-flex items-center gap-1 text-xs text-ink-3">
                        <Star className="w-3.5 h-3.5 text-warning" />
                        <span className="tabular-nums">{repo.stars.toLocaleString()}</span>
                      </span>
                    </div>
                    {repo.description && <p className="text-xs text-ink-3 line-clamp-2 leading-relaxed">{repo.description}</p>}
                    <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                      {repo.language ? <Badge tone="neutral" variant="outline">{repo.language}</Badge> : <span />}
                      <Button size="xs" variant={saved ? "subtle" : "secondary"} disabled={saved} leftIcon={saved ? <Sparkles className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} onClick={() => onSaveRepo(repo)}>
                        {saved ? "In brain" : "Save to brain"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* 5 — Topics + counts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="Topics you care about" hint="What your brain knows most about" action={<button onClick={() => navigateTo("secondbrain")} className="text-xs text-accent hover:underline">Explore →</button>}>
            {data.topics.length === 0 ? (
              <EmptyState size="md" icon={<Layers className="w-5 h-5" />} title="No topics yet" description="Capture or ingest something and your brain will start clustering it." />
            ) : (
              <div className="flex flex-wrap gap-2">
                {data.topics.slice(0, 16).map((t: TopicStat) => (
                  <button key={t.name} onClick={() => runFuel(t.name)} title={`Find tools for "${t.name}"`} className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 hover:border-line-strong hover:bg-elevated px-2.5 h-7 text-xs transition-colors">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colorFor(t.name) }} />
                    <span className="text-ink">{t.name}</span>
                    <span className="text-ink-4 tabular-nums">{t.count}</span>
                  </button>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Your brain by the numbers">
            <div className="grid grid-cols-2 gap-3">
              <StatTile icon={<Brain className="w-4 h-4" />} label="Neurons" value={s.neurons} />
              <StatTile icon={<Layers className="w-4 h-4" />} label="Topics" value={s.clusters} />
              <StatTile icon={<Telescope className="w-4 h-4" />} label="Deep dives" value={s.deepDives} />
              <StatTile icon={<TrendingUp className="w-4 h-4" />} label="New this week" value={s.weekGrowth} accent />
            </div>
          </Panel>
        </div>

        {/* 6 — The loop (bottom) */}
        <Panel title="The knowledge loop" hint="Capture feeds it · the brain organizes · you explore & deepen · results flow back in">
          <div className="flex items-center justify-center py-3">
            <LoopRing phases={phases} />
          </div>
        </Panel>

        <div className="h-2" />
      </div>
    </div>
  );
}

function StatTile({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: number; accent?: boolean }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-line bg-surface-2 p-4">
      <div className={cn("inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] mb-2", accent ? "bg-accent-soft text-accent" : "bg-surface text-ink-3")}>{icon}</div>
      <div className="text-2xl font-bold text-ink tabular-nums">{value}</div>
      <div className="text-xs text-ink-3">{label}</div>
    </div>
  );
}

function Panel({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-xl)] border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {hint && <p className="text-[11px] text-ink-3 mt-0.5">{hint}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
