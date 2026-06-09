import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { streamDeepResearch } from '../api/client';
import { ErrorBanner } from './ui';
import { theme, radius } from '../theme';

// Runs the autonomous Deep Research loop on the desktop and streams its live
// status + the report as it's written.
export function DeepResearchPanel({ query }: { query: string }) {
  const [status, setStatus] = useState<string[]>([]);
  const [report, setReport] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState(0);
  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    abortRef.current = streamDeepResearch(query, {
      onStatus: (m) => setStatus((prev) => [...prev.slice(-40), m]),
      onReportDelta: (t) => {
        setReport((prev) => prev + t);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 30);
      },
      onDone: (finalReport, srcCount) => {
        if (finalReport) setReport((prev) => prev || finalReport);
        setSources(srcCount);
        setDone(true);
      },
      onError: (e) => { setError(e); setDone(true); },
    });
    return () => { abortRef.current?.(); };
  }, [query]);

  return (
    <ScrollView ref={scrollRef} style={styles.wrap} contentContainerStyle={{ padding: 14 }}>
      <Text style={styles.query} numberOfLines={3}>🔬 {query}</Text>
      <ErrorBanner text={error} />

      {!done && (
        <View style={styles.statusBox}>
          {status.slice(-6).map((s, i) => (
            <Text key={i} style={[styles.statusLine, i === status.slice(-6).length - 1 && styles.statusActive]} numberOfLines={1}>
              {i === status.slice(-6).length - 1 ? '▸ ' : '· '}{s}
            </Text>
          ))}
          {!status.length ? <Text style={styles.statusActive}>▸ Starting research…</Text> : null}
        </View>
      )}

      {report ? (
        <View style={styles.reportBox}>
          <Markdown style={mdStyles}>{report}</Markdown>
        </View>
      ) : null}

      {done && !error ? (
        <Text style={styles.footer}>{report ? `Report complete · ${sources} sources` : 'Finished.'}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  query: { color: theme.text, fontSize: 16, fontWeight: '700', marginBottom: 12 },
  statusBox: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: radius.md, padding: 12, marginBottom: 14 },
  statusLine: { color: theme.textFaint, fontSize: 12, lineHeight: 18 },
  statusActive: { color: theme.accent, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  reportBox: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: radius.lg, padding: 14 },
  footer: { color: theme.textFaint, fontSize: 12, textAlign: 'center', marginTop: 16, marginBottom: 20 },
});

const mdStyles = {
  body: { color: theme.text, fontSize: 14, lineHeight: 21 },
  heading1: { color: theme.text, fontSize: 19, fontWeight: '700', marginTop: 8 },
  heading2: { color: theme.text, fontSize: 17, fontWeight: '700', marginTop: 8 },
  link: { color: theme.accent },
  code_inline: { backgroundColor: theme.surfaceAlt, color: '#e4e4e7', borderRadius: 4, paddingHorizontal: 4 },
  fence: { backgroundColor: '#000', color: '#e4e4e7', borderRadius: 8, padding: 10 },
} as any;
