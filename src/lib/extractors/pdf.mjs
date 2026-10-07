import path from 'node:path';
import { createRequire } from 'node:module';
import { createOcrSession, runExtractionWorker, validateLanguages, RENDER_MAX_SIDE, IMAGE_MAX_PIXELS, boundedText, extractionTextLimit } from './ocr.mjs';

const require = createRequire(import.meta.url);
const PDF_MAX_PAGES = 2000;
const REQUEST_MAX_PAGES = 10;

async function readTextLayer(pdfPage, maximum) {
  const reader = pdfPage.streamTextContent().getReader();
  const pieces = [];
  let remaining = maximum, truncated = false, finished = false;
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) { finished = true; break; }
      for (const item of value.items) {
        if (typeof item.str !== 'string') continue;
        for (const part of [item.str, item.hasEOL ? '\n' : ' ']) {
          const bounded = boundedText(part, remaining);
          pieces.push(bounded.text); remaining -= bounded.bytes;
          if (bounded.truncated || remaining === 0) { truncated = true; break; }
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
  } finally {
    if (!finished) await reader.cancel(new Error('Bounded PDF extraction reached its text output limit.'));
    reader.releaseLock();
  }
  const text = pieces.join('').trimEnd();
  return { text, bytes: Buffer.byteLength(text, 'utf8'), truncated };
}

function validateOptions({ ocr = 'auto', languages = 'eng+chi_sim', page = 1, page_count = 1 } = {}) {
  if (!['auto', 'off', 'force'].includes(ocr)) throw new Error('ocr must be auto, off or force.');
  validateLanguages(languages);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(page_count) || page_count < 1 || page_count > REQUEST_MAX_PAGES) throw new Error('PDF page must be positive and page_count must be 1 to 10.');
}

export async function extractPdf(bytes, options = {}) {
  validateOptions(options);
  return runExtractionWorker('pdf', bytes, options);
}

/** Only called in the isolated extraction process; no network URLs or executable PDF actions are loaded. */
export async function extractPdfInternal(bytes, { ocr = 'auto', languages = 'eng+chi_sim', page = 1, page_count = 1, max_output_bytes, __scratch } = {}) {
  validateOptions({ ocr, languages, page, page_count });
  const outputLimit = extractionTextLimit(max_output_bytes);
  let remainingBytes = outputLimit, outputTruncated = false;
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const assetRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const loading = getDocument({
    data: Uint8Array.from(bytes), disableFontFace: true, isEvalSupported: false,
    useSystemFonts: false, verbosity: 0, stopAtErrors: true,
    cMapUrl: path.join(assetRoot, 'cmaps') + path.sep, cMapPacked: true,
    standardFontDataUrl: path.join(assetRoot, 'standard_fonts') + path.sep,
    maxImageSize: IMAGE_MAX_PIXELS, canvasMaxAreaInBytes: IMAGE_MAX_PIXELS * 4,
  });
  let document, ocrSession;
  const warnings = ['PDF extraction may omit diagrams, table structure, formulas and page layout; verify cited evidence against the original.'];
  try {
    document = await loading.promise;
    if (document.numPages > PDF_MAX_PAGES) throw new Error(`PDF exceeds the ${PDF_MAX_PAGES} page limit.`);
    if (page > document.numPages) throw new Error(`page exceeds the PDF's ${document.numPages} pages.`);
    const units = [];
    const lastPage = Math.min(document.numPages, page + page_count - 1);
    for (let number = page; number <= lastPage; number++) {
      if (remainingBytes === 0) { outputTruncated = true; warnings.push('Additional selected pages were omitted because the extraction output text limit was reached.'); break; }
      const pdfPage = await document.getPage(number);
      try {
        // Reserve room for OCR output when the caller explicitly requests both evidence forms.
        const layer = await readTextLayer(pdfPage, ocr === 'force' ? Math.floor(remainingBytes / 2) : remainingBytes);
        const textLayer = layer.text;
        const visibleCharacters = textLayer.replace(/\s/g, '').length;
        const useOcr = ocr === 'force' || (ocr === 'auto' && visibleCharacters < 20);
        const unit = { locator: { kind: 'page', page: number }, method: 'text_layer', text: textLayer, warnings: [] };
        if (layer.truncated) {
          unit.truncated = true; outputTruncated = true;
          unit.warnings.push(`Embedded text was truncated by the ${outputLimit} byte extraction output limit; the original is unchanged.`);
        }
        if (useOcr) {
          const basic = pdfPage.getViewport({ scale: 1 });
          if (!Number.isFinite(basic.width) || !Number.isFinite(basic.height) || basic.width <= 0 || basic.height <= 0) throw new Error(`PDF page ${number} has invalid dimensions.`);
          const scale = Math.min(2, RENDER_MAX_SIDE / Math.max(basic.width, basic.height), Math.sqrt(IMAGE_MAX_PIXELS / (basic.width * basic.height)));
          const viewport = pdfPage.getViewport({ scale });
          const width = Math.max(1, Math.floor(viewport.width)), height = Math.max(1, Math.floor(viewport.height));
          const canvas = createCanvas(width, height);
          const context = canvas.getContext('2d');
          await pdfPage.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise;
          ocrSession ??= await createOcrSession(languages, __scratch);
          const recognized = await ocrSession.recognize(canvas.toBuffer('image/png'));
          canvas.width = 1; canvas.height = 1;
          unit.text_layer = textLayer;
          const bounded = boundedText(recognized.text, remainingBytes - layer.bytes);
          unit.text = bounded.text;
          if (bounded.truncated || recognized.truncated) {
            unit.truncated = true; outputTruncated = true;
            unit.warnings.push(`OCR text was truncated by the ${outputLimit} byte extraction output limit; the original is unchanged.`);
          }
          remainingBytes -= layer.bytes + bounded.bytes;
          unit.method = 'ocr';
          unit.confidence = recognized.confidence;
          unit.warnings.push('OCR result is machine recognition; the separate text_layer field preserves embedded text without blending evidence.');
          if (!recognized.text.trim()) unit.warnings.push('OCR found no text; this does not mean the page has no content.');
          if (scale < 2) unit.warnings.push('Page render was reduced to remain within 4096 pixels per side and 16 megapixels.');
        } else if (ocr === 'off' && visibleCharacters < 20) {
          unit.warnings.push('OCR is disabled; a sparse or empty text layer may omit scanned content.');
        }
        if (!useOcr) remainingBytes -= layer.bytes;
        units.push(unit);
      } finally { pdfPage.cleanup(); }
    }
    return { format: 'pdf', units, warnings, metadata: { page_count: document.numPages, ocr, languages, offline: true, auto_ocr_text_threshold: 20, output_limit_bytes: outputLimit, output_truncated: outputTruncated } };
  } finally {
    if (ocrSession) await ocrSession.close();
    if (document) await document.destroy(); else await loading.destroy();
  }
}
