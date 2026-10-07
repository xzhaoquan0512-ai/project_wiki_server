import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkExtractors } from '../bin/check-extractors.mjs';

const execute = promisify(execFile);

test('extractor doctor checks local runtimes without requiring optional LibreOffice', async () => {
  const report = await checkExtractors({ libreoffice: '' });
  assert.equal(report.ready, true);
  // Each capability must rest on the parsers its extraction path actually imports, not only on container readers.
  assert.ok(report.checks.some(check => check.id === 'fast-xml-parser' && check.available), 'xlsx/html paths need fast-xml-parser asserted');
  assert.ok(report.checks.some(check => check.id === 'parse5' && check.available), 'html/xml paths need parse5 asserted');
  assert.equal(report.capabilities.html_xml, true);
  assert.equal(report.capabilities.docx, true);
  assert.equal(report.capabilities.xlsx, true);
  assert.equal(report.capabilities.pptx, true);
  assert.equal(report.capabilities.xls, true);
  assert.equal(report.capabilities.image_ocr, true);
  assert.equal(report.capabilities.pdf_ocr, true);
  assert.equal(report.capabilities.doc, false);
  assert.equal(report.capabilities.ppt, false);
  assert.equal(report.checks.find(check => check.id === 'libreoffice').required, false);
  assert.ok(report.checks.find(check => check.id === 'ocr_model_chi_sim').bytes > 1000);
});

test('extractor doctor reports missing or relative legacy runtime and rejects unrelated executable', async () => {
  for (const libreoffice of ['', 'soffice', process.execPath]) {
    const report = await checkExtractors({ requireLegacy: true, libreoffice });
    assert.equal(report.ready, false);
    const runtime = report.checks.find(check => check.id === 'libreoffice');
    assert.equal(runtime.available, false);
    assert.equal(runtime.required, true);
    assert.match(runtime.detail, /absolute|set PROJECT_WIKI_LIBREOFFICE|Command failed|identify itself/i);
  }
});

test('doctor CLI returns nonzero only when required prerequisite is unavailable', async () => {
  const script = fileURLToPath(new URL('../bin/check-extractors.mjs', import.meta.url));
  const options = { windowsHide: true, env: { ...process.env, PROJECT_WIKI_LIBREOFFICE: '' } };
  const ordinary = await execute(process.execPath, [script], options);
  assert.equal(JSON.parse(ordinary.stdout).ready, true);
  await assert.rejects(execute(process.execPath, [script, '--require-legacy'], options), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).ready, false);
    return true;
  });
  await assert.rejects(execute(process.execPath, [script, '--unknown'], options), error => error.code === 2);
});
