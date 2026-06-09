import React, { useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { analyzeImage, Brain } from '../api/client';
import { Button, Card, ErrorBanner, Tag } from '../components/ui';
import { theme, radius } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface Analysis {
  title: string; summary: string; category: string; source: string;
  tags: string[]; entities: any[]; extractedText: string;
}

export default function CaptureScreen() {
  const nav = useNavigation<Nav>();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toDataUrl = (asset: ImagePicker.ImagePickerAsset) => {
    const mime = asset.mimeType || 'image/jpeg';
    return `data:${mime};base64,${asset.base64}`;
  };

  const handlePicked = async (result: ImagePicker.ImagePickerResult) => {
    if (result.canceled || !result.assets?.[0]?.base64) return;
    const url = toDataUrl(result.assets[0]);
    setDataUrl(url);
    setAnalysis(null);
    setError(null);
    setAnalyzing(true);
    try {
      setAnalysis(await analyzeImage(url));
    } catch (e: any) {
      setError(e?.message || 'OCR failed. Check that an OpenAI key is set on the desktop (Models tab).');
    } finally {
      setAnalyzing(false);
    }
  };

  const pickLibrary = async () => {
    setError(null);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], base64: true, quality: 0.8,
      });
      await handlePicked(res);
    } catch (e: any) {
      setError(e?.message || 'Could not open the photo picker.');
    }
  };

  const takePhoto = async () => {
    setError(null);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) { setError('Camera permission denied.'); return; }
      const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.8 });
      await handlePicked(res);
    } catch (e: any) {
      setError(e?.message || 'Could not open the camera.');
    }
  };

  const save = async () => {
    if (!analysis || !dataUrl) return;
    setSaving(true);
    try {
      await Brain.create({
        image: dataUrl,
        title: analysis.title,
        summary: analysis.summary,
        category: analysis.category,
        source: analysis.source || 'Mobile',
        tags: analysis.tags,
        entities: analysis.entities,
        extractedText: analysis.extractedText,
        status: 'ready',
      });
      Alert.alert('Saved', 'Added to Second Brain.', [{ text: 'OK', onPress: () => nav.goBack() }]);
    } catch (e: any) {
      setError(e?.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16 }}>
      <ErrorBanner text={error} />

      <View style={styles.row}>
        <View style={{ flex: 1 }}><Button title="🖼 Pick screenshot" variant="ghost" onPress={pickLibrary} /></View>
        <View style={{ flex: 1 }}><Button title="📷 Take photo" variant="ghost" onPress={takePhoto} /></View>
      </View>

      {dataUrl ? <Image source={{ uri: dataUrl }} style={styles.preview} resizeMode="contain" /> : (
        <Text style={styles.hint}>Pick a screenshot or snap a photo. AIOS will OCR it and extract a title, summary, tags, and any links — same as the desktop snipping vault.</Text>
      )}

      {analyzing ? <Text style={styles.analyzing}>Analyzing on desktop…</Text> : null}

      {analysis ? (
        <Card style={{ marginTop: 16 }}>
          <Text style={styles.title}>{analysis.title}</Text>
          <View style={styles.metaRow}>
            {analysis.category ? <Tag text={analysis.category} /> : null}
            {analysis.source ? <Tag text={analysis.source} /> : null}
          </View>
          {analysis.summary ? <Text style={styles.summary}>{analysis.summary}</Text> : null}
          {analysis.tags?.length ? (
            <View style={styles.metaRow}>{analysis.tags.map((t) => <Tag key={t} text={t} />)}</View>
          ) : null}
          {analysis.extractedText ? (
            <>
              <Text style={styles.label}>Extracted text</Text>
              <View style={styles.codeBox}><Text style={styles.code} numberOfLines={12}>{analysis.extractedText}</Text></View>
            </>
          ) : null}
          <View style={{ height: 14 }} />
          <Button title="Save to Second Brain" onPress={save} loading={saving} />
        </Card>
      ) : null}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  row: { flexDirection: 'row', gap: 10 },
  preview: { width: '100%', height: 240, borderRadius: radius.lg, marginTop: 16, backgroundColor: theme.surface },
  hint: { color: theme.textFaint, fontSize: 13, lineHeight: 19, marginTop: 24, textAlign: 'center', paddingHorizontal: 10 },
  analyzing: { color: theme.accent, textAlign: 'center', marginTop: 16 },
  title: { color: theme.text, fontSize: 18, fontWeight: '800' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  summary: { color: theme.text, fontSize: 14, lineHeight: 20, marginTop: 10 },
  label: { color: theme.textFaint, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  codeBox: { backgroundColor: '#000', borderColor: theme.border, borderWidth: 1, borderRadius: radius.md, padding: 10 },
  code: { color: '#d4d4d8', fontSize: 12, fontFamily: 'monospace', lineHeight: 17 },
});
