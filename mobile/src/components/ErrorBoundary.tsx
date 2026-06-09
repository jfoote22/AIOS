import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

interface State { error: Error | null }

// Converts any render/runtime crash into a visible, recoverable screen instead
// of a white screen of death. Especially important in release builds, where
// there's no red-box overlay.
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('App crash caught by ErrorBoundary:', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <View style={styles.wrap}>
          <Text style={styles.title}>Something went wrong</Text>
          <ScrollView style={styles.box}>
            <Text style={styles.msg}>{this.state.error.message || String(this.state.error)}</Text>
          </ScrollView>
          <Pressable style={styles.btn} onPress={this.reset}>
            <Text style={styles.btnText}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: theme.bg, padding: 24, justifyContent: 'center' },
  title: { color: theme.text, fontSize: 20, fontWeight: '800', marginBottom: 14 },
  box: { maxHeight: 260, backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, borderRadius: 12, padding: 14 },
  msg: { color: '#fca5a5', fontSize: 13, fontFamily: 'monospace', lineHeight: 19 },
  btn: { marginTop: 18, backgroundColor: theme.accentDim, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
