import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Build } from '../api/client';
import { Button, Field, ErrorBanner } from '../components/ui';
import { theme } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Try the API-key auth path first; if the desktop is on Claude subscription
// (no Anthropic key), retry with authMode:'subscription'.
async function draft(field: string, agent: any): Promise<string> {
  try {
    const r = await Build.draftAgent(field, { agent });
    return r?.value ?? '';
  } catch {
    const r = await Build.draftAgent(field, { agent, authMode: 'subscription' });
    return r?.value ?? '';
  }
}

export default function NewAgentScreen() {
  const nav = useNavigation<Nav>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [tools, setTools] = useState('Read, Grep, Glob');
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aiDraft = async () => {
    if (!name.trim()) { setError('Give the agent a name first.'); return; }
    setError(null);
    setDrafting(true);
    try {
      const value = await draft('all', { name: name.trim(), description: description.trim() });
      try {
        const parsed = JSON.parse(value);
        if (parsed.description) setDescription(parsed.description);
        if (parsed.systemPrompt) setSystemPrompt(parsed.systemPrompt);
        if (Array.isArray(parsed.tools)) setTools(parsed.tools.join(', '));
      } catch {
        // Not JSON — drop it into the system prompt so nothing is lost.
        setSystemPrompt(value);
      }
    } catch (e: any) {
      setError(e?.message || 'AI draft failed. You can still fill the fields manually.');
    } finally {
      setDrafting(false);
    }
  };

  const save = async () => {
    if (!name.trim()) { setError('Name is required.'); return; }
    setError(null);
    setSaving(true);
    try {
      await Build.createAgent({
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        allowedTools: tools.split(',').map((t) => t.trim()).filter(Boolean),
      });
      Alert.alert('Saved', 'Agent created on your desktop.');
      nav.goBack();
    } catch (e: any) {
      setError(e?.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <ErrorBanner text={error} />
        <View style={{ gap: 14 }}>
          <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Release notes writer" />
          <Button title={drafting ? 'Drafting…' : '✨ AI draft details'} variant="ghost" onPress={aiDraft} loading={drafting} />
          <Field label="Description" value={description} onChangeText={setDescription} placeholder="What it does and when to use it" multiline style={{ minHeight: 60 }} />
          <Field label="System prompt" value={systemPrompt} onChangeText={setSystemPrompt} placeholder="The agent's instructions" multiline style={{ minHeight: 140 }} />
          <Field label="Allowed tools (comma-separated)" value={tools} onChangeText={setTools} placeholder="Read, Grep, Glob" autoCapitalize="none" />
        </View>
        <View style={{ height: 20 }} />
        <Button title="Save agent" onPress={save} loading={saving} />
        <Text style={styles.note}>Saved to your desktop's agent library — it appears in AIOS Orchestra too.</Text>
        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16 },
  note: { color: theme.textFaint, fontSize: 12, textAlign: 'center', marginTop: 12, lineHeight: 18 },
});
