import React, { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Build } from '../api/client';
import { Button, Field, ErrorBanner } from '../components/ui';
import { theme } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

async function draft(field: string, skill: any): Promise<string> {
  try {
    const r = await Build.draftSkill(field, { skill });
    return r?.value ?? '';
  } catch {
    const r = await Build.draftSkill(field, { skill, authMode: 'subscription' });
    return r?.value ?? '';
  }
}

export default function NewSkillScreen() {
  const nav = useNavigation<Nav>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aiDraft = async () => {
    if (!name.trim()) { setError('Give the skill a name first.'); return; }
    setError(null);
    setDrafting(true);
    try {
      const desc = await draft('description', { name: name.trim() }).catch(() => '');
      if (desc) setDescription(desc);
      const instr = await draft('instructions', { name: name.trim(), description: desc || description }).catch(() => '');
      if (instr) setInstructions(instr);
      if (!desc && !instr) setError('AI draft returned nothing — fill the fields manually.');
    } catch (e: any) {
      setError(e?.message || 'AI draft failed.');
    } finally {
      setDrafting(false);
    }
  };

  const save = async () => {
    if (!name.trim()) { setError('Name is required.'); return; }
    setError(null);
    setSaving(true);
    try {
      await Build.createSkill({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
      });
      Alert.alert('Saved', 'Skill created on your desktop.');
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
          <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. changelog-writer" />
          <Button title={drafting ? 'Drafting…' : '✨ AI draft details'} variant="ghost" onPress={aiDraft} loading={drafting} />
          <Field label="Description" value={description} onChangeText={setDescription} placeholder="When this skill should trigger" multiline style={{ minHeight: 60 }} />
          <Field label="Instructions" value={instructions} onChangeText={setInstructions} placeholder="The SKILL.md body — how to perform the task" multiline style={{ minHeight: 160 }} />
        </View>
        <View style={{ height: 20 }} />
        <Button title="Save skill" onPress={save} loading={saving} />
        <Text style={styles.note}>Stored in your desktop's skill library.</Text>
        <View style={{ height: 40 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16 },
  note: { color: theme.textFaint, fontSize: 12, textAlign: 'center', marginTop: 12, lineHeight: 18 },
});
