import { MAX_SOURCE_BYTES as MAX_BYTES, MAX_SOURCE_MIB } from '../source-limits.mjs';
import { fork } from 'node:child_process';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
export const IMAGE_MAX_PIXELS = 16_000_000;
export const IMAGE_MAX_SIDE = 16_000;
export const RENDER_MAX_SIDE = 4096;
export const EXTRACTION_MAX_TEXT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const CHILD_FLAG = '--bounded-extraction-worker';

export function extractionTextLimit(value = EXTRACTION_MAX_TEXT_BYTES) {
  if (!Number.isInteger(value) || value < 256 || value > EXTRACTION_MAX_TEXT_BYTES) throw new Error('Extraction output text limit must be 256 bytes to 4 MiB.');
  return value;
}

/** Bound UTF-8 output without splitting Unicode characters or allocating a buffer for an entire huge string. */
export function boundedText(value, maximum) {
  if (maximum <= 0) return { text: '', bytes: 0, truncated: value.length > 0 };
  let prefix = value.slice(0, maximum);
  if (prefix.length < value.length && /[\uD800-\uDBFF]/.test(prefix.at(-1))) prefix = prefix.slice(0, -1);
  const buffer = Buffer.from(prefix, 'utf8');
  let end = Math.min(maximum, buffer.length);
  if (end < buffer.length) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  const text = buffer.subarray(0, end).toString('utf8');
  return { text, bytes: end, truncated: text.length < value.length };
}

export function validateLanguages(languages = 'eng+chi_sim') {
  if (typeof languages !== 'string') throw new Error('OCR languages must be eng, chi_sim or eng+chi_sim.');
  const list = languages.split('+');
  if (!list.length || list.length > 2 || list.some(value => !['eng', 'chi_sim'].includes(value)) || new Set(list).size !== list.length) {
    throw new Error('OCR languages must be eng, chi_sim or eng+chi_sim; only bundled offline language data is permitted.');
  }
  return list;
}

export function validateImageSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE || width * height > IMAGE_MAX_PIXELS) {
    throw new Error('Image exceeds the 16 megapixel / 16000 pixel side limit, or has invalid dimensions.');
  }
}

/** Isolate parsers, native image decoding and OCR WASM so a timeout terminates all work. */
export async function runExtractionWorker(operation, bytes, options = {}) {
  if (!['image', 'pdf'].includes(operation)) throw new Error('Unknown extraction operation.');
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error(`Extraction input must contain 1 byte to ${MAX_SOURCE_MIB} MiB.`);
  const timeout = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  extractionTextLimit(options.max_output_bytes);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 180_000) throw new Error('Extraction timeout must be 1 to 180000 ms.');
  const temporaryParent = await realpath(os.tmpdir());
  const temporary = await mkdtemp(path.join(temporaryParent, 'wiki-extraction-'));
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [CHILD_FLAG], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true,
      // V8 heap cap is complementary to pixel/input/time bounds, not an OS limit on native/WASM memory.
      execArgv: ['--max-old-space-size=384'],
    });
    let settled = false, diagnostic = '';
    // Third-party libraries sometimes log to stdout; it is never forwarded to MCP stdout.
    child.stdout.on('data', () => {});
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleanup = async () => {
        try {
          const resolved = await realpath(temporary);
          if (path.dirname(resolved) !== temporaryParent || !path.basename(resolved).startsWith('wiki-extraction-')) throw new Error('Unsafe extraction temporary cleanup.');
          await rm(resolved, { recursive: true });
          if (error) reject(error); else resolve(result);
        } catch (cleanupError) { reject(error || cleanupError); }
      };
      if (child.exitCode !== null || child.signalCode !== null) void cleanup();
      else { child.once('close', () => { void cleanup(); }); child.kill(); }
    };
    const timer = setTimeout(() => finish(new Error(`Extraction timed out after ${timeout} ms; worker terminated.`)), timeout);
    child.once('error', error => finish(error));
    child.once('exit', (code, signal) => {
      if (!settled) finish(new Error(`Extraction worker exited before returning a result (${signal || code})${diagnostic ? `: ${diagnostic.trim()}` : ''}`));
    });
    child.once('message', message => {
      if (message?.ok) finish(null, message.result);
      else finish(new Error(message?.error || 'Extraction worker failed.'));
    });
    child.send({ operation, bytes: Buffer.from(bytes), options: { ...options, __scratch: temporary } }, error => { if (error) finish(error); });
  });
}

