// Client-side entry for exporting a Deep Research report. Assembles the
// markdown, then hands off to the Electron main process (save dialog +
// PDF/DOCX rendering) via the preload bridge. Falls back to an in-browser
// Markdown download when not running inside Electron.

import type { DeepSource, Citation } from './research';

interface ReportLike {
  query?: string;
  report?: string;
  sources?: DeepSource[];
  citations?: Citation[];
}

export type ExportFormat = 'md' | 'pdf' | 'docx';

// The Claude-written report already ends with a "## Sources" section, so the
// markdown is essentially the report itself with a title header prepended.
function buildReportMarkdown(title: string, r: ReportLike): string {
  const heading = (r.query || title || 'Research Report').trim();
  const body = (r.report || '').trim();
  const alreadyTitled = /^#\s/.test(body);
  return alreadyTitled ? body : `# ${heading}\n\n${body}\n`;
}

export async function exportReport(format: ExportFormat, title: string, research: ReportLike): Promise<void> {
  const markdown = buildReportMarkdown(title, research);
  if (!markdown.trim()) throw new Error('Nothing to export yet.');

  const bridge = (window as any).aios;
  if (bridge?.exportReport) {
    const res = await bridge.exportReport({ format, title, markdown });
    if (res?.canceled) return;
    if (!res?.ok) throw new Error(res?.error || 'Export failed.');
    return;
  }

  // Browser fallback: only Markdown can be produced without the main process.
  if (format !== 'md') {
    throw new Error('PDF and DOCX export require the desktop app.');
  }
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title || 'research-report'}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
