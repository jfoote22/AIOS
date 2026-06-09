import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Brain, type SnippetSummary } from '../api/client';
import { Empty, ErrorBanner, Loading, Tag } from '../components/ui';
import { theme, radius } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function BrainScreen() {
  const nav = useNavigation<Nav>();
  const [items, setItems] = useState<SnippetSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    try {
      setError(null);
      const res = await Brain.list(q, 60, 0);
      setItems(res.items);
      setTotal(res.total);
    } catch (e: any) {
      setError(e?.message || 'Failed to load.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(search); }, [load]));

  const onSearch = (q: string) => {
    setSearch(q);
    load(q);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.search}
          placeholder="Search neurons…"
          placeholderTextColor={theme.textFaint}
          value={search}
          onChangeText={onSearch}
          autoCapitalize="none"
        />
        <Pressable style={styles.captureBtn} onPress={() => nav.navigate('Capture')}>
          <Text style={styles.captureText}>＋ OCR</Text>
        </Pressable>
      </View>

      <ErrorBanner text={error} />

      {loading ? (
        <Loading text="Loading Second Brain…" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(s) => s.id}
          contentContainerStyle={{ padding: 12, paddingTop: 4 }}
          refreshControl={<RefreshControl tintColor={theme.accent} refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(search); }} />}
          ListHeaderComponent={total > items.length ? <Text style={styles.count}>{items.length} of {total}</Text> : null}
          ListEmptyComponent={<Empty text={search ? 'No matching neurons.' : 'No neurons yet. Capture a screenshot to start.'} />}
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => nav.navigate('SnippetDetail', { id: item.id, title: item.title })}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle} numberOfLines={1}>{item.title || 'Untitled'}</Text>
                {item.hasImage ? <Text style={styles.imgFlag}>🖼</Text> : null}
              </View>
              {item.summary ? <Text style={styles.cardSummary} numberOfLines={2}>{item.summary}</Text> : null}
              <View style={styles.metaRow}>
                {item.category ? <Tag text={item.category} /> : null}
                {(item.tags || []).slice(0, 3).map((t) => <Tag key={t} text={t} />)}
                {item.status === 'analyzing' ? <Tag text="analyzing…" /> : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  searchRow: { flexDirection: 'row', gap: 8, padding: 12, paddingBottom: 6 },
  search: { flex: 1, backgroundColor: theme.surface, borderColor: theme.borderSoft, borderWidth: 1, borderRadius: radius.md, color: theme.text, paddingHorizontal: 14, paddingVertical: 10 },
  captureBtn: { backgroundColor: theme.accentDim, borderRadius: radius.md, paddingHorizontal: 14, justifyContent: 'center' },
  captureText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  count: { color: theme.textFaint, fontSize: 12, marginBottom: 8, marginLeft: 4 },
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: radius.lg, padding: 14, marginBottom: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, color: theme.text, fontWeight: '700', fontSize: 15 },
  imgFlag: { fontSize: 14 },
  cardSummary: { color: theme.textDim, fontSize: 13, marginTop: 4, lineHeight: 18 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
});
