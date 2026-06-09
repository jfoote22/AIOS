import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { Brain, type ChatMessage } from '../api/client';
import { ChatView } from '../components/ChatView';
import { Field, ErrorBanner } from '../components/ui';
import { theme, radius } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type R = RouteProp<RootStackParamList, 'QuickAction'>;

// The "select something → action dialog" surface, mirroring DeepDive seed actions.
const ACTIONS: { key: string; label: string; build: (t: string) => string }[] = [
  { key: 'summarize', label: 'Summarize', build: (t) => `Summarize the following concisely:\n\n${t}` },
  { key: 'explain', label: 'Explain', build: (t) => `Explain the following clearly, with any needed background:\n\n${t}` },
  { key: 'keypoints', label: 'Key points', build: (t) => `Extract the key points as a bulleted list:\n\n${t}` },
  { key: 'actions', label: 'Action items', build: (t) => `List concrete action items / next steps from the following:\n\n${t}` },
  { key: 'deepdive', label: 'Deep dive', build: (t) => `Do a deep dive on this topic — context, nuances, and what to explore next:\n\n${t}` },
];

export default function QuickActionScreen() {
  const { params } = useRoute<R>();
  const [text, setText] = useState(params?.text || '');
  const [seed, setSeed] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  const runAction = (build: (t: string) => string) => {
    const t = text.trim();
    if (!t) { setError('Enter or share some text first.'); return; }
    setError(null);
    setSeed([{ role: 'user', content: build(t) }]);
  };

  const saveToBrain = async () => {
    const t = text.trim();
    if (!t) { setError('Nothing to save.'); return; }
    try {
      await Brain.ingest(t, { title: t.slice(0, 60), source: 'Quick Action' });
      setSavedNote(true);
      Alert.alert('Saved', 'Sent to Second Brain (it will be enriched on the desktop).');
    } catch (e: any) {
      setError(e?.message || 'Failed to save.');
    }
  };

  if (seed) {
    return <ChatView initialMessages={seed} autoSend placeholder="Follow up…" />;
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        <ErrorBanner text={error} />
        <Field
          label="Text"
          value={text}
          onChangeText={setText}
          placeholder="Paste or share text here, then pick an action…"
          multiline
          style={{ minHeight: 140 }}
        />
        <Text style={styles.label}>Actions</Text>
        <View style={styles.actions}>
          {ACTIONS.map((a) => (
            <Pressable key={a.key} style={styles.action} onPress={() => runAction(a.build)}>
              <Text style={styles.actionText}>{a.label}</Text>
            </Pressable>
          ))}
          <Pressable style={[styles.action, styles.saveAction]} onPress={saveToBrain}>
            <Text style={[styles.actionText, { color: '#fff' }]}>{savedNote ? 'Saved ✓' : 'Save to Brain'}</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Tip: in any app, select text and use the system Share sheet → AIOS to land here automatically.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  label: { color: theme.textFaint, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginTop: 20, marginBottom: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  action: { backgroundColor: theme.surface, borderColor: theme.borderSoft, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 11 },
  saveAction: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  actionText: { color: theme.text, fontWeight: '600', fontSize: 14 },
  hint: { color: theme.textFaint, fontSize: 12, lineHeight: 18, marginTop: 24 },
});