/** Model files are supplied explicitly: Tesseract has no reason to contact a model CDN. */
export async function createOcrSession(languages = 'eng+chi_sim', languagePath) {
  const names = validateLanguages(languages);
  if (!languagePath) throw new Error('OCR must execute inside the managed extraction worker.');
  let worker;
  try {
    await Promise.all(names.map(async code => {
      const root = path.dirname(require.resolve(`@tesseract.js-data/${code}/package.json`));
      await copyFile(path.join(root, '4.0.0_best_int', `${code}.traineddata.gz`), path.join(languagePath, `${code}.traineddata.gz`));
    }));
    const { createWorker } = await import('tesseract.js');
    worker = await createWorker(names.join('+'), 1, {
      langPath: languagePath, cacheMethod: 'none', gzip: true, logger: () => {}, errorHandler: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '150' });
  } catch (error) { if (worker) await worker.terminate(); throw error; }
  return {
    async recognize(bytes) {
      const { data } = await worker.recognize(bytes, {}, { text: true });
      const bounded = boundedText(data.text.trimEnd(), EXTRACTION_MAX_TEXT_BYTES);
      return { text: bounded.text, confidence: data.confidence, ...(bounded.truncated ? { truncated: true } : {}) };
    },
    async close() { await worker.terminate(); },
  };
}

export async function extractImage(bytes, options = {}) {
  validateLanguages(options.languages);
  return runExtractionWorker('image', bytes, options);
}

async function extractImageInternal(bytes, { languages = 'eng+chi_sim', max_output_bytes, __scratch } = {}) {
  const outputLimit = extractionTextLimit(max_output_bytes);
  const { imageSize } = await import('image-size');
  let info;
  try { info = imageSize(bytes); }
  catch { throw new Error('Image header cannot be read; supply a valid PNG, JPEG, WebP, BMP or TIFF.'); }
  if (!['png', 'jpg', 'webp', 'bmp', 'tiff'].includes(info.type)) throw new Error('OCR supports PNG, JPEG, WebP, BMP and TIFF images.');
  validateImageSize(info.width, info.height);
  const { createCanvas, loadImage, ImageData } = await import('@napi-rs/canvas');
  const warnings = ['OCR is machine recognition and may misread text, tables, handwriting and formulas; verify against the original.'];
  let raster, frameCount = 1;
  if (info.type === 'tiff') {
    const UTIF = (await import('utif')).default;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const frames = UTIF.decode(buffer);
    if (!frames.length) throw new Error('TIFF contains no readable image frame.');
    frameCount = frames.length;
    const frame = frames[0];
    validateImageSize(frame.t256?.[0], frame.t257?.[0]);
    UTIF.decodeImage(buffer, frame);
    validateImageSize(frame.width, frame.height);
    raster = createCanvas(frame.width, frame.height);
    raster.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(UTIF.toRGBA8(frame)), frame.width, frame.height), 0, 0);
    if (frameCount > 1) warnings.push(`TIFF has ${frameCount} frames; this extraction reads the first frame only.`);
  } else {
    const image = await loadImage(bytes);
    validateImageSize(image.width, image.height);
    raster = createCanvas(image.width, image.height);
    const context = raster.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, image.width, image.height);
    context.drawImage(image, 0, 0);
  }
  const scale = Math.min(1, RENDER_MAX_SIDE / Math.max(raster.width, raster.height));
  if (scale < 1) {
    const smaller = createCanvas(Math.max(1, Math.floor(raster.width * scale)), Math.max(1, Math.floor(raster.height * scale)));
    smaller.getContext('2d').drawImage(raster, 0, 0, smaller.width, smaller.height);
    raster.width = 1; raster.height = 1;
    raster = smaller;
    warnings.push('Image downsampled to a maximum side of 4096 pixels for bounded OCR.');
  }
  const session = await createOcrSession(languages, __scratch);
  try {
    const recognized = await session.recognize(raster.toBuffer('image/png'));
    const bounded = boundedText(recognized.text, outputLimit);
    recognized.text = bounded.text;
    if (bounded.truncated || recognized.truncated) {
      recognized.truncated = true;
      warnings.push(`OCR text was truncated to the ${outputLimit} byte extraction output limit; the original is unchanged.`);
    }
    if (!recognized.text.trim()) warnings.push('OCR found no text; this does not mean the image has no content.');
    return {
      format: 'image_ocr', units: [{ locator: { kind: 'image', frame: 1 }, ...recognized, method: 'ocr', warnings }], warnings,
      metadata: { width: info.width, height: info.height, frame_count: frameCount, image_type: info.type, languages, offline: true, output_limit_bytes: outputLimit },
    };
  } finally { await session.close(); }
}

if (process.argv[2] === CHILD_FLAG && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.once('message', async ({ operation, bytes, options }) => {
    try {
      const result = operation === 'image' ? await extractImageInternal(bytes, options)
        : await (await import('./pdf.mjs')).extractPdfInternal(bytes, options);
      process.send({ ok: true, result }, () => process.exit(0));
    } catch (error) { process.send({ ok: false, error: String(error.message || error).slice(0, 4000) }, () => process.exit(1)); }
  });
}
