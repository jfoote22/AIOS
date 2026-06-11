// Standalone entry for the mobile companion's landing page: the SAME 3D Second
// Brain the desktop renders (BrainView3D), served by the mobile gateway at
// /brain3d/ and loaded in a React Native WebView. Unlike the desktop renderer
// there is no IPC here — data comes from the token-gated
// /api/mobile/brain-graph endpoint (token passed in the page URL by the app).
//
// Node taps are forwarded to the native app via window.ReactNativeWebView
// .postMessage so the phone can open its native detail screens.
import { StrictMode, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrainView3D } from '../components/BrainView3D';
import {
  buildGraph, findDocClusters, applyCollapsedClusters,
  DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_SIMILAR_TOP_K, DEFAULT_HUB_THRESHOLD,
  type BrainGraph,
} from '../lib/graph';

const params = new URLSearchParams(window.location.search);
const TOKEN = params.get('token') || '';

interface BrainData {
  snippets: any[];
  // Slim DeepDive sessions from the gateway (no message bodies).
  deepDives: { id: string; title: string; timestamp: number; updatedAt?: number; embedding?: number[]; msgCount: number; threadIds: string[] }[];
  imports: any[];
  physics: { simThreshold?: number; maxLinks?: number; pulseHubThreshold?: number } | null;
  expandedDocs: string[];
}

function postToApp(msg: Record<string, unknown>) {
  try { (window as any).ReactNativeWebView?.postMessage(JSON.stringify(msg)); } catch {}
}

async function fetchBrainData(): Promise<BrainData> {
  const res = await fetch('/api/mobile/brain-graph', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch {}
    throw new Error(detail || `Gateway error ${res.status}`);
  }
  return res.json();
}

// Same stable per-category palette assignment as SecondBrainTab.
const PALETTE = ['#7c9cff', '#5ee6b0', '#ffb86b', '#ff7ad9', '#a78bfa', '#f87171', '#22d3ee', '#facc15', '#fb923c', '#34d399'];

function App() {
  const [data, setData] = useState<BrainData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchBrainData().then(setData).catch((e) => setError(e?.message || String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Build the exact graph the desktop builds: buildGraph with the user's saved
  // connection settings, then multi-part doc clusters collapsed (except the
  // ones the user expanded on the desktop).
  const graph: BrainGraph = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    const dds = data.deepDives.map((dd) => ({
      id: dd.id,
      title: dd.title,
      timestamp: dd.timestamp,
      updatedAt: dd.updatedAt,
      embedding: dd.embedding,
      // buildGraph only reads .length / iterates ids — sized holes are enough.
      mainMessages: new Array(dd.msgCount || 0),
      threads: (dd.threadIds || []).map((id) => ({ id })),
    }));
    const full = buildGraph(data.snippets, dds, data.imports, {
      threshold: data.physics?.simThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
      topK: data.physics?.maxLinks ?? DEFAULT_SIMILAR_TOP_K,
      hubThreshold: data.physics?.pulseHubThreshold ?? DEFAULT_HUB_THRESHOLD,
    });
    const clusters = findDocClusters(data.snippets);
    const expanded = new Set(data.expandedDocs || []);
    const collapsed = new Set(clusters.map((c) => c.docId).filter((d) => !expanded.has(d)));
    return applyCollapsedClusters(full, clusters, collapsed);
  }, [data]);

  const groupColors = useMemo(() => {
    const groups = Array.from(new Set(graph.nodes.map((n) => n.group)));
    const map: Record<string, string> = {};
    groups.forEach((g, i) => { map[g] = g === 'DeepDive' ? '#a78bfa' : PALETTE[i % PALETTE.length]; });
    return map;
  }, [graph]);

  const graph3d = useMemo(() => ({
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      category: n.group,
      val: n.val,
      color: groupColors[n.group] || '#9ca3af',
      embedding: (n.data as any)?.embedding as number[] | undefined,
    })),
    links: graph.links.map((l) => {
      const s: any = (l as any).source, t: any = (l as any).target;
      return { source: typeof s === 'object' ? s.id : s, target: typeof t === 'object' ? t.id : t };
    }),
  }), [graph, groupColors]);

  const onNodeClick = useCallback((id: string) => {
    setFocusedId(id);
    const node = graph.nodes.find((n) => n.id === id);
    postToApp({
      type: 'node',
      id,
      kind: node?.kind || '',
      label: node?.label || '',
      rawId: id.replace(/^(snip|dd|import|cluster):/, ''),
    });
  }, [graph]);

  const onBackground = useCallback(() => {
    setFocusedId(null);
    postToApp({ type: 'background' });
  }, []);

  if (error) {
    return (
      <Center>
        <div style={{ marginBottom: 10 }}>Couldn’t load the Second Brain.</div>
        <div style={{ color: '#8fa3c8', fontSize: 13, marginBottom: 18 }}>{error}</div>
        <button onClick={load} style={btnStyle}>Retry</button>
      </Center>
    );
  }
  if (!data) return <Center>Waking the brain…</Center>;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <BrainView3D
        graph={graph3d}
        focusedId={focusedId}
        onNodeClick={onNodeClick}
        onBackground={onBackground}
      />
      {graph.nodes.length === 0 && (
        <Center pointerEventsNone>
          <div>No neurons yet.</div>
          <div style={{ color: '#8fa3c8', fontSize: 13, marginTop: 8 }}>Capture something and it will appear here.</div>
        </Center>
      )}
    </div>
  );
}

const btnStyle: CSSProperties = {
  background: 'rgba(12,16,28,0.8)', color: '#cfe3ff', border: '1px solid #2a3a6a',
  borderRadius: 10, padding: '9px 18px', fontSize: 14, fontWeight: 600,
};

function Center({ children, pointerEventsNone }: { children: ReactNode; pointerEventsNone?: boolean }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', textAlign: 'center',
      color: '#cfe3ff', fontFamily: 'system-ui, sans-serif', fontSize: 15, padding: 24,
      pointerEvents: pointerEventsNone ? 'none' : undefined,
    }}>
      {children}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
