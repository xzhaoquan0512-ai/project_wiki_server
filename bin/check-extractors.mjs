#!/usr/bin/env node
import { createRequire } from 'node:module';
import { access, open, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);

async function packageInfo(name) {
  let current = path.dirname(require.resolve(name));
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(path.join(current, 'package.json'), 'utf8'));
      if (metadata.name === name) return { version: metadata.version, root: current };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Package metadata was not found for ${name}.`);
    current = parent;
  }
}

async function verifyFile(filename, signature) {
  const info = await stat(filename);
  if (!info.isFile() || info.size < signature.length) throw new Error('Required runtime file is missing or empty.');
  const handle = await open(filename, 'r');
  try {
    const bytes = Buffer.alloc(signature.length);
    await handle.read(bytes, 0, bytes.length, 0);
    if (!bytes.equals(signature)) throw new Error('Required runtime file has an invalid header.');
  } finally { await handle.close(); }
  return info.size;
}

/** Local dependency diagnostics only: no OCR, document conversion, or model downloads. */
export async function checkExtractors({ requireLegacy = false, libreoffice = process.env.PROJECT_WIKI_LIBREOFFICE } = {}) {
  const checks = [];
  const add = async (id, required, inspect) => {
    try { checks.push({ id, required, available: true, ...await inspect() }); }
    catch (error) { checks.push({ id, required, available: false, detail: String(error.message).slice(0, 1000) }); }
  };
  await add('node', true, async () => {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or later is required.');
    return { version: process.versions.node };
  });
  for (const name of ['yauzl', 'saxes', 'xlsx', 'parse5', 'fast-xml-parser', 'iconv-lite', 'pdfjs-dist', 'tesseract.js', 'image-size', 'utif']) {
    await add(name, true, async () => {
      await import(name === 'pdfjs-dist' ? 'pdfjs-dist/legacy/build/pdf.mjs' : name);
      return { version: (await packageInfo(name)).version };
    });
  }
  await add('native_canvas', true, async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(1, 1);
    canvas.getContext('2d').fillRect(0, 0, 1, 1);
    if (!canvas.toBuffer('image/png').length) throw new Error('Native canvas could not encode a 1x1 image.');
    return { version: (await packageInfo('@napi-rs/canvas')).version, detail: 'Native binding loaded and a 1x1 PNG was encoded.' };
  });
  await add('ocr_core', true, async () => {
    const info = await packageInfo('tesseract.js-core');
    for (const stem of ['tesseract-core-lstm', 'tesseract-core-simd-lstm']) {
      await verifyFile(path.join(info.root, `${stem}.wasm`), Buffer.from([0, 97, 115, 109]));
      await access(path.join(info.root, `${stem}.wasm.js`), constants.R_OK);
    }
    return { version: info.version, detail: 'Local baseline and SIMD LSTM WebAssembly files are present.' };
  });
  for (const language of ['eng', 'chi_sim']) {
    await add(`ocr_model_${language}`, true, async () => {
      const info = await packageInfo(`@tesseract.js-data/${language}`);
      const size = await verifyFile(path.join(info.root, '4.0.0_best_int', `${language}.traineddata.gz`), Buffer.from([0x1f, 0x8b]));
      return { version: info.version, bytes: size, detail: 'Bundled local model is present; no CDN download is required at extraction time.' };
    });
  }
  await add('libreoffice', requireLegacy, async () => {
    if (!libreoffice) throw new Error('Optional: set PROJECT_WIKI_LIBREOFFICE to an absolute soffice executable path to enable .doc and .ppt.');
    if (typeof libreoffice !== 'string' || !path.isAbsolute(libreoffice)) throw new Error('PROJECT_WIKI_LIBREOFFICE must be an absolute executable path.');
    const executable = await realpath(libreoffice);
    if (!(await stat(executable)).isFile()) throw new Error('Configured LibreOffice executable is not a file.');
    await access(executable, constants.X_OK);
    const result = await execute(executable, ['--headless', '--version'], { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    const version = `${result.stdout}\n${result.stderr}`.trim();
    if (!/LibreOffice\s+\d/i.test(version)) throw new Error('The configured executable did not identify itself as LibreOffice.');
    return { version: version.slice(0, 200), detail: 'Version check only; Writer/Impress document conversion has not been tested.' };
  });
  const has = (...ids) => ids.every(id => checks.some(check => check.id === id && check.available));
  // Capabilities follow the modules each parser path actually imports, not just the zip/XML container readers.
  const modernOffice = has('yauzl', 'saxes');
  const ocr = has('tesseract.js', 'native_canvas', 'ocr_core', 'ocr_model_eng', 'ocr_model_chi_sim');
  return {
    ready: checks.every(check => !check.required || check.available),
    platform: `${process.platform}/${process.arch}`,
    checks,
    capabilities: {
      text: has('iconv-lite'),
      html_xml: has('parse5', 'fast-xml-parser', 'iconv-lite'),
      docx: modernOffice, xlsx: modernOffice, pptx: modernOffice,
      xls: modernOffice && has('xlsx'),
      doc: modernOffice && has('libreoffice'), ppt: modernOffice && has('libreoffice'),
      pdf_text: has('pdfjs-dist'), pdf_ocr: has('pdfjs-dist') && has('native_canvas') && ocr,
      image_ocr: ocr && has('image-size', 'utif'),
    },
    notes: ['Checks validate local prerequisites, not recognition accuracy or document compatibility.', 'OCR languages: eng, chi_sim, eng+chi_sim. No OCR task, converter task, or network request was run.'],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  if (flags.some(flag => flag !== '--require-legacy')) {
    process.stderr.write('Usage: node bin/check-extractors.mjs [--require-legacy]\n');
    process.exitCode = 2;
  } else {
    const report = await checkExtractors({ requireLegacy: flags.includes('--require-legacy') });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ready ? 0 : 1;
  }
}
