// Export a finished Deep Research report to Markdown, PDF, or DOCX.
// Runs in the Electron main process: PDF uses an offscreen BrowserWindow's
// printToPDF; DOCX is built with the `docx` package from a lightweight
// markdown parse. Markdown is written verbatim.

const { BrowserWindow } = require('electron');

// --- Minimal markdown → block model (shared by HTML + DOCX) ---
// Blocks: {kind:'h',level,text} | {kind:'p',text} | {kind:'li',ordered,text} | {kind:'hr'}
function parseBlocks(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { blocks.push({ kind: 'p', text: para.join(' ').trim() }); para = []; }
  };
  let inFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    if (/^```/.test(line.trim())) { flushPara(); inFence = !inFence; continue; }
    if (inFence) { blocks.push({ kind: 'p', text: line }); continue; }
    const trimmed = line.trim();
    if (!trimmed) { flushPara(); continue; }
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); blocks.push({ kind: 'h', level: h[1].length, text: h[2].trim() }); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushPara(); blocks.push({ kind: 'hr' }); continue; }
    const ul = trimmed.match(/^[-*+]\s+(.*)$/);
    if (ul) { flushPara(); blocks.push({ kind: 'li', ordered: false, text: ul[1].trim() }); continue; }
    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { flushPara(); blocks.push({ kind: 'li', ordered: true, text: ol[1].trim() }); continue; }
    para.push(trimmed);
  }
  flushPara();
  return blocks;
}

// Tokenize inline markdown into styled runs: {text,bold,italic,code,link}
function parseInline(text) {
  const runs = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[2] != null) runs.push({ text: m[2], bold: true });
    else if (m[3] != null) runs.push({ text: m[3], bold: true });
    else if (m[4] != null) runs.push({ text: m[4], italic: true });
    else if (m[5] != null) runs.push({ text: m[5], italic: true });
    else if (m[6] != null) runs.push({ text: m[6], code: true });
    else if (m[7] != null) runs.push({ text: m[7], link: m[8] });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

// --- HTML (for PDF) ---
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function runsToHtml(text) {
  return parseInline(text).map(r => {
    const t = escapeHtml(r.text);
    if (r.link) return `<a href="${escapeHtml(r.link)}">${t}</a>`;
    if (r.code) return `<code>${t}</code>`;
    if (r.bold) return `<strong>${t}</strong>`;
    if (r.italic) return `<em>${t}</em>`;
    return t;
  }).join('');
}
function mdToHtml(md, title) {
  const blocks = parseBlocks(md);
  const out = [];
  let listOpen = null; // 'ul' | 'ol'
  const closeList = () => { if (listOpen) { out.push(`</${listOpen}>`); listOpen = null; } };
  for (const b of blocks) {
    if (b.kind === 'li') {
      const tag = b.ordered ? 'ol' : 'ul';
      if (listOpen !== tag) { closeList(); out.push(`<${tag}>`); listOpen = tag; }
      out.push(`<li>${runsToHtml(b.text)}</li>`);
      continue;
    }
    closeList();
    if (b.kind === 'h') out.push(`<h${b.level}>${runsToHtml(b.text)}</h${b.level}>`);
    else if (b.kind === 'hr') out.push('<hr/>');
    else out.push(`<p>${runsToHtml(b.text)}</p>`);
  }
  closeList();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(title || 'Research Report')}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 760px; margin: 40px auto; padding: 0 24px; line-height: 1.6; font-size: 14px; }
  h1 { font-size: 26px; margin: 24px 0 12px; } h2 { font-size: 20px; margin: 22px 0 10px; border-bottom: 1px solid #e5e5e5; padding-bottom: 4px; }
  h3 { font-size: 16px; margin: 18px 0 8px; } p { margin: 10px 0; } ul, ol { margin: 10px 0; padding-left: 24px; }
  li { margin: 4px 0; } a { color: #4f46e5; word-break: break-word; } code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 20px 0; }
</style></head><body>${out.join('\n')}</body></html>`;
}

// Render HTML to a PDF buffer via an offscreen window.
async function htmlToPdf(html) {
  const win = new BrowserWindow({
    show: false, width: 900, height: 1200,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 300));
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'default' },
      pageSize: 'A4',
    });
    return pdf;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// --- DOCX ---
async function mdToDocx(md, title) {
  const docx = require('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink } = docx;
  const blocks = parseBlocks(md);

  const headingFor = (lvl) =>
    lvl === 1 ? HeadingLevel.HEADING_1 :
    lvl === 2 ? HeadingLevel.HEADING_2 :
    lvl === 3 ? HeadingLevel.HEADING_3 :
    lvl === 4 ? HeadingLevel.HEADING_4 : HeadingLevel.HEADING_5;

  const runsFor = (text) => parseInline(text).map(r => {
    if (r.link) {
      return new ExternalHyperlink({
        link: r.link,
        children: [new TextRun({ text: r.text, style: 'Hyperlink' })],
      });
    }
    return new TextRun({ text: r.text, bold: !!r.bold, italics: !!r.italic, font: r.code ? 'Consolas' : undefined });
  });

  const children = [];
  if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }));
  for (const b of blocks) {
    if (b.kind === 'h') children.push(new Paragraph({ heading: headingFor(b.level), children: runsFor(b.text) }));
    else if (b.kind === 'li') children.push(new Paragraph({ children: runsFor(b.text), bullet: b.ordered ? undefined : { level: 0 }, numbering: undefined }));
    else if (b.kind === 'hr') children.push(new Paragraph({ children: [new TextRun('')], border: { bottom: { color: 'CCCCCC', space: 1, size: 6, style: 'single' } } }));
    else children.push(new Paragraph({ children: runsFor(b.text) }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// Build the file content for a given format. Returns { buffer|text, ext, mime }.
async function buildExport(format, title, markdown) {
  if (format === 'md') {
    return { text: markdown, ext: 'md', mime: 'text/markdown' };
  }
  if (format === 'pdf') {
    const buffer = await htmlToPdf(mdToHtml(markdown, title));
    return { buffer, ext: 'pdf', mime: 'application/pdf' };
  }
  if (format === 'docx') {
    const buffer = await mdToDocx(markdown, title);
    return { buffer, ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  throw new Error(`Unknown export format: ${format}`);
}

module.exports = { buildExport, mdToHtml, parseBlocks, parseInline };
