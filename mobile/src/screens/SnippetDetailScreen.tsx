import React, { useEffect, useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Brain } from '../api/client';
import { Button, Loading, Tag, ErrorBanner } from '../components/ui';
import { theme, radius } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type R = RouteProp<RootStackParamList, 'SnippetDetail'>;

export default function SnippetDetailScreen() {
  const nav = useNavigation<Nav>();
  const { params } = useRoute<R>();
  const [item, setItem] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setItem(await Brain.get(params.id));
      } catch (e: any) {
        setError(e?.message || 'Failed to load.');
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id]);

  const remove = () => {
    Alert.alert('Delete neuron?', 'This removes it from Second Brain on your desktop.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try { await Brain.remove(params.id); nav.goBack(); }
          catch (e: any) { Alert.alert('Failed', e?.message || 'Could not delete.'); }
        },
      },
    ]);
  };

  if (loading) return <Loading text="Loading neuron…" />;
  if (error) return <View style={styles.screen}><ErrorBanner text={error} /></View>;
  if (!item) return null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.title}>{item.title || 'Untitled'}</Text>
      <View style={styles.metaRow}>
        {item.category ? <Tag text={item.category} /> : null}
        {item.source ? <Tag text={item.source} /> : null}
      </View>

      {item.image ? (
        <Image source={{ uri: item.image }} style={styles.image} resizeMode="contain" />
      ) : null}

      {item.summary ? (
        <>
          <Text style={styles.label}>Summary</Text>
          <Text style={styles.body}>{item.summary}</Text>
        </>
      ) : null}

      {Array.isArray(item.tags) && item.tags.length ? (
        <>
          <Text style={styles.label}>Tags</Text>
          <View style={styles.metaRow}>{item.tags.map((t: string) => <Tag key={t} text={t} />)}</View>
        </>
      ) : null}

      {item.extractedText ? (
        <>
          <Text style={styles.label}>Extracted text</Text>
          <View style={styles.codeBox}><Text style={styles.code}>{item.extractedText}</Text></View>
        </>
      ) : null}

      <View style={{ height: 16 }} />
      <Button
        title="Ask AIOS about this"
        onPress={() => nav.navigate('QuickAction', {
          text: `About my note "${item.title}":\n\n${item.extractedText || item.summary || ''}`,
        })}
      />
      <View style={{ height: 10 }} />
      <Button title="Delete" variant="danger" onPress={remove} />
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  title: { color: theme.text, fontSize: 22, fontWeight: '800' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  image: { width: '100%', height: 220, borderRadius: radius.lg, marginTop: 16, backgroundColor: theme.surface },
  label: { color: theme.textFaint, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginTop: 20, marginBottom: 6 },
  body: { color: theme.text, fontSize: 15, lineHeight: 21 },
  codeBox: { backgroundColor: '#000', borderColor: theme.border, borderWidth: 1, borderRadius: radius.md, padding: 12 },
  code: { color: '#d4d4d8', fontSize: 13, fontFamily: 'monospace', lineHeight: 19 },
});
