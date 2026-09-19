import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { theme, radius } from '../theme';

// A tap on a neuron inside the 3D page (see app/src/brain-mobile/main.tsx,
// which posts these via window.ReactNativeWebView.postMessage).
export interface BrainNodeTap {
  id: string;      // graph node id, e.g. "snip:abc123"
  kind: string;    // 'snippet' | 'deepdive' | 'import' | 'cluster'
  label: string;
  rawId: string;   // id with the kind prefix stripped
}

// The desktop's 3D Second Brain (Three.js), served by the mobile gateway at
// /brain3d/ and rendered here in a WebView. The page authenticates its data
// fetch with a token injected only into the expected page, never into its URL.
export function Brain3DView({ url, token, onNodeTap }: {
  url: string;
  token: string;
  onNodeTap?: (tap: BrainNodeTap) => void;
}) {
  const webRef = useRef<WebView>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Bumping the key remounts the WebView — more reliable than reload() after
  // a hard failure (e.g. the desktop was unreachable when we first rendered).
  const [attempt, setAttempt] = useState(0);

  const src = useMemo(
    () => `${url.replace(/\/+$/, '')}/brain3d/`,
    [url],
  );
  const injectAuth = `if (window.location.href === ${JSON.stringify(src)}) {
    window.__AIOS_MOBILE_TOKEN = ${JSON.stringify(token)};
    window.dispatchEvent(new Event('aios-mobile-auth'));
  } true;`;

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg?.type === 'node' && msg.id) {
        onNodeTap?.({ id: msg.id, kind: msg.kind || '', label: msg.label || '', rawId: msg.rawId || msg.id });
      }
    } catch {}
  }, [onNodeTap]);

  if (failed) {
    return (
      <View style={styles.center}>
        <Text style={styles.errTitle}>Can’t reach the 3D brain</Text>
        <Text style={styles.errDetail}>{failed}</Text>
        <Text style={styles.errHint}>Make sure AIOS is running on the desktop (and the app is built — `npm run build`).</Text>
        <Pressable style={styles.retry} onPress={() => { setFailed(null); setAttempt((a) => a + 1); }}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <WebView
      key={attempt}
      ref={webRef}
      source={{ uri: src }}
      injectedJavaScript={injectAuth}
      originWhitelist={[url.replace(/\/+$/, '')]}
      onShouldStartLoadWithRequest={request => request.url === src || request.url === 'about:blank'}
      javaScriptCanOpenWindowsAutomatically={false}
      style={styles.web}
      containerStyle={styles.web}
      onMessage={onMessage}
      javaScriptEnabled
      domStorageEnabled
      setSupportMultipleWindows={false}
      overScrollMode="never"
      bounces={false}
      startInLoadingState
      renderLoading={() => (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <ActivityIndicator color={theme.accent} size="large" />
          <Text style={styles.loadingText}>Waking the brain…</Text>
        </View>
      )}
      onError={(e) => setFailed(e.nativeEvent.description || 'Failed to load.')}
      onHttpError={(e) => setFailed(`Gateway returned ${e.nativeEvent.statusCode}.`)}
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: '#04060d' },
  center: { flex: 1, backgroundColor: '#04060d', alignItems: 'center', justifyContent: 'center', padding: 28 },
  loadingText: { color: theme.textFaint, marginTop: 12 },
  errTitle: { color: theme.text, fontWeight: '700', fontSize: 16 },
  errDetail: { color: theme.textDim, fontSize: 13, marginTop: 8, textAlign: 'center' },
  errHint: { color: theme.textFaint, fontSize: 12, marginTop: 8, textAlign: 'center' },
  retry: { marginTop: 18, backgroundColor: theme.accentDim, borderRadius: radius.md, paddingHorizontal: 22, paddingVertical: 10 },
  retryText: { color: '#fff', fontWeight: '700' },
});
