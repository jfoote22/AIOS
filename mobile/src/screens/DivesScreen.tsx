import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Dives, type ThreadSummary } from '../api/client';
import { Empty, ErrorBanner, Loading } from '../components/ui';
import { theme, radius } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function DivesScreen() {
  const nav = useNavigation<Nav>();
  const [items, setItems] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await Dives.list();
      setItems(res.items);
    } catch (e: any) {
      setError(e?.message || 'Failed to load.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  return (
    <View style={styles.screen}>
      <View style={styles.topRow}>
        <Pressable style={styles.newBtn} onPress={() => nav.navigate('DiveChat', {})}>
          <Text style={styles.newText}>＋ New DeepDive</Text>
        </Pressable>
      </View>

      <ErrorBanner text={error} />

      {loading ? (
        <Loading text="Loading DeepDives…" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ padding: 12, paddingTop: 4 }}
          refreshControl={<RefreshControl tintColor={theme.accent} refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          ListEmptyComponent={<Empty text="No saved DeepDives. Start a new one above." />}
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => nav.navigate('DiveChat', { id: item.id, title: item.title })}>
              <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.cardMeta}>
                {item.messageCount != null ? `${item.messageCount} messages` : 'thread'}
                {item.selectedModel ? ` · ${item.selectedModel}` : ''}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  topRow: { padding: 12, paddingBottom: 6 },
  newBtn: { backgroundColor: theme.accentDim, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  newText: { color: '#fff', fontWeight: '700' },
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: radius.lg, padding: 14, marginBottom: 10 },
  cardTitle: { color: theme.text, fontWeight: '700', fontSize: 15 },
  cardMeta: { color: theme.textFaint, fontSize: 12, marginTop: 4 },
});
