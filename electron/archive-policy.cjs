// Verify the actual expanded bytes, not just ZIP central-directory claims.
// Nothing is extracted to disk. Every stream is consumed before parsing begins.
const yauzl = require('yauzl');
const MAX_ENTRY = 16 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
async function inspectOfficeArchive(bytes) {
  const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  let entries = 0, total = 0;
  const names = new Set();
  try {
    for await (const entry of zip.eachEntry()) {
      if (++entries > 2048) throw new Error('Archive has too many entries.');
      if (names.has(entry.fileName)) throw new Error('Duplicate archive entry.');
      names.add(entry.fileName);
      if ((entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) throw new Error('Encrypted or unsupported archive entry.');
      if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Archive links are not supported.');
      if (entry.uncompressedSize > MAX_ENTRY || entry.uncompressedSize > Math.max(1, entry.compressedSize) * 200) throw new Error('Archive expansion limit exceeded.');
      if (entry.fileName.endsWith('/')) continue;
      const stream = await zip.openReadStreamPromise(entry);
      let size = 0;
      const xml = /\.(xml|rels)$/i.test(entry.fileName), chunks = [];
      for await (const chunk of stream) {
        size += chunk.length; total += chunk.length;
        if (size > MAX_ENTRY || total > MAX_TOTAL) throw new Error('Archive expansion limit exceeded.');
        if (xml) chunks.push(chunk);
      }
      // DTD/entity expansion is unnecessary for OOXML. Include UTF-16 XML.
      if (xml) {
        const body = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '');
        if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(body)) throw new Error('XML document types and entities are not supported.');
      }
    }
    if (!names.has('[Content_Types].xml')) throw new Error('Not an Office Open XML document.');
    return { entries, expandedBytes: total, names };
  } finally { zip.close(); }
}
module.exports = { inspectOfficeArchive };
