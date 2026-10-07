import React from 'react';
import { Text } from 'react-native';

// Lightweight emoji tab icons (no native icon font dependency needed).
const GLYPHS: Record<string, string> = {
  Home: '💬',
  Brain: '🧠',
  Dives: '🔍',
  Build: '🛠️',
  More: '⋯',
};

export function TabIcon({ route, color }: { route: string; color: string }) {
  return <Text style={{ fontSize: route === 'More' ? 22 : 18, color }}>{GLYPHS[route] || '•'}</Text>;
}
