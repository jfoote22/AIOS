import React from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View,
  type TextInputProps, type ViewStyle,
} from 'react-native';
import { theme, radius } from '../theme';

export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  title, onPress, loading, disabled, variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const bg = variant === 'primary' ? theme.accentDim : variant === 'danger' ? '#3f1d1d' : theme.surfaceAlt;
  const fg = variant === 'danger' ? '#fca5a5' : theme.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : <Text style={[styles.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ width: '100%' }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={theme.textFaint}
        style={[styles.input, style]}
        {...rest}
      />
    </View>
  );
}

export function Tag({ text }: { text: string }) {
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{text}</Text>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

export function ErrorBanner({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <View style={styles.errBanner}>
      <Text style={styles.errText}>{text}</Text>
    </View>
  );
}

export function Loading({ text }: { text?: string }) {
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={theme.accent} />
      {text ? <Text style={[styles.emptyText, { marginTop: 12 }]}>{text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  card: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 16,
  },
  btn: { borderRadius: radius.md, paddingVertical: 13, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontWeight: '700', fontSize: 14 },
  label: { color: theme.textFaint, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  input: {
    backgroundColor: theme.surface,
    borderColor: theme.borderSoft,
    borderWidth: 1,
    borderRadius: radius.md,
    color: theme.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
  },
  tag: { backgroundColor: theme.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  tagText: { color: theme.textDim, fontSize: 11 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyText: { color: theme.textFaint, fontSize: 14, textAlign: 'center' },
  errBanner: { backgroundColor: '#3f1d1d', borderColor: '#7f1d1d', borderWidth: 1, borderRadius: radius.md, padding: 12, marginBottom: 12 },
  errText: { color: '#fca5a5', fontSize: 13 },
});
