import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library/legacy';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { analyzeImage, Brain } from '../api/client';
import { Button, Card, ErrorBanner, Tag } from '../components/ui';
import { theme, radius } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type CaptureRoute = RouteProp<RootStackParamList, 'Capture'>;

// Read a local image (share-sheet copy or media-library file) as a data URL.
async function fileToDataUrl(uri: string, mimeType = 'image/png') {
  const b64 = await readAsStringAsync(uri, { encoding: 'base64' });
  return `data:${mimeType};base64,${b64}`;
}

interface Analysis {
  title: string; summary: string; category: string; source: string;
  tags: string[]; entities: any[]; extractedText: string;
}

export default function CaptureScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<CaptureRoute>();
  const [savedId, setSavedId] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toDataUrl = (asset: ImagePicker.ImagePickerAsset) => {
    const mime = asset.mimeType || 'image/jpeg';
    return `data:${mime};base64,${asset.base64}`;
  };

  // OCR an image on the desktop. autoSave sends it straight to Second Brain —
  // used for share-sheet and latest-screenshot captures.
  const analyze = useCallback(async (url: string, autoSave: boolean) => {
    setDataUrl(url);
    setAnalysis(null);
    setSavedId(null);
    setError(null);
    setAnalyzing(true);
    try {
      const a = await analyzeImage(url);
      setAnalysis(a);
      if (autoSave) setSavedId(await saveItem(url, a));
    } catch (e: any) {
      setError(e?.message || 'OCR failed. Check that a Gemini key is set on the desktop (Models tab).');
    } finally {
      setAnalyzing(false);
    }
  }, []);

  const handlePicked = async (result: ImagePicker.ImagePickerResult) => {
    if (result.canceled || !result.assets?.[0]?.base64) return;
    await analyze(toDataUrl(result.assets[0]), false);
  };

  // Shared from another app via Android's share sheet.
  const sharedUri = route.params?.imageUri;
  const sharedMime = route.params?.mimeType;
  useEffect(() => {
    if (!sharedUri) return;
    fileToDataUrl(sharedUri, sharedMime || 'image/png')
      .then((url) => analyze(url, true))
      .catch((e) => setError(e?.message || 'Could not read the shared image.'));
  }, [sharedUri, sharedMime, analyze]);

  const grabLatest = async () => {
    setError(null);
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      if (!perm.granted) { setError('Photo access denied — allow it in Android settings to grab screenshots.'); return; }
      const album = await MediaLibrary.getAlbumAsync('Screenshots');
      const page = await MediaLibrary.getAssetsAsync({
        ...(album ? { album } : {}),
        first: 1,
        mediaType: 'photo',
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      const asset = page.assets[0];
      if (!asset) { setError('No screenshots found.'); return; }
      const info = await MediaLibrary.getAssetInfoAsync(asset);
      const uri = info.localUri || asset.uri;
      const mime = /\.jpe?g$/i.test(asset.filename) ? 'image/jpeg' : 'image/png';
      await analyze(await fileToDataUrl(uri, mime), true);
    } catch (e: any) {
      setError(e?.message || 'Could not read the latest screenshot.');
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
      await saveItem(dataUrl, analysis);
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
      <View style={{ height: 10 }} />
      <Button title="⚡ Latest screenshot → Second Brain" onPress={grabLatest} loading={analyzing && !analysis} />

      {dataUrl ? <Image source={{ uri: dataUrl }} style={styles.preview} resizeMode="contain" /> : (
        <Text style={styles.hint}>Tip: take a screenshot anywhere, tap Share, and pick AIOS — it goes straight to Second Brain. Or pick a screenshot or snap a photo here. AIOS will OCR it and extract a title, summary, tags, and any links — same as the desktop snipping vault.</Text>
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
          {savedId
            ? <Text style={styles.saved}>✓ Saved to Second Brain</Text>
            : <Button title="Save to Second Brain" onPress={save} loading={saving} />}
        </Card>
      ) : null}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

async function saveItem(image: string, a: Analysis): Promise<string> {
  const res = await Brain.create({
    image,
    title: a.title,
    summary: a.summary,
    category: a.category,
    source: a.source || 'Mobile',
    tags: a.tags,
    entities: a.entities,
    extractedText: a.extractedText,
    status: 'ready',
  });
  return res.id;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  row: { flexDirection: 'row', gap: 10 },
  preview: { width: '100%', height: 240, borderRadius: radius.lg, marginTop: 16, backgroundColor: theme.surface },
  hint: { color: theme.textFaint, fontSize: 13, lineHeight: 19, marginTop: 24, textAlign: 'center', paddingHorizontal: 10 },
  analyzing: { color: theme.accent, textAlign: 'center', marginTop: 16 },
  saved: { color: theme.good, fontWeight: '700', textAlign: 'center' },
  title: { color: theme.text, fontSize: 18, fontWeight: '800' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  summary: { color: theme.text, fontSize: 14, lineHeight: 20, marginTop: 10 },
  label: { color: theme.textFaint, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  codeBox: { backgroundColor: '#000', borderColor: theme.border, borderWidth: 1, borderRadius: radius.md, padding: 10 },
  code: { color: '#d4d4d8', fontSize: 12, fontFamily: 'monospace', lineHeight: 17 },
});
