import React, { useEffect, useState } from 'react';
import {
  Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { theme, radius } from '../theme';

// Mirrors the desktop DeepDive selection context menu.
export type ContextAction =
  | 'ask' | 'details' | 'examples' | 'simplify'
  | 'links' | 'videos' | 'deep' | 'save' | 'copy';

const ACTIONS: { action: ContextAction; label: string; icon: string; tint: string }[] = [
  { action: 'ask', label: 'Ask about this', icon: '💬', tint: theme.accent },
  { action: 'details', label: 'Get more details', icon: '📖', tint: '#22d3ee' },
  { action: 'examples', label: 'Give examples', icon: '🧩', tint: '#a78bfa' },
  { action: 'simplify', label: 'Simplify this', icon: '🌱', tint: '#34d399' },
  { action: 'links', label: 'Get links', icon: '🔗', tint: '#60a5fa' },
  { action: 'videos', label: 'Get videos', icon: '🎬', tint: '#f472b6' },
  { action: 'deep', label: 'Deep Dive (autonomous)', icon: '🔬', tint: '#f59e0b' },
  { action: 'save', label: 'Save to Second Brain', icon: '🧠', tint: '#10b981' },
  { action: 'copy', label: 'Copy', icon: '📋', tint: theme.textDim },
];

export function SelectionMenu({
  visible, text, onClose, onAction,
}: {
  visible: boolean;
  text: string;
  onClose: () => void;
  onAction: (action: ContextAction, selectedText: string) => void;
}) {
  // `draft` is the editable copy the user drag-selects within. It must be an
  // editable TextInput because Android only shows selection handles on editable
  // fields — a read-only field can't be partially selected. Editing is a bonus:
  // you can also tweak the context before acting on it.
  const [draft, setDraft] = useState(text);
  const [sel, setSel] = useState({ start: 0, end: 0 });

  // Reset on each open.
  useEffect(() => { if (visible) { setDraft(text); setSel({ start: 0, end: 0 }); } }, [visible, text]);

  const selected = sel.end > sel.start ? draft.slice(sel.start, sel.end) : '';
  const effective = (selected || draft).trim(); // act on selection, or whole message

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>
          {selected ? `Act on selection (${selected.length} chars)` : 'Act on this response'}
        </Text>
        <Text style={styles.hint}>
          Drag to highlight the part you want — the action uses your selection. Highlight nothing to use the whole response.
        </Text>

        <TextInput
          style={styles.textBox}
          value={draft}
          onChangeText={setDraft}
          editable
          showSoftInputOnFocus={false}
          multiline
          scrollEnabled
          onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
        />

        <ScrollView style={styles.actions} contentContainerStyle={{ paddingBottom: 8 }}>
          {ACTIONS.map((a) => (
            <Pressable
              key={a.action}
              style={styles.action}
              onPress={() => { onAction(a.action, effective); onClose(); }}
            >
              <View style={[styles.iconWrap, { backgroundColor: a.tint + '22', borderColor: a.tint }]}>
                <Text style={{ fontSize: 15 }}>{a.icon}</Text>
              </View>
              <Text style={styles.actionLabel}>{a.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <Pressable style={styles.cancel} onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '82%', backgroundColor: theme.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderColor: theme.border, borderWidth: 1, padding: 16 },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: theme.borderSoft, marginBottom: 12 },
  title: { color: theme.text, fontSize: 16, fontWeight: '800' },
  hint: { color: theme.textFaint, fontSize: 12, marginTop: 4, marginBottom: 10 },
  textBox: { maxHeight: 150, backgroundColor: theme.bg, borderColor: theme.border, borderWidth: 1, borderRadius: radius.md, color: theme.text, padding: 12, fontSize: 14, lineHeight: 20 },
  actions: { marginTop: 12, maxHeight: 320 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  iconWrap: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  actionLabel: { color: theme.text, fontSize: 15, fontWeight: '600' },
  cancel: { marginTop: 6, paddingVertical: 12, alignItems: 'center' },
  cancelText: { color: theme.textFaint, fontWeight: '600' },
});
