import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Build } from '../api/client';
import { Empty, ErrorBanner, Loading, Tag } from '../components/ui';
import { theme, radius } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Mode = 'agents' | 'skills';

export default function BuildScreen() {
  const nav = useNavigation<Nav>();
  const [mode, setMode] = useState<Mode>('agents');
  const [agents, setAgents] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [a, s] = await Promise.all([Build.agents(), Build.skills()]);
      setAgents(a.items || []);
      setSkills(s.items || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  const data = mode === 'agents' ? agents : skills;

  const remove = (item: any) => {
    Alert.alert(`Delete ${mode === 'agents' ? 'agent' : 'skill'}?`, item.name || item.slug, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            if (mode === 'agents') await Build.removeAgent(item.id);
            else await Build.removeSkill(item.id);
            load();
          } catch (e: any) { Alert.alert('Failed', e?.message || 'Could not delete.'); }
        },
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.tabs}>
        <Seg label="Agents" active={mode === 'agents'} onPress={() => setMode('agents')} />
        <Seg label="Skills" active={mode === 'skills'} onPress={() => setMode('skills')} />
      </View>

      <View style={styles.topRow}>
        <Pressable
          style={styles.newBtn}
          onPress={() => nav.navigate(mode === 'agents' ? 'NewAgent' : 'NewSkill')}
        >
          <Text style={styles.newText}>＋ New {mode === 'agents' ? 'Agent' : 'Skill'}</Text>
        </Pressable>
      </View>

      <ErrorBanner text={error} />

      {loading ? (
        <Loading text="Loading…" />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(x) => x.id}
          contentContainerStyle={{ padding: 12, paddingTop: 4 }}
          refreshControl={<RefreshControl tintColor={theme.accent} refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          ListEmptyComponent={<Empty text={`No ${mode} yet. Create one above.`} />}
          renderItem={({ item }) => (
            <Pressable style={styles.card} onLongPress={() => remove(item)}>
              <Text style={styles.cardTitle}>{item.name || item.slug}</Text>
              {item.description ? <Text style={styles.cardDesc} numberOfLines={2}>{item.description}</Text> : null}
              <View style={styles.metaRow}>
                {item.slug ? <Tag text={item.slug} /> : null}
                {item.model && item.model !== 'inherit' ? <Tag text={item.model} /> : null}
                {item.createdVia === 'mobile' ? <Tag text="mobile" /> : null}
              </View>
            </Pressable>
          )}
          ListFooterComponent={<Text style={styles.hint}>Long-press an item to delete.</Text>}
        />
      )}
    </View>
  );
}

function Seg({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.seg, active && styles.segOn]}>
      <Text style={[styles.segText, active && styles.segTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  tabs: { flexDirection: 'row', gap: 8, padding: 12, paddingBottom: 4 },
  seg: { flex: 1, backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: radius.md, paddingVertical: 9, alignItems: 'center' },
  segOn: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  segText: { color: theme.textDim, fontWeight: '600' },
  segTextOn: { color: '#fff' },
  topRow: { paddingHorizontal: 12, paddingBottom: 6 },
  newBtn: { backgroundColor: theme.surfaceAlt, borderRadius: radius.md, paddingVertical: 11, alignItems: 'center' },
  newText: { color: theme.text, fontWeight: '700' },
  card: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: radius.lg, padding: 14, marginBottom: 10 },
  cardTitle: { color: theme.text, fontWeight: '700', fontSize: 15 },
  cardDesc: { color: theme.textDim, fontSize: 13, marginTop: 4, lineHeight: 18 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  hint: { color: theme.textFaint, fontSize: 12, textAlign: 'center', marginTop: 10 },
});
