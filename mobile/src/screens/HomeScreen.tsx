import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { Hermes, streamAsk, type AskSource, type ChatMessage } from '../api/client';
import { Brain3DView, type BrainNodeTap } from '../components/Brain3DView';
import { mdStyles } from '../components/ChatView';
import { useAuth } from '../store/auth';
import { theme, radius } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Mode = 'howie' | 'ask';

interface Msg extends ChatMessage {
  id: string;
  streaming?: boolean;
  sources?: AskSource[];
}

const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: 'howie', label: 'Howie', hint: 'Chat with Howie, your Hermes agent.' },
  { key: 'ask', label: 'Ask Second Brain', hint: 'Answers drawn only from what you have captured.' },
];

let seq = 0;
const newId = () => `${Date.now()}-${seq++}`;

// Landing screen: the 3D brain across the top third (collapsible), with one
// chat below that switches between Howie and Ask Second Brain. Each mode keeps
// its own conversation.
export default function HomeScreen() {
  const nav = useNavigation<Nav>();
  const { creds } = useAuth();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [brainOpen, setBrainOpen] = useState(true);
  const [mode, setMode] = useState<Mode>('howie');
  const [threads, setThreads] = useState<Record<Mode, Msg[]>>({ howie: [], ask: [] });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<Msg>>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const messages = threads[mode];
  useEffect(() => () => cancelRef.current?.(), []);

  const update = useCallback((m: Mode, fn: (list: Msg[]) => Msg[]) => {
    setThreads((t) => ({ ...t, [m]: fn(t[m]) }));
  }, []);

  const patchLast = useCallback((m: Mode, patch: (msg: Msg) => Msg) => {
    update(m, (list) => list.map((x, i) => (i === list.length - 1 ? patch(x) : x)));
  }, [update]);

  const onNodeTap = useCallback((tap: BrainNodeTap) => {
    if (tap.kind === 'snippet') nav.navigate('SnippetDetail', { id: tap.rawId, title: tap.label });
    else if (tap.kind === 'deepdive') nav.navigate('DiveChat', { id: tap.rawId, title: tap.label });
  }, [nav]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    const m = mode;
    const history: ChatMessage[] = threads[m].map(({ role, content }) => ({ role, content }));
    setInput('');
    setError(null);
    setBusy(true);
    update(m, (list) => [...list,
      { id: newId(), role: 'user', content: text },
      { id: newId(), role: 'assistant', content: '', streaming: true }]);

    if (m === 'howie') {
      try {
        const { content } = await Hermes.chat([...history, { role: 'user', content: text }]);
        patchLast(m, (x) => ({ ...x, content: content || '(no reply)', streaming: false }));
      } catch (e: any) {
        update(m, (list) => list.slice(0, -1));
        setError(e?.message || 'Howie did not answer.');
      } finally {
        setBusy(false);
      }
      return;
    }

    cancelRef.current = streamAsk(text, history, {
      onSources: (sources) => patchLast(m, (x) => ({ ...x, sources })),
      onDelta: (d) => patchLast(m, (x) => ({ ...x, content: x.content + d })),
      onDone: () => {
        patchLast(m, (x) => ({ ...x, streaming: false }));
        setBusy(false);
        cancelRef.current = null;
      },
      onError: (err) => {
        patchLast(m, (x) => ({ ...x, streaming: false, content: x.content || '' }));
        update(m, (list) => (list[list.length - 1]?.content ? list : list.slice(0, -1)));
        setError(err);
        setBusy(false);
        cancelRef.current = null;
      },
    });
  }, [input, busy, mode, threads, update, patchLast]);

  const stop = () => {
    cancelRef.current?.();
    cancelRef.current = null;
    patchLast(mode, (x) => ({ ...x, streaming: false }));
    setBusy(false);
  };

  const switchMode = (m: Mode) => {
    if (busy) return;
    setMode(m);
    setError(null);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {brainOpen && creds ? (
        <View style={{ height: Math.round(height * 0.33) }}>
          <Brain3DView url={creds.url} token={creds.token} onNodeTap={onNodeTap} />
        </View>
      ) : null}

      <View style={styles.bar}>
        <View style={styles.segment}>
          {MODES.map((m) => (
            <Pressable key={m.key} onPress={() => switchMode(m.key)} style={[styles.segBtn, mode === m.key && styles.segOn]}>
              <Text style={[styles.segText, mode === m.key && styles.segTextOn]}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable hitSlop={8} onPress={() => setBrainOpen((o) => !o)} style={styles.brainToggle}>
          <Text style={styles.brainToggleText}>{brainOpen ? '▴ Brain' : '▾ Brain'}</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(x) => x.id}
          contentContainerStyle={{ padding: 12, paddingBottom: 8 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={<Text style={styles.hint}>{MODES.find((x) => x.key === mode)?.hint}</Text>}
          renderItem={({ item }) => (
            <View style={[styles.bubbleWrap, { alignItems: item.role === 'user' ? 'flex-end' : 'flex-start' }]}>
              <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.botBubble]}>
                {item.role === 'user'
                  ? <Text style={styles.userText}>{item.content}</Text>
                  : <Markdown style={mdStyles}>{item.content || (item.streaming ? '…' : '')}</Markdown>}
                {item.sources?.length ? (
                  <View style={styles.sources}>
                    {item.sources.map((s) => (
                      <Pressable key={s.id} onPress={() => nav.navigate('SnippetDetail', { id: s.id, title: s.title })} style={styles.source}>
                        <Text style={styles.sourceText} numberOfLines={1}>[{s.n}] {s.title}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            </View>
          )}
        />

        {error ? <Text style={styles.err}>{error}</Text> : null}

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={mode === 'howie' ? 'Message Howie…' : 'Ask your Second Brain…'}
            placeholderTextColor={theme.textFaint}
            multiline
          />
          <Pressable onPress={busy ? stop : send} style={[styles.sendBtn, busy && { backgroundColor: theme.surfaceAlt }]}>
            <Text style={styles.sendText}>{busy ? '■' : '↑'}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderBottomColor: theme.border, borderBottomWidth: 1 },
  segment: { flex: 1, flexDirection: 'row', backgroundColor: theme.surface, borderRadius: 999, padding: 3 },
  segBtn: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 999 },
  segOn: { backgroundColor: theme.accentDim },
  segText: { color: theme.textDim, fontSize: 13, fontWeight: '600' },
  segTextOn: { color: '#fff' },
  brainToggle: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999, borderColor: theme.borderSoft, borderWidth: 1 },
  brainToggleText: { color: theme.textDim, fontSize: 12, fontWeight: '600' },
  hint: { color: theme.textFaint, textAlign: 'center', marginTop: 32, paddingHorizontal: 30, fontSize: 13 },
  bubbleWrap: { marginBottom: 10 },
  bubble: { maxWidth: '88%', borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 10 },
  userBubble: { backgroundColor: theme.accentDim },
  botBubble: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1 },
  userText: { color: '#fff', fontSize: 15 },
  sources: { marginTop: 8, gap: 4 },
  source: { backgroundColor: theme.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 5 },
  sourceText: { color: theme.accent, fontSize: 12 },
  err: { color: '#fca5a5', fontSize: 12, paddingHorizontal: 14, paddingBottom: 4 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopColor: theme.border, borderTopWidth: 1 },
  input: { flex: 1, maxHeight: 120, backgroundColor: theme.surface, borderColor: theme.borderSoft, borderWidth: 1, borderRadius: radius.lg, color: theme.text, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 },
  sendBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#fff', fontSize: 18, fontWeight: '800' },
});
