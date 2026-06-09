import React, { useEffect, useState } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Research, type ResearchItem } from '../api/client';
import { Empty, ErrorBanner, Loading } from './ui';
import { theme, radius } from '../theme';

// Renders a "Get links" / "Get videos" thread: fetches verified results for the
// selection context and lists them (tap to open).
export function ResearchPanel({ kind, context }: { kind: 'links' | 'videos'; context: string }) {
  const [intro, setIntro] = useState('');
  const [items, setItems] = useState<ResearchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = kind === 'links' ? await Research.links(context) : await Research.videos(context);
        if (!active) return;
        setIntro(res.intro || '');
        setItems(Array.isArray(res.items) ? res.items : []);
      } catch (e: any) {
        if (active) setError(e?.message || 'Failed to fetch.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [kind, context]);

  if (loading) return <Loading text={kind === 'links' ? 'Finding links…' : 'Finding videos…'} />;

  return (
    <View style={styles.wrap}>
      <ErrorBanner text={error} />
      <FlatList
        data={items}
        keyExtractor={(it, i) => (it.url || '') + i}
        contentContainerStyle={{ padding: 12 }}
        ListHeaderComponent={
          <>
            <Text style={styles.context} numberOfLines={2}>“{context}”</Text>
            {intro ? <Text style={styles.intro}>{intro}</Text> : null}
          </>
        }
        ListEmptyComponent={<Empty text={`No ${kind} found for this selection.`} />}
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() => item.url && Linking.openURL(item.url).catch(() => {})}
          >
            <Text style={styles.title} numberOfLines={2}>{item.title || item.url || 'Untitled'}</Text>
            {item.channel ? <Text style={styles.meta}>{item.channel}</Text> : null}
            {item.snippet || item.description ? (
              <Text style={styles.snippet} numberOfLines={3}>{item.snippet || item.description}</Text>
            ) : null}
            {item.url ? <Text style={styles.url} numberOfLines={1}>{item.url}</Text> : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg },
  context: { color: theme.textDim, fontStyle: 'italic', fontSize: 13, marginBottom: 8 },
  intro: { color: theme.text, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: radius.lg, padding: 14, marginBottom: 10 },
  title: { color: theme.accent, fontWeight: '700', fontSize: 15 },
  meta: { color: theme.textFaint, fontSize: 12, marginTop: 2 },
  snippet: { color: theme.textDim, fontSize: 13, marginTop: 6, lineHeight: 18 },
  url: { color: theme.textFaint, fontSize: 11, marginTop: 8 },
});
