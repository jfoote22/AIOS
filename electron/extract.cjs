// Server-side content extraction for DeepDive research.
// Approved file reads and networking run in main; document/HTML parsing in bounded child processes.
//
// Phase A: extractUrl() — static fetch + Readability + Turndown.
// JS-rendered pages require a future network-isolated rendering worker.
// File extraction (PDF/Office/images) lives in this module too (Phase B/C).

const { publicFetch, resolvePublicUrl } = require('./public-fetch.cjs');
const { fileAccess } = require('./file-access.cjs');
const { parseDocument } = require('./document-parser.cjs');
const path = require('node:path');

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
  const parsed = await parseDocument('html', Buffer.from(html), finalUrl);
  const { title, text: markdown } = parsed;
  const method = 'static';

  // Scripted pages stay thin until a network-isolated rendering worker exists.
  // Running arbitrary pages in a BrowserWindow bypasses DNS-pinned egress.

  const truncated = parsed.truncated;
  return {
    ok: true,
    title: title || u.hostname,
    text: truncated ? markdown.slice(0, PER_SOURCE_CHAR_CAP) : markdown,
    source: finalUrl,
    kind: 'url',
    charCount: parsed.charCount,
    truncated,
    thin: parsed.thin,
    method,
  };
}

// ---------------------------------------------------------------------------
// File extraction
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB hard cap

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif']);
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

// Extract text from a local file. `visionExtractor` (optional) is an async
// fn(buffer, mimeHint) -> string used for images and scanned PDFs; injected by
// the API layer so this module stays free of provider/key concerns.
let activeAttachments = 0;
async function extractFile(filePath, visionExtractor) {
  if (activeAttachments >= 2) throw Object.assign(new Error('Attachment processing is busy. Please retry shortly.'), { status: 429 });
  activeAttachments++;
  try { return await extractSelectedFile(filePath, visionExtractor); }
  finally { activeAttachments--; }
}

async function extractSelectedFile(filePath, visionExtractor) {
  // Authorization precedes any parse or provider request, including vision.
  const buf = await fileAccess.readAttachment(filePath, MAX_FILE_BYTES);
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  const base = { ok: true, title: name, source: filePath, kind: 'file', method: 'file' };

  // Images → vision extractor (fixed extractor, model-agnostic for chat).
  if (IMAGE_EXTS.has(ext)) {
    if (!visionExtractor) throw new Error('Image extraction requires a vision model (configure Gemini or OpenAI in the Models tab).');
    const text = await visionExtractor(buf, ext);
    return { ...base, method: 'vision', ...capText(text) };
  }

  if (ext === '.pdf') {
    const parsed = await parseDocument(ext, buf);
    const { text, pageCount } = parsed;
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
    return { ...base, ...parsed, title: name };
  }

  if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
    return { ...base, ...await parseDocument(ext, buf), title: name };
  }
  if (ext === '.doc' || ext === '.xls') {
    throw new Error('Legacy .doc/.xls files are not supported. Save as .docx/.xlsx or plain text/CSV and re-attach.');
  }
  const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.html', '.htm', '.log', '.yaml', '.yml', '.toml', '.ini', '.js', '.jsx', '.ts', '.tsx', '.py', '.c', '.cpp', '.h', '.cs', '.php', '.css', '.sql', '.sh', '.ps1', '.rs', '.go', '.java', '.rb']);
  if (!textExtensions.has(ext)) throw new Error('Unsupported file format. Attach a text, PDF, DOCX, XLSX, PPTX, or image file.');
  if (buf.includes(0)) throw new Error('Binary content is not supported as a text attachment.');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(buf);
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
