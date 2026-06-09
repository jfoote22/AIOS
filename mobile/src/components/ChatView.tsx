import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import * as Clipboard from 'expo-clipboard';
import { theme, radius } from '../theme';
import { streamChat, MODELS, GROK_MODES, Brain, type ChatMessage } from '../api/client';
import { SelectionMenu, type ContextAction } from './SelectionMenu';

export interface ChatContext { model: string; mode: string }

interface Msg extends ChatMessage { id: string; streaming?: boolean }

export function ChatView({
  initialMessages = [],
  initialModel = 'claude',
  initialMode = 'normal',
  placeholder = 'Ask anything…',
  autoSend = false,
  onContextAction,
}: {
  initialMessages?: ChatMessage[];
  initialModel?: string;
  initialMode?: string;
  placeholder?: string;
  // If the seed ends with a user message, stream a reply to it on mount.
  autoSend?: boolean;
  // Thread-spawning actions from the selection menu (links/videos/deep/ask/…).
  // 'copy' and 'save' are handled inline here; the rest are forwarded with the
  // current model+persona so a spawned thread inherits them.
  onContextAction?: (action: ContextAction, text: string, ctx: ChatContext) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>(
    initialMessages.map((m, i) => ({ ...m, id: `seed-${i}` })),
  );
  const [input, setInput] = useState('');
  const [model, setModel] = useState(initialModel);
  const [mode, setMode] = useState(initialMode); // Grok persona
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const listRef = useRef<FlatList>(null);

  const scrollToEnd = () => setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);

  // Stream a reply for the given history; appends an assistant bubble.
  const runStream = useCallback((history: ChatMessage[]) => {
    const botId = `a-${Date.now()}`;
    setMessages((prev) => [...prev, { id: botId, role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    scrollToEnd();
    abortRef.current = streamChat(
      model,
      history,
      {
        onDelta: (delta) => {
          setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, content: m.content + delta } : m)));
          scrollToEnd();
        },
        onDone: () => {
          setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, streaming: false } : m)));
          setBusy(false);
        },
        onError: (err) => {
          setError(err);
          setMessages((prev) =>
            prev.map((m) => (m.id === botId ? { ...m, streaming: false, content: m.content || '⚠️ ' + err } : m)),
          );
          setBusy(false);
        },
      },
      { mode },
    );
  }, [model, mode]);

  const sendPrompt = useCallback((text: string) => {
    if (!text || busy) return;
    setError(null);
    const userMsg: Msg = { id: `u-${Date.now()}`, role: 'user', content: text };
    const history: ChatMessage[] = [...messages, userMsg].map(({ role, content }) => ({ role, content }));
    setMessages((prev) => [...prev, userMsg]);
    runStream(history);
  }, [busy, messages, runStream]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    sendPrompt(text);
  }, [input, sendPrompt]);

  // Fire an initial completion if seeded with a trailing user message.
  const autoFired = useRef(false);
  useEffect(() => {
    if (autoSend && !autoFired.current && initialMessages.length) {
      const last = initialMessages[initialMessages.length - 1];
      if (last.role === 'user') {
        autoFired.current = true;
        runStream(initialMessages.map(({ role, content }) => ({ role, content })));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => { abortRef.current?.(); setBusy(false); };

  // Selection context menu (long-press an assistant message).
  const [menuText, setMenuText] = useState<string | null>(null);

  const handleAction = useCallback(async (action: ContextAction, text: string) => {
    if (!text) return;
    if (action === 'copy') {
      await Clipboard.setStringAsync(text);
      Alert.alert('Copied');
      return;
    }
    if (action === 'save') {
      try {
        await Brain.ingest(text, { title: text.slice(0, 60), source: 'DeepDive' });
        Alert.alert('Saved', 'Sent to Second Brain.');
      } catch (e: any) {
        Alert.alert('Failed', e?.message || 'Could not save.');
      }
      return;
    }
    if (onContextAction) { onContextAction(action, text, { model, mode }); return; }
    // Standalone fallback (no tabbed host): run text actions inline; branching
    // research actions need the DeepDives workspace.
    if (action === 'ask') sendPrompt(text);
    else if (action === 'details') sendPrompt(`Tell me more, and go deeper on: "${text}"`);
    else if (action === 'examples') sendPrompt(`Provide 3-5 concrete, diverse examples that illustrate: "${text}"`);
    else if (action === 'simplify') sendPrompt(`Explain this in the simplest possible terms: "${text}"`);
    else Alert.alert('Open in DeepDives', 'Links, videos, and Deep Dive branch into new threads — use this from the DeepDives tab.');
  }, [onContextAction, sendPrompt, model, mode]);

  const currentModelLabel = MODELS.find((m) => m.key === model)?.label || model;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, paddingBottom: 16 }}
        ListEmptyComponent={
          <Text style={styles.hint}>Start a conversation. Responses are generated by your AIOS desktop.</Text>
        }
        renderItem={({ item }) => (
          <Bubble
            msg={item}
            onLongPress={item.role === 'assistant' && item.content && !item.streaming
              ? () => setMenuText(item.content)
              : undefined}
          />
        )}
      />

      {error ? <Text style={styles.err}>{error}</Text> : null}

      {/* Grok personas — only when Grok is the active model. */}
      {model === 'grok' ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.modelRow} contentContainerStyle={{ paddingHorizontal: 10, gap: 8 }}>
          {GROK_MODES.map((p) => (
            <Pressable key={p.key} onPress={() => setMode(p.key)} style={[styles.chip, mode === p.key && styles.chipOn]}>
              <Text style={[styles.chipText, mode === p.key && styles.chipTextOn]}>{p.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {/* Model dropdown trigger. */}
      <View style={styles.modelBar}>
        <Pressable style={styles.modelTrigger} onPress={() => setShowModelMenu(true)}>
          <Text style={styles.modelTriggerText}>{currentModelLabel}{model === 'grok' ? ` · ${GROK_MODES.find((g) => g.key === mode)?.label}` : ''}</Text>
          <Text style={styles.modelCaret}>▾</Text>
        </Pressable>
      </View>

      <Modal visible={showModelMenu} transparent animationType="fade" onRequestClose={() => setShowModelMenu(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setShowModelMenu(false)}>
          <View style={styles.menu}>
            <Text style={styles.menuTitle}>Model</Text>
            {MODELS.map((m) => (
              <Pressable
                key={m.key}
                style={[styles.menuItem, model === m.key && styles.menuItemOn]}
                onPress={() => { setModel(m.key); setShowModelMenu(false); }}
              >
                <Text style={[styles.menuItemText, model === m.key && { color: '#fff' }]}>{m.label}</Text>
                {model === m.key ? <Text style={styles.menuCheck}>✓</Text> : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor={theme.textFaint}
          value={input}
          onChangeText={setInput}
          multiline
        />
        <Pressable onPress={busy ? stop : send} style={[styles.sendBtn, busy && { backgroundColor: theme.surfaceAlt }]}>
          <Text style={styles.sendText}>{busy ? '■' : '↑'}</Text>
        </Pressable>
      </View>

      <SelectionMenu
        visible={menuText !== null}
        text={menuText || ''}
        onClose={() => setMenuText(null)}
        onAction={handleAction}
      />
    </KeyboardAvoidingView>
  );
}

function Bubble({ msg, onLongPress }: { msg: Msg; onLongPress?: () => void }) {
  const isUser = msg.role === 'user';
  return (
    <View style={[styles.bubbleWrap, { alignItems: isUser ? 'flex-end' : 'flex-start' }]}>
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={300}
        style={[styles.bubble, isUser ? styles.userBubble : styles.botBubble]}
      >
        {isUser ? (
          <Text style={styles.userText}>{msg.content}</Text>
        ) : (
          <Markdown style={mdStyles}>{msg.content || (msg.streaming ? '…' : '')}</Markdown>
        )}
        {!isUser && onLongPress ? <Text style={styles.actionsHint}>hold for actions</Text> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  hint: { color: theme.textFaint, textAlign: 'center', marginTop: 40, paddingHorizontal: 30, fontSize: 13 },
  bubbleWrap: { marginBottom: 10 },
  bubble: { maxWidth: '88%', borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 10 },
  userBubble: { backgroundColor: theme.accentDim },
  botBubble: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1 },
  userText: { color: '#fff', fontSize: 15 },
  actionsHint: { color: theme.textFaint, fontSize: 10, marginTop: 6, opacity: 0.6 },
  err: { color: '#fca5a5', fontSize: 12, paddingHorizontal: 14, paddingBottom: 4 },
  modelRow: { maxHeight: 44, flexGrow: 0 },
  chip: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, marginVertical: 6 },
  chipOn: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  chipText: { color: theme.textDim, fontSize: 12, fontWeight: '600' },
  chipTextOn: { color: '#fff' },
  modelBar: { paddingHorizontal: 10, paddingBottom: 6, alignItems: 'flex-start' },
  modelTrigger: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: theme.surface, borderColor: theme.borderSoft, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  modelTriggerText: { color: theme.text, fontSize: 13, fontWeight: '600' },
  modelCaret: { color: theme.textFaint, fontSize: 11 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 32 },
  menu: { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: radius.lg, padding: 8 },
  menuTitle: { color: theme.textFaint, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, paddingHorizontal: 12, paddingVertical: 8 },
  menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 13, borderRadius: radius.md },
  menuItemOn: { backgroundColor: theme.accentDim },
  menuItemText: { color: theme.text, fontSize: 15, fontWeight: '600' },
  menuCheck: { color: '#fff', fontSize: 14 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, gap: 8, borderTopColor: theme.border, borderTopWidth: 1, backgroundColor: theme.bg },
  input: { flex: 1, maxHeight: 120, backgroundColor: theme.surface, borderColor: theme.borderSoft, borderWidth: 1, borderRadius: radius.lg, color: theme.text, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.accentDim, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#fff', fontSize: 20, fontWeight: '700' },
});

const mdStyles = {
  body: { color: theme.text, fontSize: 15 },
  code_inline: { backgroundColor: theme.surfaceAlt, color: '#e4e4e7', borderRadius: 4, paddingHorizontal: 4 },
  code_block: { backgroundColor: '#000', color: '#e4e4e7', borderRadius: 8, padding: 10 },
  fence: { backgroundColor: '#000', color: '#e4e4e7', borderRadius: 8, padding: 10 },
  link: { color: theme.accent },
  heading1: { color: theme.text, fontSize: 20, fontWeight: '700' },
  heading2: { color: theme.text, fontSize: 18, fontWeight: '700' },
  bullet_list: { color: theme.text },
} as any;
