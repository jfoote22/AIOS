// Shared dark theme tokens — mirrors the AIOS desktop zinc/indigo palette.
export const theme = {
  bg: '#09090b', // zinc-950
  surface: '#18181b', // zinc-900
  surfaceAlt: '#27272a', // zinc-800
  border: '#27272a',
  borderSoft: '#3f3f46', // zinc-700
  text: '#fafafa',
  textDim: '#a1a1aa', // zinc-400
  textFaint: '#71717a', // zinc-500
  accent: '#6366f1', // indigo-500
  accentDim: '#4f46e5', // indigo-600
  good: '#10b981', // emerald-500
  bad: '#ef4444', // red-500
  warn: '#f59e0b', // amber-500
};

export const radius = { sm: 8, md: 12, lg: 16, xl: 20 };
export const space = (n: number) => n * 4;
