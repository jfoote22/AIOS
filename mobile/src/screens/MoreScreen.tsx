import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../store/auth';
import { getCreds, get } from '../api/client';
import { Button, Card } from '../components/ui';
import { theme, radius } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function MoreScreen() {
  const nav = useNavigation<Nav>();
  const { unpair } = useAuth();
  const creds = getCreds();
  const [status, setStatus] = useState<'checking' | 'ok' | 'down'>('checking');

  useEffect(() => {
    let active = true;
    (async () => {
      try { await get('/api/mobile/ping'); if (active) setStatus('ok'); }
      catch { if (active) setStatus('down'); }
    })();
    return () => { active = false; };
  }, []);

  const confirmUnpair = () => {
    Alert.alert('Disconnect?', 'You will need the pairing code to reconnect.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => unpair() },
    ]);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.section}>Tools</Text>
      <Item label="📸  Capture → OCR" desc="Screenshot or photo → text + tags into Second Brain" onPress={() => nav.navigate('Capture')} />
      <Item label="⚡  Quick Action" desc="Summarize / explain / deep-dive any text" onPress={() => nav.navigate('QuickAction', {})} />
      <Item label="💬  New Chat" desc="Ask AIOS anything" onPress={() => nav.navigate('DiveChat', {})} />

      <Text style={styles.section}>Connection</Text>
      <Card>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: status === 'ok' ? theme.good : status === 'down' ? theme.bad : theme.warn }]} />
          <Text style={styles.statusText}>
            {status === 'checking' ? 'Checking…' : status === 'ok' ? 'Connected' : 'Desktop unreachable'}
          </Text>
        </View>
        <Text style={styles.url}>{creds?.url || '—'}</Text>
        <View style={{ height: 14 }} />
        <Button title="Disconnect" variant="danger" onPress={confirmUnpair} />
      </Card>

      <Text style={styles.footer}>AIOS Companion · powered by your desktop</Text>
    </ScrollView>
  );
}

function Item({ label, desc, onPress }: { label: string; desc: string; onPress: () => void }) {
  return (
    <Pressable style={styles.item} onPress={onPress}>
      <Text style={styles.itemLabel}>{label}</Text>
      <Text style={styles.itemDesc}>{desc}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  section: { color: theme.textFaint, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginTop: 16, marginBottom: 10 },
  item: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: radius.lg, padding: 14, marginBottom: 10 },
  itemLabel: { color: theme.text, fontSize: 15, fontWeight: '700' },
  itemDesc: { color: theme.textFaint, fontSize: 12, marginTop: 3 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  statusText: { color: theme.text, fontWeight: '600' },
  url: { color: theme.textDim, fontFamily: 'monospace', fontSize: 12, marginTop: 8 },
  footer: { color: theme.textFaint, fontSize: 11, textAlign: 'center', marginTop: 30 },
});
