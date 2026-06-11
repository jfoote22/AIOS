import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Brain, type SnippetSummary } from '../api/client';
import { Brain3DView, type BrainNodeTap } from '../components/Brain3DView';
import { useAuth } from '../store/auth';
import { Empty, ErrorBanner, Loading, Tag } from '../components/ui';
import { theme, radius } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Landing screen: the 3D Second Brain (same Three.js view as the desktop,
// served by the gateway, rendered in a WebView) with a toggle to the 2D
// browse/search list — mirroring the desktop's 2D ⇄ 3D switch.
export default function BrainScreen() {
  const nav = useNavigation<Nav>();
  const { creds } = useAuth();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<'3d' | 'list'>('3d');

  const onNodeTap = useCallback((tap: BrainNodeTap) => {
    if (tap.kind === 'snippet') nav.navigate('SnippetDetail', { id: tap.rawId, title: tap.label });
    else if (tap.kind === 'deepdive') nav.navigate('DiveChat', { id: tap.rawId, title: tap.label });
    // imports/clusters just focus in the 3D view — nothing to open natively.
  }, [nav]);

  if (mode === '3d') {
    return (
      <View style={[styles.immersive, { paddingTop: insets.top }]}>
        {creds ? (
          <Brain3DView url={creds.url} token={creds.token} onNodeTap={onNodeTap} />
        ) : null}
        {/* The page renders its own controls top-RIGHT (rotate/shell), so ours go top-LEFT. */}
        <View style={[styles.overlay, { top: insets.top + 10 }]}>
          <Pressable style={styles.overlayBtn} onPress={() => setMode('list')}>
            <Text style={styles.overlayBtnText}>☰ List</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return <BrainList insetsTop={insets.top} onShow3D={() => setMode('3d')} />;
}

// The original browse/search list, now living behind the 3D landing view.
function BrainList({ insetsTop, onShow3D }: { insetsTop: number; onShow3D: () => void }) {
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
    <View style={[styles.screen, { paddingTop: insetsTop }]}>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>Second Brain</Text>
        <Pressable style={styles.modeBtn} onPress={onShow3D}>
          <Text style={styles.modeBtnText}>◉ 3D</Text>
        </Pressable>
      </View>
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
  immersive: { flex: 1, backgroundColor: '#04060d' },
  overlay: { position: 'absolute', left: 12, flexDirection: 'row', gap: 8 },
  overlayBtn: { backgroundColor: 'rgba(12,16,28,0.8)', borderColor: '#2a3a6a', borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  overlayBtnText: { color: '#cfe3ff', fontWeight: '600', fontSize: 12 },
  screen: { flex: 1, backgroundColor: theme.bg },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 10 },
  headerTitle: { flex: 1, color: theme.text, fontWeight: '700', fontSize: 18 },
  modeBtn: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 7 },
  modeBtnText: { color: theme.accent, fontWeight: '700', fontSize: 12 },
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
