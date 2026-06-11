import { useCallback, useEffect, useRef, useState } from "react";
import * as db from "@/lib/db";
import { onSnippetsChange } from "@/lib/snippetStore";
import { onDeepDivesChange } from "@/lib/deepdiveStore";

// Minimal shapes — we only read the fields the dashboard needs (the canonical
// records live in lib/* and SnippetEditor; we deliberately don't re-import the
// heavy types here).
export interface Neuron {
  id: string;
  title?: string;
  summary?: string;
  category?: string;
  tags?: string[];
  source?: string;
  timestamp?: number;
}
export interface DeepDiveRec {
  id: string;
  title?: string;
  description?: string;
  timestamp?: number;
  updatedAt?: number;
}
export interface ImportRec {
  id: string;
  title?: string;
  provider?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface TopicStat {
  name: string;
  count: number;
}
export interface RecentItem {
  id: string;
  kind: "neuron" | "deepdive";
  title: string;
  category: string;
  at: number;
}

export interface DashboardData {
  loading: boolean;
  topics: TopicStat[];
  recent: RecentItem[];
  /** colors for the hero constellation — one per recent neuron, by category */
  seedColors: string[];
  stats: {
    neurons: number;
    deepDives: number;
    imports: number;
    clusters: number;
    total: number;
    weekGrowth: number;
  };
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

// Stable category → color (viz palette). Echoes the brain's node colors so the
// dashboard reads as the same organism.
export const VIZ_PALETTE = [
  "#22d3ee", "#a78bfa", "#2dd4bf", "#fbbf24",
  "#fb7185", "#38bdf8", "#a3e635", "#f472b6",
];
export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return VIZ_PALETTE[h % VIZ_PALETTE.length];
}

const EMPTY: DashboardData = {
  loading: true,
  topics: [],
  recent: [],
  seedColors: [],
  stats: { neurons: 0, deepDives: 0, imports: 0, clusters: 0, total: 0, weekGrowth: 0 },
};

/** Loads + derives everything the dashboard renders. Reactive: reloads on the
 *  snippet/deepdive change buses, but only while the tab is active. */
export function useDashboardData(active: boolean): DashboardData & { reload: () => void } {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const dirty = useRef(false);

  const load = useCallback(async () => {
    const [neurons, deepDives, imports] = await Promise.all([
      db.getAllSnippets<Neuron>().catch(() => [] as Neuron[]),
      db.getAllThreads<DeepDiveRec>().catch(() => [] as DeepDiveRec[]),
      db.getImportsMeta<ImportRec>().catch(() => [] as ImportRec[]),
    ]);

    const topicMap = new Map<string, number>();
    for (const n of neurons) {
      const c = n.category?.trim() || "Uncategorized";
      topicMap.set(c, (topicMap.get(c) ?? 0) + 1);
    }
    const topics = [...topicMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const recent: RecentItem[] = [
      ...neurons.map((n) => ({
        id: n.id,
        kind: "neuron" as const,
        title: n.title || n.summary?.slice(0, 64) || "(untitled)",
        category: n.category?.trim() || "Uncategorized",
        at: n.timestamp || 0,
      })),
      ...deepDives.map((d) => ({
        id: d.id,
        kind: "deepdive" as const,
        title: d.title || "(untitled deepdive)",
        category: "DeepDive",
        at: d.updatedAt || d.timestamp || 0,
      })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, 14);

    const cutoff = Date.now() - WEEK;
    const weekGrowth =
      neurons.filter((n) => (n.timestamp || 0) >= cutoff).length +
      deepDives.filter((d) => (d.updatedAt || d.timestamp || 0) >= cutoff).length;

    const seedColors = neurons
      .slice()
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 64)
      .map((n) => colorFor(n.category?.trim() || "Uncategorized"));

    setData({
      loading: false,
      topics,
      recent,
      seedColors,
      stats: {
        neurons: neurons.length,
        deepDives: deepDives.length,
        imports: imports.length,
        clusters: topics.length,
        total: neurons.length + deepDives.length + imports.length,
        weekGrowth,
      },
    });
  }, []);

  useEffect(() => {
    if (active) {
      load();
      dirty.current = false;
    }
  }, [active, load]);

  // Reactive reload (deferred while hidden — mirrors Second Brain's dirty-flag).
  useEffect(() => {
    const onChange = () => {
      if (active) load();
      else dirty.current = true;
    };
    const off1 = onSnippetsChange(onChange);
    const off2 = onDeepDivesChange(onChange);
    return () => {
      off1();
      off2();
    };
  }, [active, load]);

  useEffect(() => {
    if (active && dirty.current) {
      dirty.current = false;
      load();
    }
  }, [active, load]);

  return { ...data, reload: load };
}
