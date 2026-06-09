import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import EventSource from 'react-native-sse';
import { Term } from '../api/client';
import { Button, Empty, ErrorBanner, Field, Loading } from '../components/ui';
import { theme, radius } from '../theme';

// Minimal ANSI/control stripper so command output is readable without a full
// terminal emulator. Good enough for shells, git, ls, build output, etc.
function clean(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // CSI sequences
    .replace(/\x1b\][^\x07]*\x07/g, '')      // OSC sequences
    .replace(/\x1b[()][AB0]/g, '')
    .replace(/\r(?!\n)/g, '\n')               // bare CR -> newline (rough)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

export default function TerminalScreen() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [output, setOutput] = useState('');
  const [input, setInput] = useState('');
  const [cwd, setCwd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const append = useCallback((chunk: string) => {
    setOutput((prev) => {
      const next = (prev + clean(chunk)).slice(-20000); // cap buffer
      return next;
    });
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 30);
  }, []);

  const connect = useCallback((id: string) => {
    esRef.current?.close();
    const es = new EventSource(Term.streamUrl(id), { pollingInterval: 0 }) as any;
    es.addEventListener('data', (e: any) => { if (e.data != null) append(e.data); });
    es.addEventListener('exit', () => { append('\n[process exited]\n'); setSessionId(null); es.close(); });
    es.addEventListener('error', () => {/* keep-alive ticks land here too; ignore */});
    esRef.current = es;
  }, [append]);

  const spawn = useCallback(async () => {
    setError(null);
    setBusy(true);
    setOutput('');
    try {
      const r = await Term.spawn({ cols: 80, rows: 24, cwd: cwd.trim() || undefined });
      setSessionId(r.id);
      connect(r.id);
    } catch (e: any) {
      setError(e?.message || 'Failed to start terminal.');
    } finally {
      setBusy(false);
    }
  }, [connect]);

  // Probe availability + reattach to an existing session on focus.
  useFocusEffect(useCallback(() => {
    let active = true;
    (async () => {
      try {
        const { available: avail, items } = await Term.list();
        if (!active) return;
        setAvailable(avail);
        const live = items.find((s: any) => !s.exited);
        if (live && !sessionId) { setSessionId(live.id); connect(live.id); }
      } catch (e: any) {
        if (active) { setAvailable(false); setError(e?.message || 'Failed to reach desktop.'); }
      }
    })();
    return () => {
      active = false;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect, sessionId]));

  const sendInput = async (data: string) => {
    if (!sessionId) return;
    try { await Term.input(sessionId, data); }
    catch (e: any) { setError(e?.message || 'Send failed.'); }
  };

  const submit = async () => {
    const line = input;
    setInput('');
    await sendInput(line + '\r');
  };

  const kill = async () => {
    if (sessionId) { try { await Term.kill(sessionId); } catch {} }
    esRef.current?.close();
    setSessionId(null);
  };

  if (available === null) return <Loading text="Checking terminal…" />;
  if (!available) return <View style={styles.screen}><Empty text="node-pty isn't available on the desktop, so terminals are disabled." /></View>;

  if (!sessionId) {
    return (
      <View style={styles.screen}>
        <ErrorBanner text={error} />
        <View style={{ flex: 1, justifyContent: 'center', padding: 20, gap: 16 }}>
          <Text style={styles.lead}>Open a live shell on your desktop</Text>
          <Text style={styles.sub}>
            This is a real terminal running on the machine AIOS is on — run git, npm, claude, anything.
            Type below and it executes there.
          </Text>
          <Field
            label="Start folder (optional)"
            value={cwd}
            onChangeText={setCwd}
            placeholder="e.g. C:\\Users\\rawfo\\Curser\\AIOS\\app"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button title="Open terminal" onPress={spawn} loading={busy} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <ErrorBanner text={error} />
      <ScrollView ref={scrollRef} style={styles.term} contentContainerStyle={{ padding: 10 }}>
        <Text style={styles.termText} selectable>{output || '…'}</Text>
      </ScrollView>

      <View style={styles.keysRow}>
        <Key label="Ctrl+C" onPress={() => sendInput('\x03')} />
        <Key label="Tab" onPress={() => sendInput('\t')} />
        <Key label="↑" onPress={() => sendInput('\x1b[A')} />
        <Key label="↓" onPress={() => sendInput('\x1b[B')} />
        <Key label="Esc" onPress={() => sendInput('\x1b')} />
        <Key label="✕ Kill" onPress={kill} danger />
      </View>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="Type a command…"
          placeholderTextColor={theme.textFaint}
          value={input}
          onChangeText={setInput}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={submit}
          returnKeyType="send"
          blurOnSubmit={false}
        />
        <Pressable style={styles.sendBtn} onPress={submit}><Text style={styles.sendText}>⏎</Text></Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Key({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.key, danger && { backgroundColor: '#3f1d1d' }]}>
      <Text style={[styles.keyText, danger && { color: '#fca5a5' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  lead: { color: theme.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  sub: { color: theme.textFaint, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  term: { flex: 1, backgroundColor: '#000' },
  termText: { color: '#d4d4d8', fontFamily: 'monospace', fontSize: 12, lineHeight: 17 },
  keysRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 8, backgroundColor: theme.surface, borderTopColor: theme.border, borderTopWidth: 1 },
  key: { backgroundColor: theme.surfaceAlt, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  keyText: { color: theme.textDim, fontSize: 12, fontWeight: '600' },
  inputRow: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8, backgroundColor: theme.bg },
  input: { flex: 1, backgroundColor: theme.surface, borderColor: theme.borderSoft, borderWidth: 1, borderRadius: radius.md, color: theme.text, paddingHorizontal: 12, paddingVertical: 9, fontFamily: 'monospace', fontSize: 13 },
  sendBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.accentDim, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#fff', fontSize: 18 },
});
