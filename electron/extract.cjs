// Server-side content extraction for DeepDive research.
// Runs in the Electron main process (no CORS, full filesystem access).
//
// Phase A: extractUrl() — static fetch + Readability + Turndown.
// JS-rendered pages require a future network-isolated rendering worker.
// File extraction (PDF/Office/images) lives in this module too (Phase B/C).

const { publicFetch, resolvePublicUrl } = require('./public-fetch.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');

// Lazily-required heavy deps so app boot stays fast and a missing optional
// dep (e.g. a not-yet-installed parser) only breaks the feature that needs it.
let _Readability, _JSDOM, _TurndownService;
function loadWebDeps() {
  if (!_Readability) _Readability = require('@mozilla/readability').Readability;
  if (!_JSDOM) _JSDOM = require('jsdom').JSDOM;
  if (!_TurndownService) _TurndownService = require('turndown');
  return { Readability: _Readability, JSDOM: _JSDOM, TurndownService: _TurndownService };
}

// Caps for the inline-context strategy. RAG (Phase D) will retrieve chunks
// instead of relying on these, but they keep token budgets sane for now.
const PER_SOURCE_CHAR_CAP = 24000;
// Below this many chars of extracted body, the static path is marked "thin".
const THIN_TEXT_THRESHOLD = 600;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AIOS-DeepDive/1.0';

async function assertSafeUrl(rawUrl) {
  return (await resolvePublicUrl(rawUrl)).url;
}

function htmlToCleanMarkdown(html, baseUrl) {
  const { Readability, JSDOM, TurndownService } = loadWebDeps();
  const dom = new JSDOM(html, { url: baseUrl });
  const doc = dom.window.document;
  let articleTitle = (doc.title || '').trim();
  let contentHtml = '';

  try {
    const reader = new Readability(doc);
    const article = reader.parse();
    if (article) {
      if (article.title) articleTitle = article.title.trim();
      contentHtml = article.content || '';
    }
  } catch {
    // Readability can throw on malformed docs — fall through to body.
  }

  if (!contentHtml) {
    contentHtml = doc.body ? doc.body.innerHTML : '';
  }

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  let markdown = '';
  try {
    markdown = turndown.turndown(contentHtml).trim();
  } catch {
    // Last resort: strip tags crudely.
    markdown = contentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return { title: articleTitle, markdown };
}

// Fetch a URL and return cleaned, readable markdown of its main content.
// Returns { ok, title, text, source, kind, charCount, truncated, thin, method }.
// `thin` flags that the static extraction looked empty (a Phase C escalation hook).
async function extractUrl(rawUrl) {
  const res = await publicFetch(rawUrl, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  });
  const u = new URL(res.url);
  if (!res.ok) throw new Error(`Page returned HTTP ${res.status}.`);

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // Plain text / markdown served directly.
  if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
    const raw = (await res.text()).trim();
    const truncated = raw.length > PER_SOURCE_CHAR_CAP;
    return {
      ok: true,
      title: u.hostname + u.pathname,
      text: truncated ? raw.slice(0, PER_SOURCE_CHAR_CAP) : raw,
      source: res.url || u.href,
      kind: 'url',
      charCount: raw.length,
      truncated,
      thin: raw.length < THIN_TEXT_THRESHOLD,
      method: 'static',
    };
  }

  // Non-HTML (PDF, etc.) reached via URL — out of scope for the static path.
  if (!contentType.includes('html') && contentType) {
    throw new Error(`Unsupported content type for a web page: ${contentType}. Download and attach it as a file instead.`);
  }

  const finalUrl = res.url || u.href;
  const html = await res.text();
  const { title, markdown } = htmlToCleanMarkdown(html, finalUrl);
  const method = 'static';

  // Scripted pages stay thin until a network-isolated rendering worker exists.
  // Running arbitrary pages in a BrowserWindow bypasses DNS-pinned egress.

  const truncated = markdown.length > PER_SOURCE_CHAR_CAP;
  return {
    ok: true,
    title: title || u.hostname,
    text: truncated ? markdown.slice(0, PER_SOURCE_CHAR_CAP) : markdown,
    source: finalUrl,
    kind: 'url',
    charCount: markdown.length,
    truncated,
    thin: markdown.length < THIN_TEXT_THRESHOLD,
    method,
  };
}

