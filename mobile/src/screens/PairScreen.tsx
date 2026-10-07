import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../store/auth';
import { Button, Field, ErrorBanner } from '../components/ui';
import { theme } from '../theme';

export default function PairScreen() {
  const { pairWithCode, pairWithUrl } = useAuth();
  const [mode, setMode] = useState<'scan' | 'code' | 'manual'>('scan');
  const [permission, requestPermission] = useCameraPermissions();
  // The camera fires many events per QR; only act on the first until it fails.
  const scanning = useRef(false);
  const [code, setCode] = useState('');
  const [url, setUrl] = useState('http://');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pasteCode = async () => {
    const t = await Clipboard.getStringAsync();
    if (t) setCode(t.trim());
  };

  const onScanned = async ({ data }: { data: string }) => {
    if (scanning.current || busy) return;
    scanning.current = true;
    setBusy(true);
    setError(null);
    try {
      await pairWithCode(data);
    } catch (e: any) {
      setError(e?.message || 'That QR code did not pair. Scan the code under Settings → Mobile companion on the desktop.');
      setTimeout(() => { scanning.current = false; }, 1500);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'code') await pairWithCode(code);
      else await pairWithUrl(url, token);
    } catch (e: any) {
      setError(e?.message || 'Pairing failed. Make sure AIOS desktop has the gateway enabled and both devices share a network.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.logo}>AIOS</Text>
          <Text style={styles.subtitle}>Connect to your desktop</Text>
          <Text style={styles.help}>
            On the desktop, open <Text style={styles.b}>Settings → Hermes Gateway → Mobile companion</Text>,
            enable it, then scan its QR code.
          </Text>

          <View style={styles.tabs}>
            <Tab label="Scan QR" active={mode === 'scan'} onPress={() => setMode('scan')} />
            <Tab label="Pairing code" active={mode === 'code'} onPress={() => setMode('code')} />
            <Tab label="Manual" active={mode === 'manual'} onPress={() => setMode('manual')} />
          </View>

          <ErrorBanner text={error} />

          {mode === 'scan' ? (
            !permission?.granted ? (
              <View style={{ gap: 12 }}>
                <Text style={styles.help}>AIOS needs the camera to read the pairing QR code.</Text>
                <Button title="Allow camera" onPress={requestPermission} />
              </View>
            ) : (
              <View style={styles.scanner}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={busy ? undefined : onScanned}
                />
                <Text style={styles.scanHint}>{busy ? 'Connecting…' : 'Point at the QR code on your desktop'}</Text>
              </View>
            )
          ) : mode === 'code' ? (
            <View style={{ gap: 12 }}>
              <Field
                label="Pairing code"
                placeholder="Paste the code from AIOS desktop"
                value={code}
                onChangeText={setCode}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                style={{ minHeight: 80 }}
              />
              <Button title="Paste from clipboard" variant="ghost" onPress={pasteCode} />
            </View>
          ) : (
            <View style={{ gap: 12 }}>
              <Field
                label="Gateway URL"
                placeholder="http://192.168.1.50:8766"
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <Field
                label="Bearer token"
                placeholder="Paste the token"
                value={token}
                onChangeText={setToken}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          )}

          {mode !== 'scan' ? (
            <>
              <View style={{ height: 20 }} />
              <Button title="Connect" onPress={submit} loading={busy} />
            </>
          ) : null}

          <Text style={styles.footnote}>
            Away from home? Put both devices on the same Tailscale/VPN and use that IP.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Text
      onPress={onPress}
      style={[styles.tab, active && styles.tabActive]}
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 24, paddingTop: 60, flexGrow: 1 },
  logo: { color: theme.text, fontSize: 40, fontWeight: '800', letterSpacing: 2 },
  subtitle: { color: theme.textDim, fontSize: 16, marginTop: 4, marginBottom: 16 },
  help: { color: theme.textFaint, fontSize: 13, lineHeight: 19, marginBottom: 24 },
  b: { color: theme.textDim, fontWeight: '600' },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  tab: { color: theme.textFaint, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: theme.surface, overflow: 'hidden', fontSize: 13 },
  tabActive: { color: '#fff', backgroundColor: theme.accentDim },
  scanner: { height: 300, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000', justifyContent: 'flex-end' },
  scanHint: { color: '#fff', textAlign: 'center', padding: 10, backgroundColor: 'rgba(0,0,0,0.55)', fontSize: 13 },
  footnote: { color: theme.textFaint, fontSize: 12, textAlign: 'center', marginTop: 24, lineHeight: 18 },
});
