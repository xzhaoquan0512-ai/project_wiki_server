import path from 'node:path';
import { createRequire } from 'node:module';
import { runExtractionWorker, validateImageSize } from './ocr.mjs';

export function renderSource(bytes, options) { return runExtractionWorker('render', bytes, options); }

export async function renderInternal(bytes, { kind, page = 1, max_side = 1600, crop } = {}) {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(max_side) || max_side < 256 || max_side > 4096) throw Error('Invalid render page or size.');
  const c = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  if (![c.x, c.y, c.width, c.height].every(Number.isFinite) || c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0 || c.x + c.width > 1 || c.y + c.height > 1) throw Error('Crop must be a non-empty normalized rectangle inside the page.');
  const { createCanvas, loadImage, ImageData } = await import('@napi-rs/canvas');
  let canvas, document;
  try {
    if (kind === 'pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const assets = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
      document = await getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, maxImageSize: 16_000_000, cMapUrl: assets + '/cmaps/', cMapPacked: true, standardFontDataUrl: assets + '/standard_fonts/' }).promise;
      if (document.numPages > 2000 || page > document.numPages) throw Error('PDF page out of range.');
      const p = await document.getPage(page), base = p.getViewport({ scale: 1 });
      const scale = Math.min(8, max_side / Math.max(base.width * c.width, base.height * c.height));
      const viewport = p.getViewport({ scale });
      canvas = createCanvas(Math.max(1, Math.floor(viewport.width * c.width)), Math.max(1, Math.floor(viewport.height * c.height)));
      await p.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [1, 0, 0, 1, -viewport.width * c.x, -viewport.height * c.y], background: 'white' }).promise;
    } else {
      if (!['png', 'jpeg', 'webp', 'bmp', 'tiff'].includes(kind)) throw Error('Visual reading supports PDF and raster image originals.');
      const { imageSize } = await import('image-size');
      const dimensions = imageSize(bytes); validateImageSize(dimensions.width, dimensions.height);
      let raster;
      if (kind === 'tiff') {
        const UTIF = (await import('utif')).default;
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), frames = UTIF.decode(buffer);
        if (page > frames.length) throw Error('TIFF frame out of range.');
        const frame = frames[page - 1]; validateImageSize(frame.t256?.[0], frame.t257?.[0]);
        UTIF.decodeImage(buffer, frame); validateImageSize(frame.width, frame.height);
        raster = createCanvas(frame.width, frame.height);
        raster.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(UTIF.toRGBA8(frame)), frame.width, frame.height), 0, 0);
      } else { if (page !== 1) throw Error('This image has only one supported frame.'); raster = await loadImage(bytes); }
      const width = raster.width * c.width, height = raster.height * c.height, scale = Math.min(1, max_side / Math.max(width, height));
      canvas = createCanvas(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)));
      canvas.getContext('2d').drawImage(raster, raster.width * c.x, raster.height * c.y, width, height, 0, 0, canvas.width, canvas.height);
    }
    validateImageSize(canvas.width, canvas.height);
    const png = canvas.toBuffer('image/png');
    if (png.length > 8 * 1024 * 1024) throw Error('Rendered image exceeds 8 MiB; request a smaller max_side or crop.');
    return { mimeType: 'image/png', data: png.toString('base64'), width: canvas.width, height: canvas.height, page, crop: c };
  } finally { if (document) await document.destroy(); }
}
