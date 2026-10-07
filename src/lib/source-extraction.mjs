import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { safePath, sha256, atomicWrite } from './vault-io.mjs';
import { decodeText } from './extractors/text.mjs';
import { extractDocument } from './extractors/document-worker.mjs';
import { extractImage } from './extractors/ocr.mjs';
import { extractPdf } from './extractors/pdf.mjs';
import { boundExtractionResult } from './extractors/result-bounds.mjs';
import { createExtractionQueue } from './extractors/queue.mjs';

const TEXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.log', '.rst', '.adoc', '.tex', '.c', '.h', '.cpp', '.hpp', '.py', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.sh', '.toml', '.ini', '.cfg', '.sql', '.css', '.rs', '.go', '.java', '.cs', '.rb', '.ps1', '.bat', '.vue', '.svelte']);
const TYPES = {
  pdf: 'application/pdf', html: 'text/html', xml: 'application/xml', text: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff',
};
const IMAGES = new Set(['png', 'jpeg', 'webp', 'bmp', 'tiff']);
const MARKUP = new Set(['html', 'xml']);
const CACHE_VERSION = '0.3.0-extraction-1';
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const pending = new Map();
export const enqueueExtraction = createExtractionQueue();

export function sourceKind(filename, bytes) {
  const ext = path.extname(filename).toLowerCase();
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'bmp';
  if (['49492a00', '4d4d002a'].includes(bytes.subarray(0, 4).toString('hex'))) return 'tiff';
  const known = { '.htm': 'html', '.xhtml': 'html', '.svg': 'xml', '.jpg': 'jpeg', '.tif': 'tiff', '.docm': 'docx', '.xlsm': 'xlsx', '.pptm': 'pptx' };
  if (known[ext]) return known[ext];
  if (TYPES[ext.slice(1)]) return ext.slice(1);
  if (!ext || TEXT.has(ext)) return 'text';
  return 'unsupported';
}

export const sourceType = (filename, bytes) => TYPES[sourceKind(filename, bytes)] ?? 'application/octet-stream';

