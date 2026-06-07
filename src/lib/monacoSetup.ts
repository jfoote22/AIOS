// Wires Monaco (the editor core extracted from VS Code) to load entirely from
// the bundled package — no CDN — so it works offline inside the packaged
// Electron app. Vite's `?worker` imports turn the Monaco web workers into
// bundled assets, and loader.config({ monaco }) points @monaco-editor/react at
// the local instance instead of fetching from jsdelivr.

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

export const AIOS_DARK_THEME = 'aios-dark';

let configured = false;

export function setupMonaco(): void {
  if (configured) return;
  configured = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (self as any).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'json') return new jsonWorker();
      if (label === 'typescript' || label === 'javascript') return new tsWorker();
      return new editorWorker();
    },
  };

  loader.config({ monaco });

  // Define a theme tuned to the AIOS zinc palette so the embedded editor blends
  // into the rest of the app rather than looking like stock VS Code.
  monaco.editor.defineTheme(AIOS_DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#09090b',          // zinc-950
      'editor.foreground': '#e4e4e7',          // zinc-200
      'editorLineNumber.foreground': '#3f3f46', // zinc-700
      'editorLineNumber.activeForeground': '#a1a1aa', // zinc-400
      'editor.lineHighlightBackground': '#18181b', // zinc-900
      'editor.selectionBackground': '#3730a380', // indigo-800 @ 50%
      'editorCursor.foreground': '#818cf8',     // indigo-400
      'editorWidget.background': '#18181b',
      'editorWidget.border': '#27272a',
      'editorGutter.background': '#09090b',
      'editorIndentGuide.background1': '#1f1f23',
    },
  });
}