// ---------------------------------------------------------------------------
// File extraction
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB hard cap

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif']);
// Extensions we treat as plain UTF-8 text/code. Anything not in a known binary
// handler and not obviously binary falls back to a UTF-8 read too.
const BINARY_HANDLED = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.pptx', ...IMAGE_EXTS]);

function capText(raw) {
  const text = (raw || '').trim();
  const truncated = text.length > PER_SOURCE_CHAR_CAP;
  return {
    text: truncated ? text.slice(0, PER_SOURCE_CHAR_CAP) : text,
    charCount: text.length,
    truncated,
    thin: text.length < THIN_TEXT_THRESHOLD,
  };
}

async function extractPdfText(buf) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return { text: result.text || '', pageCount: result.pages?.length || 0 };
  } finally {
    try { await parser.destroy(); } catch { /* ignore */ }
  }
}

async function extractDocxText(buf) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value || '';
}

function extractXlsxText(buf) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const parts = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv.trim()) parts.push(`## Sheet: ${name}\n${csv}`);
  }
  return parts.join('\n\n');
}

async function extractPptxText(filePath) {
  const { parseOffice } = require('officeparser');
  // parseOffice resolves to a document object; toText() flattens it to a string.
  const result = await parseOffice(filePath);
  return typeof result?.toText === 'function' ? result.toText() : String(result || '');
}

// Extract text from a local file. `visionExtractor` (optional) is an async
// fn(buffer, mimeHint) -> string used for images and scanned PDFs; injected by
// the API layer so this module stays free of provider/key concerns.
async function extractFile(filePath, visionExtractor) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('File not found.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large (50 MB max).');

  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  const base = { ok: true, title: name, source: filePath, kind: 'file', method: 'file' };

  // Images → vision extractor (fixed extractor, model-agnostic for chat).
  if (IMAGE_EXTS.has(ext)) {
    if (!visionExtractor) throw new Error('Image extraction requires a vision model (configure Gemini or OpenAI in the Models tab).');
    const buf = await fs.readFile(filePath);
    const text = await visionExtractor(buf, ext);
    return { ...base, method: 'vision', ...capText(text) };
  }

  if (ext === '.pdf') {
    const buf = await fs.readFile(filePath);
    const { text, pageCount } = await extractPdfText(buf);
    // Scanned PDF: little/no extractable text but real pages → try vision.
    if (text.trim().length < THIN_TEXT_THRESHOLD && pageCount > 0 && visionExtractor) {
      try {
        const visionText = await visionExtractor(buf, '.pdf');
        if (visionText && visionText.trim().length > text.trim().length) {
          return { ...base, method: 'vision', ...capText(visionText) };
        }
      } catch (e) {
        console.error('PDF vision fallback failed:', e.message);
      }
    }
    return { ...base, ...capText(text) };
  }

  if (ext === '.docx') {
    const buf = await fs.readFile(filePath);
    return { ...base, ...capText(await extractDocxText(buf)) };
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const buf = await fs.readFile(filePath);
    return { ...base, ...capText(extractXlsxText(buf)) };
  }
  if (ext === '.pptx') {
    return { ...base, ...capText(await extractPptxText(filePath)) };
  }

  // .doc (legacy binary) and other unhandled binary types are not supported.
  if (ext === '.doc') {
    throw new Error('Legacy .doc files are not supported — save as .docx and re-attach.');
  }

  // Everything else: read as UTF-8 text/code.
  const raw = await fs.readFile(filePath, 'utf8');
  return { ...base, ...capText(raw) };
}

module.exports = {
  extractUrl,
  extractFile,
  assertSafeUrl,
  PER_SOURCE_CHAR_CAP,
  THIN_TEXT_THRESHOLD,
  IMAGE_EXTS,
};
