// One fixed operation per short-lived child process. Not an OS sandbox.
const { inspectOfficeArchive } = require('./archive-policy.cjs');
const CHAR_CAP = 24000;

async function parse({ kind, bytes, baseUrl }) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 50 * 1024 * 1024) throw new Error('Invalid parser input.');
  let text = '', title = '', pageCount = 0;
  if (kind === 'html') {
    if (bytes.length > 4 * 1024 * 1024) throw new Error('HTML exceeds the size limit.');
    const { JSDOM } = require('jsdom');
    const { Readability } = require('@mozilla/readability');
    const Turndown = require('turndown');
    // Deliberately no scripts or resource loading.
    const dom = new JSDOM(bytes.toString('utf8'), { url: baseUrl });
    try {
      title = dom.window.document.title;
      const fallback = dom.window.document.body?.innerHTML || '';
      let article;
      try { article = new Readability(dom.window.document).parse(); } catch { /* use body */ }
      title = article?.title || title;
      text = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(article?.content || fallback);
    } finally { dom.window.close(); }
  } else if (kind === '.pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Invalid PDF signature.');
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(bytes), isEvalSupported: false });
    try {
      const info = await parser.getInfo();
      if (info.total > 300) throw new Error('PDF exceeds the 300-page limit. Split it into smaller files.');
      const result = await parser.getText();
      text = result.text || ''; pageCount = result.total || result.pages?.length || 0;
    } finally { await parser.destroy(); }
  } else if (['.docx', '.xlsx', '.pptx'].includes(kind)) {
    const archive = await inspectOfficeArchive(bytes);
    const required = { '.docx': 'word/document.xml', '.xlsx': 'xl/workbook.xml', '.pptx': 'ppt/presentation.xml' }[kind];
    if (!archive.names.has(required)) throw new Error('Office content does not match the selected file extension.');
    if (kind === '.docx') text = (await require('mammoth').extractRawText({ buffer: bytes })).value;
    else {
      const ast = await require('officeparser').parseOffice(bytes, { fileType: kind.slice(1), ocr: false, extractAttachments: false });
      text = (await ast.to('text')).value;
    }
  } else throw new Error('Unsupported document format.');
  text = String(text || '').trim();
  return { text: text.slice(0, CHAR_CAP), charCount: text.length, truncated: text.length > CHAR_CAP, thin: text.length < 600, title: String(title || '').slice(0, 512), pageCount };
}
process.once('message', async message => {
  try { process.send(await parse(message), () => process.exit(0)); }
  catch (error) { process.send({ error: String(error?.message || 'Document processing failed.').slice(0, 500) }, () => process.exit(1)); }
});
process.once('disconnect', () => process.exit(0));