async function cachedExtract(root, bytes, kind, options) {
  const identity = { version: CACHE_VERSION, source_hash: sha256(bytes), kind, options,
    ...(['doc', 'ppt'].includes(kind) ? { converter: process.env.PROJECT_WIKI_LIBREOFFICE || null } : {}) };
  const key = sha256(JSON.stringify(identity));
  const relative = `.wiki-server/extractions/${key}.json`;
  const target = await safePath(root, relative, { allowMissing: true });
  try {
    const info = await stat(target);
    if (info.size <= MAX_CACHE_BYTES) {
      const cached = JSON.parse(await readFile(target, 'utf8'));
      if (cached.key === key && cached.digest === sha256(JSON.stringify(cached.result)) && Array.isArray(cached.result?.units)) return { result: boundExtractionResult(cached.result), cache: { hit: true, key } };
    }
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (pending.has(target)) return pending.get(target);
  const operation = enqueueExtraction(async () => {
    const result = boundExtractionResult(kind === 'pdf' ? await extractPdf(bytes, options)
      : IMAGES.has(kind) ? await extractImage(bytes, options) : await extractDocument(kind, bytes, options));
    const serialized = JSON.stringify({ key, digest: sha256(JSON.stringify(result)), result });
    if (Buffer.byteLength(serialized) <= MAX_CACHE_BYTES) await atomicWrite(root, relative, serialized);
    else result.warnings.push('Extraction exceeds the cache size limit; this result was not cached.');
    return { result, cache: { hit: false, key } };
  });
  pending.set(target, operation);
  try { return await operation; }
  finally { pending.delete(target); }
}

function endOfChunk(text, start, maximum) {
  let end = Math.min(text.length, start + maximum);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) throw new Error('Offset splits a Unicode surrogate pair.');
  if (end < text.length && end > start && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return end;
}

function paginateUnits(result, { unit, unit_count, unit_offset, max_chars }) {
  if (unit > Math.max(1, result.units.length)) throw new Error(`unit exceeds the document's ${result.units.length} units.`);
  const units = [];
  let remaining = max_chars, next = null;
  for (let index = unit - 1; index < Math.min(result.units.length, unit - 1 + unit_count); index++) {
    const original = result.units[index], start = index === unit - 1 ? unit_offset : 0;
    if (start > original.text.length) throw new Error('unit_offset exceeds extracted unit length.');
    const end = endOfChunk(original.text, start, remaining);
    units.push({ ...original, unit: index + 1, offset: start, text: original.text.slice(start, end), total_chars: original.text.length });
    remaining -= end - start;
    if (end < original.text.length) { next = { unit: index + 1, unit_offset: end }; break; }
    if (remaining === 0) break;
  }
  if (!result.units.length && unit_offset) throw new Error('unit_offset exceeds empty document length.');
  if (!next && units.length && units.at(-1).unit < result.units.length) next = { unit: units.at(-1).unit + 1, unit_offset: 0 };
  return { format: result.format, units, total_units: result.units.length, next, warnings: result.warnings, metadata: result.metadata,
    truncated: Boolean(result.truncated || result.metadata?.truncated || result.metadata?.output_truncated || result.units.some(item => item.truncated)) };
}

export async function readExtractedSource(root, source, bytes, {
  start_line, offset = 0, max_chars = 12000, page = 1, page_count = 1, page_offset = 0,
  unit = 1, unit_count = 10, unit_offset = 0, view = 'extracted', encoding,
  ocr = 'auto', languages = 'eng+chi_sim',
} = {}) {
  const kind = sourceKind(source.path, bytes);
  const textSelectors = start_line !== undefined || offset !== 0;
  const pageSelectors = page !== 1 || page_count !== 1 || page_offset !== 0;
  const unitSelectors = unit !== 1 || unit_count !== 10 || unit_offset !== 0;
  if (!Number.isInteger(max_chars) || max_chars < 2 || max_chars > 50000) throw new Error('max_chars must be 2 to 50000.');
  for (const [name, value, minimum, maximum] of [['offset',offset,0,Infinity],['page',page,1,Infinity],['page_count',page_count,1,5],['page_offset',page_offset,0,Infinity],['unit',unit,1,Infinity],['unit_count',unit_count,1,100],['unit_offset',unit_offset,0,Infinity]]) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}.`);
  }
  if (start_line !== undefined && (!Number.isInteger(start_line) || start_line < 1)) throw new Error('Invalid start_line.');
  if (!['raw','extracted'].includes(view) || !['auto','off','force'].includes(ocr) || !['eng+chi_sim','eng','chi_sim'].includes(languages)) throw new Error('Invalid view, OCR mode or languages.');
  if (kind === 'unsupported') throw new Error('This file format is stored but not extractable. Supported: text, HTML/XML, PDF, DOCX/XLSX/PPTX/XLS, DOC/PPT with LibreOffice, and PNG/JPEG/WebP/BMP/TIFF. Audio, video and archives are not supported.');
  if (kind === 'text' || (MARKUP.has(kind) && view === 'raw')) {
    if (pageSelectors || unitSelectors || ocr !== 'auto' || languages !== 'eng+chi_sim') throw new Error('Text uses start_line or offset; page/unit/OCR selectors are not applicable.');
    const decoded = decodeText(bytes, { encoding });
    const text = decoded.text;
    if (start_line !== undefined) {
      if (offset !== 0) throw new Error('Use start_line or offset, not both.');
      const parts = text.split('\n');
      if (start_line > parts.length) throw new Error(`start_line exceeds ${parts.length} lines.`);
      offset = parts.slice(0, start_line - 1).reduce((sum, line) => sum + line.length + 1, 0);
    }
    if (offset > text.length) throw new Error('offset exceeds source length.');
    const end = endOfChunk(text, offset, max_chars);
    return { source, format: 'text', view, offset, start_line: text.slice(0, offset).split('\n').length, end_line: text.slice(0, end).split('\n').length,
      text: text.slice(offset, end), total_chars: text.length, next_offset: end < text.length ? end : null,
      encoding: decoded.encoding, encoding_source: decoded.encoding_source, warnings: decoded.warnings, content_is_untrusted: true };
  }
  if (view === 'raw') throw new Error('view:raw is only applicable to text and HTML/XML originals. Binary originals remain stored in raw/.');
  if (kind === 'pdf') {
    if (textSelectors || unitSelectors || encoding !== undefined) throw new Error('PDF uses page/page_count/page_offset; text/unit/encoding selectors are not applicable.');
    const { result, cache } = await cachedExtract(root, bytes, kind, { page, page_count, ocr, languages });
    const pages = []; let remaining = max_chars, next = null;
    for (const original of result.units) {
      const number = original.locator.page, start = number === page ? page_offset : 0;
      if (start > original.text.length) throw new Error('page_offset exceeds extracted page length.');
      const end = endOfChunk(original.text, start, remaining);
      const { text_layer, text, locator, ...metadata } = original;
      pages.push({ ...metadata, page: number, locator, offset: start, text: text.slice(start, end), total_chars: text.length,
        has_extractable_text: text.length > 0,
        ...(text_layer !== undefined ? { text_layer_chars: text_layer.length, text_layer_notice: 'Use ocr:off to paginate the separate embedded text layer.' } : {}) });
      remaining -= end - start;
      if (end < text.length) { next = { page: number, page_offset: end }; break; }
      if (remaining === 0) break;
    }
    if (!next && pages.at(-1).page < result.metadata.page_count) next = { page: pages.at(-1).page + 1, page_offset: 0 };
    return { source, format: pages.some(item => item.method === 'ocr') ? 'pdf_ocr' : 'pdf_text', page_count: result.metadata.page_count,
      pages, next, ocr_available: true, truncated: Boolean(result.truncated || result.metadata?.output_truncated), warnings: result.warnings, metadata: result.metadata, cache, content_is_untrusted: true };
  }
  if (textSelectors || pageSelectors) throw new Error('This format uses unit/unit_count/unit_offset; text/page selectors are not applicable.');
  if (!MARKUP.has(kind) && encoding !== undefined) throw new Error('encoding is only applicable to text and HTML/XML.');
  if (!IMAGES.has(kind) && (ocr !== 'auto' || languages !== 'eng+chi_sim')) throw new Error('OCR selectors are not applicable to Office or markup.');
  if (IMAGES.has(kind) && ocr === 'off') throw new Error('Image extraction requires OCR; ocr:off is not applicable.');
  const options = MARKUP.has(kind) ? { ...(encoding === undefined ? {} : { encoding }) }
    : IMAGES.has(kind) ? { languages } : { filename: path.basename(source.path) };
  const { result, cache } = await cachedExtract(root, bytes, kind, options);
  return { source, ...paginateUnits(result, { unit, unit_count, unit_offset, max_chars }), cache, content_is_untrusted: true };
}
