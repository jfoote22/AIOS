const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const { parseDocument, createParserRunner, parserEnvironment, stopParsers } = require('../electron/document-parser.cjs');
const { inspectOfficeArchive } = require('../electron/archive-policy.cjs');

function officeZip(parts, options = { level: 0 }) {
  const entries = { '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>', ...parts };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, strToU8(value)])), options));
}
function pdfFixture(pages = 1) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, () => '3 0 R').join(' ')}] /Count ${pages} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const content = 'BT /F1 12 Tf 72 720 Td (AIOS PDF fixture) Tj ET';
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let raw = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(raw)); raw += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(raw);
  raw += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  raw += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  raw += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(raw);
}
test('HTML extracts headings/text without executing scripts and caps output', async () => {
  const html = `<html><title>AIOS article</title><body><script>process.exit(9)</script><article><h1>Capture notes</h1><p>${'Useful content. '.repeat(2200)}</p></article></body></html>`;
  const result = await parseDocument('html', Buffer.from(html), 'https://example.com/article');
  assert.equal(result.title, 'AIOS article');
  assert.match(result.text, /Capture notes/);
  assert.equal(result.text.includes('process.exit'), false);
  assert.equal(result.text.length, 24000);
  assert.equal(result.truncated, true);
  assert.ok(result.charCount > 24000);
});
test('DOCX, XLSX and PPTX fixtures retain document text and cell/slide values', async () => {
  const docx = require('docx');
  const document = new docx.Document({ sections: [{ children: [new docx.Paragraph('AIOS document fixture')] }] });
  const word = await parseDocument('.docx', await docx.Packer.toBuffer(document));
  assert.match(word.text, /AIOS document fixture/);
  const workbook = officeZip({
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Research" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>AIOS cell fixture</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
  });
  const excel = await parseDocument('.xlsx', workbook);
  assert.match(excel.text, /AIOS cell fixture/);
  assert.match(excel.text, /42/);
  const powerpoint = officeZip({
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>AIOS slide fixture</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  });
  assert.match((await parseDocument('.pptx', powerpoint)).text, /AIOS slide fixture/);
});
test('PDF extraction, signature validation, and page cap', async () => {
  const parsed = await parseDocument('.pdf', pdfFixture());
  assert.match(parsed.text, /AIOS PDF fixture/);
  assert.equal(parsed.pageCount, 1);
  await assert.rejects(parseDocument('.pdf', Buffer.from('not a PDF')), /signature/);
  await assert.rejects(parseDocument('.pdf', pdfFixture(301)), /300-page/);
});
test('archives reject malformed, traversal, entities, expansion bombs, and excess entries', async () => {
  await assert.rejects(inspectOfficeArchive(Buffer.from('not a ZIP')));
  await assert.rejects(inspectOfficeArchive(officeZip({ '../escape.xml': 'bad' })), /invalid relative path/);
  await assert.rejects(inspectOfficeArchive(officeZip({ 'word/document.xml': '<!DOCTYPE x [<!ENTITY e "expanded">]><x>&e;</x>' })), /entities/);
  await assert.rejects(inspectOfficeArchive(officeZip({ 'word/document.xml': 'a'.repeat(1024 * 1024) }, { level: 9 })), /expansion/);
  await assert.rejects(inspectOfficeArchive(officeZip(Object.fromEntries(Array.from({ length: 2048 }, (_, i) => [`${i}.xml`, '<x/>'])))), /too many/);
  await assert.rejects(parseDocument('.xlsx', officeZip({ 'word/document.xml': '<x/>' })), /extension/);
});
test('worker timeout, crash, invalid response, busy backpressure, and recovery', async () => {
  const parser = createParserRunner({ timeoutMs: 700, maxActive: 1, workerPath: path.join(__dirname, 'parser-fixture.cjs') });
  const hanging = assert.rejects(parser('html', Buffer.from('hang')), /timed out/);
  await assert.rejects(parser('html', Buffer.from('second')), { status: 429 });
  await hanging;
  await assert.rejects(parser('html', Buffer.from('crash')), /stopped unexpectedly/);
  await assert.rejects(parser('html', Buffer.from('invalid')), /Invalid parser response/);
  assert.equal((await parser('html', Buffer.from('ok'))).text, 'no inherited secret');
});
test('parser does not inherit provider secrets or Node injection options', async () => {
  process.env.AIOS_TEST_SECRET = 'synthetic-only';
  try {
    const env = parserEnvironment();
    assert.equal(env.AIOS_TEST_SECRET, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NODE_PATH, undefined);
    const parser = createParserRunner({ workerPath: path.join(__dirname, 'parser-fixture.cjs') });
    assert.equal((await parser('html', Buffer.from('env'))).text, 'no inherited secret');
  } finally { delete process.env.AIOS_TEST_SECRET; }
});
test('oversized/unsupported parser requests reject before spawning', async () => {
  await assert.rejects(parseDocument('html', Buffer.alloc(4 * 1024 * 1024 + 1)), { status: 413 });
  await assert.rejects(parseDocument('.exe', Buffer.from('no')), /Unsupported/);
});
test('application shutdown terminates active workers', async () => {
  const parser = createParserRunner({ workerPath: path.join(__dirname, 'parser-fixture.cjs') });
  const pending = assert.rejects(parser('html', Buffer.from('hang')), /stopped unexpectedly/);
  stopParsers();
  await pending;
});
